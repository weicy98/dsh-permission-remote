import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { ESCALATION_TARGETS } from '@deepseek-ai/dsh-sandbox'
import { ToolArgsError, parameterSchemaSpecToJsonSchema, validateArgs, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials/types'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { fetchRgBinary, rgPlatformOf } from './rg-fetch.ts'
import { Config, connectionKeyChanged, normalizeOpsPolicy, readConfig, type HostConfig, type PluginConfig } from './config.ts'
import {
  buildResolveMode,
  installBubblewrap,
  cacheRgBinary,
  remoteFacts,
  probeHost,
  runBash,
  runEdit,
  runGlob,
  runGrep,
  runWorkingDirectory,
  runRead,
  runReadImage,
  runWrite,
  type RunnerStatus,
  type ToolExec,
  type ToolHost,
} from './execute.ts'
import { sniffImage } from './image.ts'
import { opsHostView, renderOpsExec, renderOpsRead, resolveOpsHost, runSshExec, runSshRead, runSshWrite, forgetOpsHost } from './ops.ts'
import { isValidHostId, mapRemoteToLocal, routeByCwd } from './router.ts'
import { dispatchShadow, planShadows, type RoutedToolName } from './shadow.ts'
import { parseShellProbe, shellProbeCommand, installSidebarBridge, type SidebarShell } from './sidebar-terminal.ts'
import { SshPool, type SecretMaterial } from './ssh-pool.ts'
import {
  createdWorkspaceTitle,
  hostTag,
  remoteWorkspaces,
  tagRemoteWorkspaces,
  textOrUndefined,
  type DeletedHostView,
  type RemoteWorkspaceView,
  type WorkspaceRegistryLike,
} from './workspaces.ts'

export const name = 'dsh-permission-remote'
export const inject = ['sandboxPolicy', 'tools', 'settings', 'credentials', 'workspaceRegistry']
export { Config }

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

interface HostContext {
  sandboxPolicy: Parameters<typeof buildResolveMode>[0]['sandboxPolicy']
  tools: {
    get(toolName: string, scope?: object): { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    register(definition: object): () => void
  }
  settings: {
    configure(presentation: { auto?: boolean }): () => void
    describe(): Array<{ ns: string }>
    update(ns: string, patch: object): Promise<void>
  }
  credentials: {
    readRecord(key: ReturnType<typeof credentialKey>): Promise<CredentialRecord | undefined>
    modifyRecord(key: ReturnType<typeof credentialKey>, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined>
  }
  workspaceRegistry: WorkspaceRegistryLike
  get(service: string): unknown
  on(event: 'agent/created', listener: (payload: { agent: AgentLike }) => void): () => void
  effect(dispose: () => void): void
  logger?: { info(message: string): void, warn(message: string): void }
}

interface AgentLike {
  ctx: HostContext & { tools: HostContext['tools'] }
  session?: { header?: { cwd?: string }, id?: string }
}

interface GrantPayload {
  password?: string
  passphrase?: string
}

class SshApi extends TypertRemoteService {
  constructor(ctx: Context, private readonly core: Core) {
    super(ctx, 'sshPermission')
    markRemote(this)
  }

  async testConnection(input: { hostId: string }): Promise<{ fingerprint: string, trusted: boolean, banner: string }> {
    const host = this.core.requireHost(input.hostId)
    return this.core.pool.offerFingerprint(host, await this.core.secret(host))
  }

  async trustFingerprint(input: { hostId: string, fingerprint: string }): Promise<{ ok: true }> {
    await this.core.trust(input.hostId, input.fingerprint)
    return { ok: true }
  }

  async probe(input: { hostId: string, refresh?: boolean }): Promise<RunnerStatus> {
    return this.core.probe(input.hostId, input.refresh === true)
  }

  /**
   * Install bubblewrap on the remote. `ok` is the command's own exit status;
   * `sandbox.available` is the re-probe, which is what actually matters after
   * an install that reported success.
   */
  async installDeps(input: { hostId: string }): Promise<{ ok: boolean, code: number | null, stdout: string, stderr: string, status: RunnerStatus }> {
    const host = this.core.requireHost(input.hostId)
    const status = await this.core.probe(input.hostId)
    const result = await installBubblewrap(this.core.pool, host, await this.core.secret(host), status)
    // Drop the cached probe only. `forgetStatus` would also close the pooled
    // session and cancel whatever the agent is running on the remote.
    this.core.forgetProbe(input.hostId)
    const next = await this.core.probe(input.hostId)
    return { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr, status: next }
  }

  /**
   * Fetch a ripgrep binary for the remote platform and cache it here, so the
   * upload path works on a machine whose package manager only installed its own
   * platform package. Explicit: nothing downloads until this is called.
   */
  async installRipgrep(input: { hostId: string }): Promise<{ ok: true, platform: string, version: string, status: RunnerStatus }> {
    const result = await this.core.installRipgrep(input.hostId)
    return { ok: true, ...result }
  }

  async listDir(input: { hostId: string, path: string }): Promise<{ path: string, entries: Array<{ name: string, path: string }> }> {
    const host = this.core.requireHost(input.hostId)
    const entries = await this.core.pool.sftpList(host, await this.core.secret(host), input.path || '/')
    return { path: input.path || '/', entries }
  }

  async createWorkspace(input: { hostId: string, path: string, title?: string }): Promise<{ path: string, title: string }> {
    const host = this.core.requireHost(input.hostId)
    const info = await this.core.pool.sftpStat(host, await this.core.secret(host), input.path)
    if (!info.isDirectory) throw new Error(`remote path is not a directory: ${input.path}`)
    const local = mapRemoteToLocal(input.hostId, input.path)
    if (local === null) throw new Error('remote path must be absolute')
    await mkdir(local, { recursive: true })
    const requested = input.title?.trim() || basename(input.path)
    const title = createdWorkspaceTitle(host, requested, this.core.taggingEnabled)
    const workspace = await this.core.workspaces.create(local, title)
    // `create` keeps an existing record's title; only a new row carries ours.
    return { path: local, title: workspace.title }
  }

  async listWorkspaces(): Promise<{ items: RemoteWorkspaceView[], deleted: DeletedHostView[] }> {
    return { items: this.core.listWorkspaces(), deleted: this.core.listDeletedHosts() }
  }

  async tagWorkspaces(input: { hostId?: string, workspaceId?: string }): Promise<{ items: RemoteWorkspaceView[], deleted: DeletedHostView[], changed: number }> {
    const changed = await this.core.tagWorkspaces(textOrUndefined(input.hostId), textOrUndefined(input.workspaceId))
    return { items: this.core.listWorkspaces(), deleted: this.core.listDeletedHosts(), changed }
  }

  async removeWorkspace(input: { hostId: string, workspaceId: string }): Promise<{ ok: boolean }> {
    return { ok: await this.core.removeWorkspace(input.hostId, input.workspaceId) }
  }

  /** Forget a deleted host completely, unregistering its workspaces. */
  async purgeHost(input: { hostId: string }): Promise<{ ok: true, workspaces: number }> {
    const result = await this.core.purgeHost(input.hostId)
    return { ok: true, workspaces: result.workspaces }
  }

  async restoreHost(input: { hostId: string }): Promise<{ ok: true }> {
    await this.core.restoreHost(input.hostId)
    return { ok: true }
  }

  async saveHost(input: HostConfig): Promise<{ ok: true }> {
    await this.core.saveHost(input)
    return { ok: true }
  }

  async deleteHost(input: { hostId: string }): Promise<{ ok: true }> {
    await this.core.deleteHost(input.hostId)
    return { ok: true }
  }

  async saveSecret(input: { hostId: string, password?: string, passphrase?: string }): Promise<{ ok: true }> {
    await this.core.saveSecret(input.hostId, { password: input.password, passphrase: input.passphrase })
    return { ok: true }
  }
}

export class Core {
  readonly pool: SshPool
  private config: PluginConfig
  private readonly status = new Map<string, Promise<RunnerStatus>>()
  private readonly shellLists = new Map<string, Promise<SidebarShell[]>>()

  constructor(
    private readonly ctx: HostContext,
    config: PluginConfig,
    readonly workspaces: WorkspaceRegistryLike,
  ) {
    this.config = config
    this.pool = new SshPool(config.maxConnections)
  }

  listWorkspaces(): RemoteWorkspaceView[] {
    return remoteWorkspaces(this.workspaces.list())
  }

  /** Whether workspace titles carry the server name. */
  get taggingEnabled(): boolean {
    return this.config.tagWorkspaceTitles
  }

  /** Hosts the operator removed, newest first. */
  listDeletedHosts(): DeletedHostView[] {
    return this.config.deletedHosts.map(row => ({
      id: row.host.id,
      name: row.host.name.trim() || row.host.host,
      address: row.host.host,
      username: row.host.username,
      port: row.host.port,
      deletedAt: row.deletedAt,
    }))
  }

  async restoreHost(hostId: string): Promise<void> {
    assertHostId(hostId)
    if (this.config.hosts.some(item => item.id === hostId)) throw new Error(`SSH host ${hostId} is already configured`)
    const row = this.config.deletedHosts.find(item => item.host.id === hostId)
    if (row === undefined) throw new Error(`SSH host ${hostId} cannot be restored; add it again`)
    this.config.hosts = [...this.config.hosts, { ...row.host }]
    this.config.deletedHosts = this.config.deletedHosts.filter(item => item.host.id !== hostId)
    this.pool.invalidate(hostId)
    this.status.delete(hostId)
    forgetOpsHost(hostId)
    await this.persistHosts()
  }

  /**
   * Drop the tombstone and unregister every workspace left under that host.
   *
   * The workspaces must go too: they resolve through a host id that would no
   * longer exist anywhere, so they could never be opened or deleted again.
   * Remote files are not touched.
   */
  async purgeHost(hostId: string): Promise<{ workspaces: number }> {
    assertHostId(hostId)
    if (this.config.hosts.some(item => item.id === hostId)) {
      throw new Error(`SSH host ${hostId} is still configured; remove it from the list first`)
    }
    const tombstone = this.config.deletedHosts.some(item => item.host.id === hostId)
    const owned = this.listWorkspaces().filter(item => item.hostId === hostId)
    if (!tombstone && owned.length === 0) {
      throw new Error(`SSH host ${hostId} is not in the deleted list`)
    }
    let removed = 0
    for (const workspace of owned) {
      if (await this.workspaces.delete(workspace.workspaceId)) removed += 1
    }
    if (tombstone) {
      this.config.deletedHosts = this.config.deletedHosts.filter(item => item.host.id !== hostId)
      await this.persistHosts()
    }
    this.pool.invalidate(hostId)
    this.status.delete(hostId)
    forgetOpsHost(hostId)
    return { workspaces: removed }
  }

  /**
   * Remove one workspace registration. Unknown ids and ids that belong to a
   * different host fail instead of reporting a success that did nothing.
   */
  async removeWorkspace(hostId: string, workspaceId: string): Promise<boolean> {
    const row = this.listWorkspaces().find(item => item.workspaceId === workspaceId)
    if (row === undefined) return false
    if (row.hostId !== hostId) throw new Error(`workspace ${workspaceId} does not belong to SSH host ${hostId}`)
    return this.workspaces.delete(workspaceId)
  }

  async tagWorkspaces(hostId?: string, workspaceId?: string, previousTag?: string): Promise<number> {
    // A deleted host's prefix must still be recognised so manual tagging
    // replaces it instead of stacking a second one.
    const known = [...this.config.hosts, ...this.config.deletedHosts.map(row => row.host)]
    return tagRemoteWorkspaces(this.config.hosts, this.workspaces.list(), { hostId, workspaceId, previousTag, knownHosts: known })
  }

  /**
   * On every load, prefix a title that is empty or still exactly the remote
   * directory's name. A title the operator changed stays. A title set back to
   * that directory name is prefixed again, because it is indistinguishable
   * from a workspace that was never tagged.
   */
  async autoTagWorkspaces(): Promise<void> {
    if (!this.config.tagWorkspaceTitles) return
    const changed = await this.tagWorkspaces()
    if (changed > 0) this.ctx.logger?.info(`[@dsh-permission-remote] tagged ${changed} workspace title(s) with their SSH host`)
  }

  requireHost(hostId: string): HostConfig {
    const host = this.config.hosts.find(item => item.id === hostId)
    if (host === undefined) throw new Error(`unknown SSH host ${hostId}`)
    return host
  }

  /** Ops tools let the model name a host by id, name, or address. */
  requireOpsHost(selector: string): HostConfig {
    return resolveOpsHost(this.config.hosts, selector)
  }

  listHosts(): HostConfig[] {
    return this.config.hosts
  }

  async trust(hostId: string, fingerprint: string): Promise<void> {
    this.requireHost(hostId)
    this.config.hosts = this.config.hosts.map(item => item.id === hostId ? { ...item, fingerprint } : item)
    this.pool.invalidate(hostId)
    this.status.delete(hostId)
    forgetOpsHost(hostId)
    await this.persistHosts()
  }

  /**
   * Drop everything derived from a connection that no longer applies: the
   * cached probe, the pooled session, the cached remote home, and the sidebar
   * shell list. Connecting is interrupted, so an agent command running on that
   * session is killed.
   */
  forgetStatus(hostId: string): void {
    this.status.delete(hostId)
    this.pool.invalidate(hostId)
    forgetOpsHost(hostId)
    this.forgetShells(hostId)
  }

  /** Drop the sidebar shell menu for one host. The label includes the server name. */
  forgetShells(hostId: string): void {
    this.shellLists.delete(hostId)
  }

  /** Seed the sidebar shell list without dialing. Diagnostics and tests only. */
  primeShells(hostId: string, shells: SidebarShell[]): void {
    this.shellLists.set(hostId, Promise.resolve(shells))
  }

  /** Whether a sidebar shell list is cached. Diagnostics and tests only. */
  hasShells(hostId: string): boolean {
    return this.shellLists.has(hostId)
  }

  loadShells(hostId: string, candidates: readonly string[]): Promise<SidebarShell[]> {
    const cached = this.shellLists.get(hostId)
    if (cached !== undefined) return cached
    const pending = (async () => {
      const host = this.requireHost(hostId)
      const result = await this.pool.exec(host, await this.secret(host), shellProbeCommand(candidates), 20_000)
      const shells = parseShellProbe(result.stdout, hostTag(host))
      if (shells.length === 0) throw new Error(`no interactive shell found on ${hostTag(host)}`)
      return shells
    })()
    this.shellLists.set(hostId, pending)
    pending.catch(() => {
      if (this.shellLists.get(hostId) === pending) this.shellLists.delete(hostId)
    })
    return pending
  }

  /**
   * Forget only the cached probe result. Used after a change on the remote that
   * leaves the session valid (a package install, a new uploaded binary), so a
   * running command is not cancelled just to refresh a status line.
   */
  forgetProbe(hostId: string): void {
    this.status.delete(hostId)
  }

  async secret(host: HostConfig): Promise<SecretMaterial> {
    const record = await this.ctx.credentials.readRecord(credentialKey('dsh-permission-remote', host.id))
    if (record === undefined || record.kind !== 'grant' || !isPayload(record.payload)) return {}
    return { password: record.payload.password, passphrase: record.payload.passphrase }
  }

  async saveSecret(hostId: string, material: SecretMaterial): Promise<void> {
    assertHostId(hostId)
    this.requireHost(hostId)
    const key = credentialKey('dsh-permission-remote', hostId)
    await this.ctx.credentials.modifyRecord(key, async current => {
      const previous = current?.kind === 'grant' && isPayload(current.payload) ? current.payload : {}
      return { kind: 'grant', payload: grantPayload(material, previous) }
    })
    // The live session authenticated with the previous credential.
    this.forgetStatus(hostId)
  }

  async saveHost(host: HostConfig): Promise<void> {
    assertHostId(host.id)
    const previous = this.config.hosts.find(item => item.id === host.id)
    const normalized = { ...host, opsPolicy: normalizeOpsPolicy((host as { opsPolicy?: unknown }).opsPolicy) }
    this.config.hosts = previous === undefined
      ? [...this.config.hosts, normalized]
      : this.config.hosts.map(item => item.id === host.id ? normalized : item)
    // A cached session keyed by id would keep talking to the previous machine.
    if (previous !== undefined && connectionKeyChanged(previous, normalized)) this.forgetStatus(host.id)
    else forgetOpsHost(host.id)
    // A rename keeps the connection. The shell menu still caches `host · zsh`.
    this.forgetShells(normalized.id)
    await this.persistHosts()
    // The sidebar prefix follows the server name, or the address when unnamed.
    if (previous === undefined) return
    const previousTag = hostTag(previous)
    const nextTag = hostTag(normalized)
    if (previousTag === nextTag) return
    if (!this.config.tagWorkspaceTitles) return
    await this.tagWorkspaces(normalized.id, undefined, previousTag)
  }

  async deleteHost(hostId: string): Promise<void> {
    const removed = this.config.hosts.find(item => item.id === hostId)
    if (removed !== undefined) {
      // Keep the row so the settings page can restore it; its workspaces stay.
      // Hosts that still have workspaces are not dropped to make room for the
      // newest 20 deletes that have none.
      const rows = [
        { host: removed, deletedAt: new Date().toISOString() },
        ...this.config.deletedHosts.filter(item => item.host.id !== hostId),
      ]
      const withWorkspaces = new Set(this.listWorkspaces().map(item => item.hostId))
      let spare = 0
      this.config.deletedHosts = rows.filter(row => {
        if (withWorkspaces.has(row.host.id)) return true
        spare += 1
        return spare <= 20
      })
    }
    this.config.hosts = this.config.hosts.filter(item => item.id !== hostId)
    this.pool.invalidate(hostId)
    this.status.delete(hostId)
    forgetOpsHost(hostId)
    this.forgetShells(hostId)
    await this.persistHosts()
  }

  private async persistHosts(): Promise<void> {
    const row = this.ctx.settings.describe().find(item => String(item.ns) === 'permission-remote')
    if (row === undefined) {
      this.ctx.logger?.warn('[@dsh-permission-remote] settings row "permission-remote" is missing; the host list changed in memory but was not persisted')
      return
    }
    await this.ctx.settings.update(String(row.ns), {
      hosts: this.config.hosts,
      deletedHosts: this.config.deletedHosts,
    })
  }

  /** Fetch and cache the ripgrep binary for this host's remote platform. */
  async installRipgrep(hostId: string): Promise<{ platform: string, version: string, status: RunnerStatus }> {
    const host = this.requireHost(hostId)
    const facts = await remoteFacts(this.pool, host, await this.secret(host))
    const platform = rgPlatformOf(facts.os, facts.arch)
    if (platform === null) {
      throw new Error(`no ripgrep build for ${facts.os}/${facts.arch}; install ripgrep on the remote so rg is on PATH`)
    }
    // The upload needs an absolute home to place the binary under. Without one
    // the probe never tries, so downloading would only fail a second time.
    if (facts.home.length === 0) {
      throw new Error('the remote did not report an absolute $HOME, so rg cannot be placed there; install ripgrep on the remote so rg is on PATH')
    }
    const fetched = await fetchRgBinary({ registry: this.config.rgRegistry, platform })
    await cacheRgBinary(platform, fetched.binary)
    // Only the cached probe result is stale; `forgetStatus` would also drop the
    // pooled SSH session and kill any command running on it.
    this.forgetProbe(hostId)
    const next = await this.probe(hostId)
    return { platform, version: fetched.version, status: next }
  }

  probe(hostId: string, refresh = false): Promise<RunnerStatus> {
    if (refresh) this.status.delete(hostId)
    const cached = this.status.get(hostId)
    if (cached !== undefined) return cached
    const pending = (async () => {
      const host = this.requireHost(hostId)
      return probeHost(this.pool, host, await this.secret(host))
    })()
    this.status.set(hostId, pending)
    pending.catch(() => {
      if (this.status.get(hostId) === pending) this.status.delete(hostId)
    })
    return pending
  }

  toolHost(jobs: ToolHost['jobs']): ToolHost {
    return {
      pool: this.pool,
      hostOf: id => this.config.hosts.find(item => item.id === id),
      secretOf: host => this.secret(host),
      statusOf: host => this.probe(host.id),
      resolveMode: buildResolveMode(this.ctx),
      jobs,
    }
  }
}

function assertHostId(hostId: string): void {
  if (!isValidHostId(hostId)) throw new Error('host id must be a lowercase credential key: it starts with a letter and contains only letters, digits, and hyphens')
}

function isPayload(value: unknown): value is GrantPayload {
  return typeof value === 'object' && value !== null
}

/**
 * Leave an unset secret off the object. `credentials-local` walks every own
 * value and rejects `undefined`, which JSON cannot represent.
 */
function grantPayload(material: SecretMaterial, previous: GrantPayload): GrantPayload {
  const password = material.password !== undefined ? material.password : previous.password
  const passphrase = material.passphrase !== undefined ? material.passphrase : previous.passphrase
  const payload: GrantPayload = {}
  if (typeof password === 'string') payload.password = password
  if (typeof passphrase === 'string') payload.passphrase = passphrase
  return payload
}

function markRemote(service: SshApi): void {
  const methods = ['testConnection', 'trustFingerprint', 'probe', 'installDeps', 'installRipgrep', 'listDir', 'createWorkspace', 'listWorkspaces', 'tagWorkspaces', 'removeWorkspace', 'restoreHost', 'purgeHost', 'saveSecret', 'saveHost', 'deleteHost']
  Object.defineProperty(Object.getPrototypeOf(service), REMOTE_METHODS, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map(method => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  })
}

const RUNNERS: Record<RoutedToolName, (host: ToolHost, route: NonNullable<ReturnType<typeof routeByCwd> & { kind: 'remote' }>, args: Record<string, unknown>, exec: ToolExec, ctx: HostContext) => Promise<unknown>> = {
  bash: (host, route, args, exec) => runBash(host, route, args, exec),
  read: (host, route, args, exec) => runRead(host, route, args, exec),
  write: (host, route, args, exec) => runWrite(host, route, args, exec),
  edit: (host, route, args, exec) => runEdit(host, route, args, exec),
  read_image: (host, route, args, exec, ctx) => runReadImage(host, route, args, async (data, fileName) => {
    const attachments = ctx.get('attachments') as { saveImage(input: { data: Buffer, mediaType: string, name: string }): Promise<Record<string, unknown>> } | undefined
    if (attachments === undefined) throw new Error('no attachment service is mounted')
    const mediaType = sniffImage(data)
    if (mediaType === undefined) throw new Error(`cannot read "${fileName}": the file content is not a PNG, JPEG, WebP, or GIF`)
    return attachments.saveImage({ data, mediaType, name: fileName })
  }, exec),
  glob: (host, route, args, exec) => runGlob(host, route, args, exec),
  grep: (host, route, args, exec) => runGrep(host, route, args, exec),
  working_directory: (host, route, args, exec, ctx) => runWorkingDirectory(host, route, args, exec, async directory => {
    const directories = ctx.get('workingDirectory') as { set(agent: object, path: string, signal?: AbortSignal): Promise<string> } | undefined
    if (directories === undefined || exec.agent === undefined) throw new Error('working_directory requires an agent Session')
    return directories.set(exec.agent, directory, exec.signal)
  }),
}

export function apply(rawCtx: Context, rawConfig?: unknown): void {
  const ctx = rawCtx as unknown as HostContext
  const core = new Core(ctx, readConfig(rawConfig), ctx.workspaceRegistry)
  const api = new SshApi(rawCtx, core)
  const unregisters = new Set<() => void>()
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  ctx.effect(() => () => {
    for (const unregister of unregisters) unregister()
    unregisters.clear()
    void core.pool.dispose()
  })
  rawCtx.inject(['terminalController', 'subprocess', 'workingDirectory'], bridged => {
    const remove = installSidebarBridge(bridged, core)
    if (remove === undefined) return
    unregisters.add(remove)
    bridged.effect(() => () => {
      remove()
      unregisters.delete(remove)
    })
  })
  void api

  const seen = new Set<AgentLike>()
  const attach = (agent: AgentLike) => {
    if (seen.has(agent)) return
    seen.add(agent)
    let installed = false
    try {
      installed = installShadows(ctx, core, agent, unregisters, () => { seen.delete(agent) })
    } finally {
      if (!installed) seen.delete(agent)
    }
  }
  ctx.on('agent/created', ({ agent }) => attach(agent))
  const agents = ctx.get('agents') as { list?: () => AgentLike[] } | undefined
  if (typeof agents?.list === 'function') {
    for (const agent of agents.list()) attach(agent)
  }
  void core.autoTagWorkspaces().catch(error => {
    ctx.logger?.warn(`[@dsh-permission-remote] workspace title tagging failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  ctx.logger?.info('[@dsh-permission-remote] loaded')
}

function installShadows(ctx: HostContext, core: Core, agent: AgentLike, unregisters: Set<() => void>, forget: () => void): boolean {
  const cwd = agent.session?.header?.cwd
  const initial = routeByCwd(cwd)
  const disposers: Array<() => void> = []
  try {
    const plans = planShadows(name => agent.ctx.tools.get(name, agent))
    const host = core.toolHost(agent.ctx.get('jobs') as ToolHost['jobs'])
    for (const plan of plans) {
      if (plan.official === undefined && !(plan.name === 'bash' && initial.kind === 'remote')) continue
      const official = plan.official
      const runner = RUNNERS[plan.name]
      disposers.push(agent.ctx.tools.register(withRemoteTimeout({
        ...capturedSchema(agent.ctx, plan.name, agent),
        name: plan.name,
        async execute(args: unknown, exec: ToolExec) {
          const current = routeByCwd(effectiveCwd(ctx, exec, cwd))
          if (current.kind !== 'remote') {
            return dispatchShadow(official as ((value: unknown, execution: ToolExec) => Promise<unknown>) | undefined, false, async () => {
              throw new Error('dsh-permission-remote: local call has no official tool')
            }, args, exec)
          }
          return runner(host, current, args as Record<string, unknown>, exec, ctx)
        },
      })))
    }
  } catch (error) {
    for (const unregister of disposers) unregister()
    ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed for agent ${agentLabel(agent)}: ${error instanceof Error ? error.message : String(error)}`)
    if (initial.kind === 'remote') throw error
    return false
  }
  try {
    for (const tool of opsTools(core)) disposers.push(agent.ctx.tools.register(tool))
  } catch (error) {
    // A missing ops tool must not take the remote workspace shadows down with it.
    ctx.logger?.warn(`[@dsh-permission-remote] ops tool install failed for agent ${agentLabel(agent)}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let dropped = false
  const drop = () => {
    if (dropped) return
    dropped = true
    for (const unregister of disposers) unregister()
    unregisters.delete(drop)
    forget()
  }
  unregisters.add(drop)
  try {
    agent.ctx.effect(() => drop)
  } catch (error) {
    drop()
    ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed for agent ${agentLabel(agent)}: ${error instanceof Error ? error.message : String(error)}`)
    if (initial.kind === 'remote') throw error
    return false
  }
  return true
}

function agentLabel(agent: AgentLike): string {
  return agent.session?.id ?? agent.session?.header?.cwd ?? 'unknown'
}

function withRemoteTimeout(definition: object): object {
  const parameters = (definition as { parameters?: Record<string, { description?: string }> }).parameters
  if (parameters?.timeoutMs === undefined) return definition
  return {
    ...definition,
    parameters: {
      ...parameters,
      timeoutMs: {
        ...parameters.timeoutMs,
        description: 'Timeout in milliseconds. When it expires this remote command is killed. Without a sandbox runner, child processes of the command may keep running on the remote host.',
      },
    },
  }
}

function effectiveCwd(ctx: HostContext, exec: ToolExec, fallback: string | undefined): string | undefined {
  const directories = ctx.get('workingDirectory') as { get(session: object): string } | undefined
  const session = exec.agent?.session
  if (directories !== undefined && session !== undefined) {
    try {
      return directories.get(session)
    } catch {
      // A session without a recorded directory falls through to the header.
    }
  }
  return session?.header?.cwd ?? fallback
}

function capturedSchema(ctx: HostContext, toolName: string, agent: object): object {
  const official = ctx.tools.get(toolName, agent)
  if (official === undefined) return fallbackSchema(toolName)
  const { execute: _execute, ...rest } = official as object & { execute?: unknown }
  return rest
}

function fallbackSchema(toolName: string): object {
  if (toolName !== 'bash') {
    return {
      description: toolName,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: '' }] },
    }
  }
  return {
    description: 'Execute a bash command on the remote workspace.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        timeoutMs: { type: 'number' },
        workdir: { type: 'string' },
        run_in_background: { type: 'boolean' },
        sandbox_permissions: { type: 'string', enum: [...ESCALATION_TARGETS] },
        justification: { type: 'string' },
      },
      required: ['command', 'description'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: { kind?: string, stdout?: { text?: string }, stderr?: { text?: string }, exitCode?: number | null }) => [{
        type: 'text',
        text: value.kind === 'background' ? 'started background job' : `${value.stdout?.text ?? ''}${value.stderr?.text ?? ''}\n[exit code: ${value.exitCode ?? 'null'}]`,
      }],
    },
  }
}

/**
 * Ops commands run unconfined on the remote, so `danger-full-access` is the
 * only escalation that `requireOps` accepts. Advertising narrower modes would
 * send the model into a retry that never opens an approval card.
 */
const OPS_ESCALATION = {
  sandbox_permissions: { type: 'string', enum: ['danger-full-access'] },
  justification: { type: 'string' },
} as const

const textOutput = (render: (value: Record<string, unknown>) => string) => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: Record<string, unknown>) => [{ type: 'text', text: render(value) }],
})

/**
 * Ops tools are registered for every agent, so a session whose workspace is
 * local can still act on a configured SSH host. Each call names its host.
 */
function publishOpsTool(tool: {
  name: string
  description: string
  parameters: ParameterSchemaSpec
  output: object
  execute: (args: unknown, exec: ToolExec) => Promise<unknown>
}): object {
  const parameters = parameterSchemaSpecToJsonSchema(tool.parameters)
  return {
    ...tool,
    parameters,
    async execute(args: unknown, exec: ToolExec) {
      const violations = validateArgs(tool.parameters, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return tool.execute(args, exec)
    },
  }
}

function opsTools(core: Core): object[] {
  const hostApi = core.toolHost(undefined)
  const pick = (args: Record<string, unknown>) => core.requireOpsHost(String(args.host ?? ''))
  return [publishOpsTool({
      name: 'ssh_hosts',
      description: 'List the configured SSH hosts for ops on another machine: id, name, address, user, ops policy, and whether the host key is trusted. Call this before ssh_exec, ssh_read, or ssh_write when you do not know the host id or name. Policy "ask" allows reads but needs danger-full-access for commands and writes, so pass sandbox_permissions "danger-full-access" and a justification; "trust" runs without a prompt; "deny" accepts nothing. An untrusted host must be trusted in Settings → SSH hosts first.',
      parameters: {},
      output: textOutput(value => {
        const hosts = Array.isArray(value.hosts) ? value.hosts as Array<ReturnType<typeof opsHostView>> : []
        if (hosts.length === 0) return 'no SSH hosts configured'
        return hosts.map(host => `${host.name || host.address} [${host.id}] ${host.username}@${host.address} ops=${host.opsPolicy}${host.trusted ? '' : ' (untrusted: trust it in Settings first)'}`).join('\n')
      }),
      async execute() {
        return { hosts: core.listHosts().map(host => opsHostView(host)) }
      },
    }), publishOpsTool({
      name: 'ssh_exec',
      description: 'Run a command on a configured SSH host as the remote login user. This is for ops on a machine that is not your current workspace. The remote command is not sandboxed locally: on an "ask" host it runs only with danger-full-access, either from this session\'s mode or a one-shot approval. Retry with sandbox_permissions "danger-full-access" and a one-sentence justification when the call is denied. sudo only works without a password prompt (sudo -n).',
      parameters: {
        host: { type: 'string', required: true, description: 'SSH host id, name, or address from ssh_hosts' },
        command: { type: 'string', required: true, description: 'Command to run with bash -lc on the remote host' },
        workdir: { type: 'string', description: 'Absolute remote working directory; defaults to the login directory' },
        timeoutMs: { type: 'number', description: 'Command timeout in milliseconds; defaults to 60000' },
        ...OPS_ESCALATION,
      },
      output: textOutput(renderOpsExec),
      execute(args: unknown, exec: ToolExec) {
        const record = args as Record<string, unknown>
        const host = pick(record)
        return runSshExec(hostApi, host, record, exec)
      },
    }), publishOpsTool({
      name: 'ssh_read',
      description: 'Read a file from a configured SSH host without a shell. Use an absolute remote path or one that starts with "~/" (expanded against the remote home). Reads are allowed on any host whose ops policy is not "deny". The text result includes the line range and whether more lines follow.',
      parameters: {
        host: { type: 'string', required: true, description: 'SSH host id, name, or address from ssh_hosts' },
        file_path: { type: 'string', required: true, description: 'Absolute remote path or a path starting with "~/"' },
        offset: { type: 'number', description: '1-based first line to return; defaults to 1' },
        limit: { type: 'number', description: 'Maximum lines to return; defaults to 2000' },
      },
      output: textOutput(renderOpsRead),
      execute(args: unknown, exec: ToolExec) {
        const record = args as Record<string, unknown>
        const host = pick(record)
        return runSshRead(hostApi, host, record, exec)
      },
    }), publishOpsTool({
      name: 'ssh_write',
      description: 'Replace a file on a configured SSH host. The new content is written to a temp file in the same directory and renamed with mv -f, so a dropped connection does not truncate the original. An existing directory is rejected. Replacing a file keeps its permission bits; a new file is created with the remote umask. On an "ask" host this needs danger-full-access: pass sandbox_permissions "danger-full-access" and a one-sentence justification when the call is denied.',
      parameters: {
        host: { type: 'string', required: true, description: 'SSH host id, name, or address from ssh_hosts' },
        file_path: { type: 'string', required: true, description: 'Absolute remote path or a path starting with "~/"' },
        content: { type: 'string', required: true, description: 'Full replacement file content' },
        ...OPS_ESCALATION,
      },
      output: textOutput(value => {
        const host = value.host as ReturnType<typeof opsHostView> | undefined
        return `${value.operation === 'create' ? 'created' : 'updated'} ${String(value.path ?? '')} on ${host === undefined ? 'remote host' : host.name || host.address}`
      }),
      execute(args: unknown, exec: ToolExec) {
        const record = args as Record<string, unknown>
        const host = pick(record)
        return runSshWrite(hostApi, host, record, exec)
      },
    })]
}
