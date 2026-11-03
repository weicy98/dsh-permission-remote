import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join as joinPath, posix, resolve as resolveLocalPath } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { FsError } from '@deepseek-ai/dsh-fs'
import { ESCALATION_TARGETS } from '@deepseek-ai/dsh-sandbox'
import { ToolArgsError, parameterSchemaSpecToJsonSchema, validateArgs, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials/types'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { fetchRgBinary, rgPlatformOf } from './rg-fetch.ts'
import { Config, connectionKeyChanged, exportHostConfig, mergeImportedHosts, normalizeLoginEnv, normalizeOpsPolicy, parseHostImport, readConfig, type DeletedHost, type HostConfig, type HostConfigExport, type HostImportResult, type PluginConfig } from './config.ts'
import { LoginEnvCache, LOGIN_ENV_CAPTURE_MS, loginEnvCaptureCommand, type LoginEnvRead } from './login-env.ts'
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
  stagePresentFiles,
  throwIfAborted,
  withSignal,
  type RunnerStatus,
  type ToolExec,
  type ToolHost,
} from './execute.ts'
import { sniffImage } from './image.ts'
import { hostLabel, isRemoteMissing, opsHostView, renderOpsExec, renderOpsRead, renderSshWorkspace, resolveOpsHost, runSshExec, runSshRead, runSshWorkspace, runSshWrite, forgetOpsHost } from './ops.ts'
import { addSupersededRoot, childDirectoryPath, clearSupersededRoots, defaultRemoteRoot, encodeRemotePath, expandRemoteRoot, isValidHostId, listingPath, mapRemoteToLocal, normalizeRemoteDirectory, remoteRoot, resolveRemotePath, routeByCwd, setRemoteRootOverride, supersededRootsSnapshot, type RemoteRoute, type Route } from './router.ts'
import { relocateSessions, type SessionRelocationSummary } from './session-relocate.ts'
import { planRemoteRoot, runMigration, type MigrationReport, type MigrationStrategy } from './migrate.ts'
import {
  PWSH_SECTION,
  REMOTE_POSIX_SECTION,
  REMOTE_WORKSPACE_CONTEXT,
  isUnknownRestrictError,
  isWindowsShell,
  remotePosixPrompt,
  remoteWorkspaceContextText,
  sameShellSurface,
  shellSurfacePlan,
  windowsShellGuardReason,
  withoutWindowsShells,
} from './shell-surface.ts'
import { TERMINAL_OPEN_REFUSED, dispatchShadow, planShadows, type RoutedToolName } from './shadow.ts'
import { parseShellProbe, shellProbeCommand, installSidebarBridge, type SidebarShell } from './sidebar-terminal.ts'
import { SshPool, type SecretMaterial } from './ssh-pool.ts'
import {
  createdWorkspaceTitle,
  hostTag,
  remoteWorkspaces,
  tagRemoteWorkspaces,
  workspaceRoute,
  textOrUndefined,
  type DeletedHostView,
  type RemoteWorkspaceView,
  type WorkspaceLike,
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
    /** Absent only in tests that never import a host. Returning undefined from modifyRecord would keep the old secret. */
    deleteRecord?(key: ReturnType<typeof credentialKey>): Promise<void>
  }
  workspaceRegistry: WorkspaceRegistryLike
  get(service: string): unknown
  on(event: 'agent/created', listener: (payload: { agent: AgentLike }) => void): () => void
  /** Fired after any surface writes a settings section (`ns` is its id). */
  on(event: 'settings/document-updated', listener: (ns: unknown, revision: number) => void): () => void
  effect(dispose: () => void): void
  logger?: { info(message: string): void, warn(message: string): void }
}

interface PromptToolsAssembly {
  tools: ReadonlyArray<{ name: string }>
}

interface PromptAssembleContext {
  scope?: object
}

interface AgentContext {
  tools: HostContext['tools'] & {
    restrict(filter: { deny: readonly string[] }): () => void
    guard(guard: (execution: { readonly name: string, readonly agent?: ToolExec['agent'] }) => string | undefined): () => void
  }
  systemPrompt: {
    section(section: { name: string, order: number, text: string | (() => string), complete?: boolean }): () => void
    getSectionOrder(name: string): number
    context(context: { name: string, order: number, text: string | ((context: unknown) => string), required?: boolean, interpolate?: boolean }): () => void
    getContextOrder(name: string): number
  }
  get(service: string): unknown
  on(event: 'session/event', listener: (session: unknown, event: { type: string, data?: { cwd?: string } }) => void): () => void
  on(event: 'system-prompt/assemble', listener: (assembly: PromptToolsAssembly, context: PromptAssembleContext, next: () => Promise<PromptToolsAssembly>) => Promise<PromptToolsAssembly>): () => void
  effect(dispose: () => void): void
}

interface AgentLike {
  ctx: AgentContext
  session?: { header?: { cwd?: string }, id?: string }
}

interface GrantPayload {
  password?: string
  passphrase?: string
}

/** Where remote-workspace placeholders live right now, and the built-in default. */
export interface RemoteRootInfo {
  current: string
  defaultRoot: string
}

/**
 * Outcome of a remote-root change.
 *
 * `needs-strategy` and `has-sessions` are non-destructive refusals: the page
 * asks the operator how to proceed, then calls again with `strategy`/`force`.
 */
export interface RemoteRootChange {
  status: 'changed' | 'unchanged' | 'needs-strategy' | 'has-sessions'
  oldRoot: string
  root: string
  sessions?: number
  conflicts?: string[]
  migration?: MigrationReport
  workspacesRemapped?: number
  /** Stored sessions whose header and directory were moved onto the new root. */
  sessionsRelocated?: number
  /** Live sessions left in place on purpose; they follow once closed and the root is saved again. */
  sessionsSkippedLive?: number
  /** Sessions that could not be moved, reported so nothing is lost silently. */
  sessionsFailed?: number
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

  /**
   * List a directory for the picker.
   *
   * The picker also accepts a typed path, so a request may arrive as `~`,
   * `~/src`, or with `..` and doubled separators in it. `resolve` is the
   * caller saying so: a typed path is settled with realpath, which yields the
   * one spelling the breadcrumb, the workspace registry, and a later listing
   * agree on, while a path the picker built from a listing is already that
   * spelling. Skipping the call for the second case keeps a row click at one
   * request instead of two on a slow link.
   */
  async listDir(input: { hostId: string, path: string, resolve?: boolean }): Promise<{ path: string, entries: Array<{ name: string, path: string }> }> {
    const host = this.core.requireHost(input.hostId)
    const secret = await this.core.secret(host)
    // The RPC is a boundary: a request without a path still has to list
    // something, and the root is what an empty path has always meant.
    const requested = (input.path ?? '').trim()
    // `~` is the login home: the SFTP session starts there, but SFTP does not
    // expand the tilde itself.
    const wantsHome = requested === '~' || requested.startsWith('~/')
    const home = wantsHome
      ? normalizeRemoteDirectory(await this.core.pool.sftpRealpath(host, secret, '.'))
      : null
    // Guessing at a home would list the wrong directory under a path the
    // operator asked for, so say so instead.
    if (wantsHome && home === null) throw new Error('the remote did not report a login home')
    const expanded = listingPath(requested, home ?? '')
    const resolved = input.resolve === true
      ? normalizeRemoteDirectory(await this.core.pool.sftpRealpath(host, secret, expanded)) ?? expanded
      : expanded
    const entries = await this.core.pool.sftpList(host, secret, resolved)
    return { path: resolved, entries }
  }

  /**
   * Create one directory below an already-listed one, then return the new
   * listing so the picker shows it without a second round trip.
   *
   * The name is one path segment: a separator would create a tree the caller
   * never listed, and `.`/`..` would escape the directory the operator is
   * looking at.
   */
  async createDir(input: { hostId: string, path: string, name: string }): Promise<{ path: string, entries: Array<{ name: string, path: string }> }> {
    const host = this.core.requireHost(input.hostId)
    const parent = input.path || '/'
    const child = childDirectoryPath(parent, input.name)
    if ('error' in child) {
      throw new Error(child.error === 'empty'
        ? 'new folder name is empty'
        : child.error === 'dot'
          ? `"${input.name.trim()}" is not a folder name`
          : 'new folder name must be one path segment')
    }
    const secret = await this.core.secret(host)
    await this.core.pool.sftpMkdir(host, secret, child.path)
    // The reply carries the refreshed listing: the picker shows the new row
    // without asking again, and a name the remote accepted is never assumed.
    const entries = await this.core.pool.sftpList(host, secret, parent)
    return { path: parent, entries }
  }

  async createWorkspace(input: { hostId: string, path: string, title?: string }): Promise<{ path: string, title: string }> {
    const host = this.core.requireHost(input.hostId)
    const created = await this.core.registerWorkspace(host, input.path, input.title)
    return { path: created.path, title: created.title }
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

  /** Drop the cached login environment. The next workspace command reads it again. */
  async refreshLoginEnv(input: { hostId: string }): Promise<{ ok: true }> {
    this.core.refreshLoginEnv(input.hostId)
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

  /** The effective placeholder root plus the built-in default, for the Settings field. */
  async remoteRootInfo(): Promise<RemoteRootInfo> {
    return this.core.remoteRootInfo()
  }

  /**
   * Change the placeholder root and move the old tree there.
   *
   * Without `strategy`, this only plans: an empty/absent target is copied and
   * switched at once, a non-empty target with conflicting files is reported
   * back so the page can ask before touching anything.
   */
  async changeRemoteRoot(input: { root: string, strategy?: MigrationStrategy, force?: boolean, conflicts?: string[] }): Promise<RemoteRootChange> {
    const accepted = Array.isArray(input.conflicts) ? input.conflicts.filter(item => typeof item === 'string') : undefined
    return this.core.changeRemoteRoot(input.root, { strategy: input.strategy, force: input.force === true, acceptedConflicts: accepted })
  }

  /** Export the host list as JSON. No secrets are ever included. */
  async exportHosts(): Promise<HostConfigExport> {
    return this.core.exportHostConfig()
  }

  /** Merge or replace the host list from a JSON export. */
  async importHosts(input: { payload: unknown, mode?: 'merge' | 'replace' }): Promise<HostImportResult & { ok: true }> {
    return this.core.importHostConfig(input.payload, input.mode === 'replace' ? 'replace' : 'merge')
  }
}

export class Core {
  readonly pool: SshPool
  private config: PluginConfig
  private readonly status = new Map<string, Promise<RunnerStatus>>()
  private readonly shellLists = new Map<string, Promise<SidebarShell[]>>()
  private readonly loginEnvs = new LoginEnvCache((hostId, signal) => this.readLoginEnv(hostId, signal))
  /** The first apply installs the configured root; only a later change keeps the previous one routable. */
  private remoteRootApplied = false

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
    this.loginEnvs.forget(hostId)
  }

  /**
   * Drop the cached login environment only. The pooled SSH session stays up.
   * The next workspace command captures again, bounded by {@link LOGIN_ENV_CAPTURE_MS}.
   */
  refreshLoginEnv(hostId: string): void {
    this.requireHost(hostId)
    this.loginEnvs.forget(hostId)
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
    const normalized = {
      ...host,
      opsPolicy: normalizeOpsPolicy((host as { opsPolicy?: unknown }).opsPolicy),
      loginEnv: normalizeLoginEnv((host as { loginEnv?: unknown }).loginEnv),
    }
    this.config.hosts = previous === undefined
      ? [...this.config.hosts, normalized]
      : this.config.hosts.map(item => item.id === host.id ? normalized : item)
    // A cached session keyed by id would keep talking to the previous machine.
    if (previous !== undefined && connectionKeyChanged(previous, normalized)) {
      this.forgetStatus(host.id)
    }
    else {
      forgetOpsHost(host.id)
      // The snapshot is not part of the handshake. Drop it only when the switch flips.
      if (previous !== undefined && (previous.loginEnv === true) !== normalized.loginEnv) this.loginEnvs.forget(host.id)
    }
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
      this.commitTombstones([
        { host: removed, deletedAt: new Date().toISOString() },
        ...this.config.deletedHosts.filter(item => item.host.id !== hostId),
      ])
    }
    this.config.hosts = this.config.hosts.filter(item => item.id !== hostId)
    this.pool.invalidate(hostId)
    this.status.delete(hostId)
    forgetOpsHost(hostId)
    this.forgetShells(hostId)
    await this.persistHosts()
  }

  /**
   * Replace the tombstone list.
   *
   * Hosts that still own a workspace always keep their row, so those workspaces
   * stay reachable; the newest 20 that own none are kept as the delete history.
   * Shared by `deleteHost` and the JSON import, which drops hosts the same way.
   */
  private commitTombstones(rows: readonly DeletedHost[]): void {
    const withWorkspaces = new Set(this.listWorkspaces().map(item => item.hostId))
    let spare = 0
    this.config.deletedHosts = rows
      .filter(row => {
        if (withWorkspaces.has(row.host.id)) return true
        spare += 1
        return spare <= 20
      })
      .map(row => ({ host: { ...row.host }, deletedAt: row.deletedAt ?? '' }))
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

  /** Persist only the placeholder root, leaving the host rows untouched. */
  private async persistRemoteRoot(root: string): Promise<void> {
    const row = this.ctx.settings.describe().find(item => String(item.ns) === 'permission-remote')
    if (row === undefined) {
      // Nothing was written, so this must not look like a successful switch: the
      // next load would resolve an older root and leave every workspace
      // registered under a placeholder that no longer routes anywhere.
      throw new Error('the settings row "permission-remote" is missing; the remote root was not saved')
    }
    await this.ctx.settings.update(String(row.ns), { remoteRoot: root })
  }

  /**
   * Save the root and point routing at it, in that order.
   *
   * The write goes first: a failure leaves the setting and the routing on the
   * old root, which still owns every placeholder. The reverse order would
   * report a switch the next load does not agree with.
   */
  private async commitRemoteRoot(root: string): Promise<void> {
    await this.persistRemoteRoot(root)
    setRemoteRootOverride(root)
    try {
      this.config.remoteRoot = root
    } catch (error) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] could not store the remote root in memory: ${errorText(error)}`)
    }
  }

  /**
   * Apply the configured root to the routing helpers.
   *
   * Called at load and again whenever the settings section is written by any
   * surface, so editing the value in the generic settings editor takes effect
   * without a restart. A root already superseded by a migration stays routable:
   * dropping it here would strand a session that is still on it.
   */
  applyRemoteRootOverride(): void {
    const previous = remoteRoot()
    const configured = this.config.remoteRoot.trim()
    let override: string | null = null
    if (configured.length === 0) {
      override = null
    } else {
      const expanded = expandRemoteRoot(configured)
      if (expanded === null) {
        this.ctx.logger?.warn(`[@dsh-permission-remote] the configured remote root ${JSON.stringify(configured)} is not an absolute path; falling back to ${defaultRemoteRoot()}`)
        override = null
      } else {
        override = expanded
        if (!existsSync(expanded)) {
          this.ctx.logger?.warn(`[@dsh-permission-remote] the configured remote root ${expanded} does not exist; placeholders will be created there on demand`)
        }
      }
    }
    setRemoteRootOverride(override)
    // A generic settings edit does not copy the tree. Keep the root this process
    // was using, or the next command on an open placeholder runs on this machine.
    // The first apply is a load: the previous default was never this process's root.
    if (this.remoteRootApplied && remoteRoot() !== previous) addSupersededRoot(previous)
    this.remoteRootApplied = true
  }

  /** Re-read the root after a settings write from any surface. */
  onSettingsUpdated(ns: unknown): void {
    if (String(ns) !== 'permission-remote') return
    this.applyRemoteRootOverride()
    this.ctx.logger?.info(`[@dsh-permission-remote] remote root setting changed; routing now uses ${remoteRoot()}`)
  }

  /** The effective placeholder root and the built-in default. */
  remoteRootInfo(): RemoteRootInfo {
    return { current: remoteRoot(), defaultRoot: defaultRemoteRoot() }
  }

  exportHostConfig(): HostConfigExport {
    return exportHostConfig(this.config.hosts, this.config.deletedHosts)
  }

  async importHostConfig(payload: unknown, mode: 'merge' | 'replace'): Promise<HostImportResult & { ok: true }> {
    const incoming = parseHostImport(payload)
    const previous = new Map(this.config.hosts.map(host => [host.id, host]))
    // A host renamed by a backup must retag its sidebar rows exactly like
    // `saveHost` does; load-time tagging only touches an untagged title. A
    // revived host counts too, which is why the tombstones are read as well.
    const previousTags = new Map<string, string>()
    for (const host of [...this.config.hosts, ...this.config.deletedHosts.map(row => row.host)]) {
      previousTags.set(host.id, hostTag(host))
    }
    const merged = mergeImportedHosts(this.config.hosts, this.config.deletedHosts, incoming, mode)
    let deletedHosts = merged.deletedHosts
    if (mode === 'replace') {
      // A host deleted earlier, whose workspaces are still registered, is not in
      // the live list, so `replace` would otherwise drop the only copy of its
      // address and key path. Keep that tombstone when the file does not mention it.
      const live = new Set(merged.hosts.map(host => host.id))
      const already = new Set(deletedHosts.map(row => row.host.id))
      const owned = new Set(this.listWorkspaces().map(item => item.hostId))
      const retained = this.config.deletedHosts.filter(row => owned.has(row.host.id) && !live.has(row.host.id) && !already.has(row.host.id))
      deletedHosts = [...deletedHosts, ...retained.map(row => ({ host: { ...row.host }, deletedAt: row.deletedAt ?? '' }))]
    }
    // The password is stored by host id. A new address must not keep using it,
    // including a tombstone the file revives onto a different machine.
    for (const host of merged.hosts) {
      const before = previous.get(host.id) ?? this.config.deletedHosts.find(row => row.host.id === host.id)?.host
      if (before !== undefined && before.host !== host.host) await this.dropSecret(host.id)
    }
    this.config.hosts = merged.hosts
    // Keeping a dropped host as a tombstone is what `replace` shares with
    // `deleteHost`: its workspaces are still registered and must stay reachable.
    this.commitTombstones(deletedHosts)
    // Drop cached connections/probes/shells for a host that is new, whose
    // handshake changed, or whose login-env switch flipped; a plain restore of
    // unchanged rows leaves running sessions alone.
    const nextIds = new Set(merged.hosts.map(host => host.id))
    for (const before of previous.values()) {
      if (!nextIds.has(before.id)) this.forgetStatus(before.id)
    }
    for (const host of merged.hosts) {
      const before = previous.get(host.id)
      if (before === undefined || connectionKeyChanged(before, host) || before.loginEnv !== host.loginEnv) {
        this.forgetStatus(host.id)
      }
    }
    await this.persistHosts()
    if (this.config.tagWorkspaceTitles) {
      for (const host of merged.hosts) {
        const previousTag = previousTags.get(host.id)
        if (previousTag === undefined || previousTag === hostTag(host)) continue
        await this.tagWorkspaces(host.id, undefined, previousTag)
      }
    }
    return { ok: true, ...merged, deletedHosts }
  }

  /** Forget the password stored for one host id. `modifyRecord` returning undefined would keep it. */
  private async dropSecret(hostId: string): Promise<void> {
    const drop = this.ctx.credentials.deleteRecord
    if (drop === undefined) return
    await drop(credentialKey('dsh-permission-remote', hostId))
  }

  /**
   * Move the placeholder tree to `inputRoot` and point routing at it.
   *
   * The old tree's workspace rows are re-created at the new placeholder paths,
   * keeping their titles. A change is refused (without touching anything) while
   * workspaces have live sessions, and a non-empty target whose files conflict
   * is reported before it is merged, so the operator can choose the strategy.
   *
   * Nothing is committed until the plan has been accepted and the copy has
   * finished: the old tree is only ever read, so a failure leaves it as the
   * authoritative root.
   */
  async changeRemoteRoot(inputRoot: string, opts: { strategy?: MigrationStrategy, force: boolean, acceptedConflicts?: readonly string[] }): Promise<RemoteRootChange> {
    const oldRoot = remoteRoot()
    const trimmed = inputRoot.trim()
    // A blank field means "go back to the built-in default", so the operator can
    // undo a custom root from the page instead of typing the default by hand.
    const newRoot = trimmed.length === 0 ? resolveLocalPath(defaultRemoteRoot()) : expandRemoteRoot(inputRoot)
    if (newRoot === null) throw new Error('remote root must be an absolute path or start with ~/')
    if (newRoot === oldRoot) {
      // Pin an explicit spelling, but a blank field that already resolves to the
      // default must not persist the default path (it would stop tracking it).
      if (trimmed.length > 0 && this.config.remoteRoot !== newRoot) await this.commitRemoteRoot(newRoot)
      // Saving the root again is the documented way to catch up sessions that a
      // migration had to skip because they were open: sweep every root this
      // process migrated away from onto the current one.
      const relocation = await this.relocateFromSupersededRoots(newRoot)
      return {
        status: 'unchanged',
        oldRoot,
        root: newRoot,
        ...summaryCounts(relocation),
      }
    }
    const opened = this.remoteWorkspaceRows()
    // Plan before anything is asked or written: a target that is inside the old
    // root, or that is not a directory, must be an error rather than a
    // confirmation prompt the operator can only answer into a failure.
    const strategy = opts.strategy ?? 'auto'
    // The page calls again with the chosen strategy, which plans afresh. When it
    // also sends the conflict list it showed, a path that was not on that list
    // is asked again instead of being overwritten.
    const plan = await planRemoteRoot(oldRoot, newRoot, strategy)
    const sessions = opened.reduce((sum, item) => sum + item.ws.sessionIds.length, 0)
    if (sessions > 0 && !opts.force) return { status: 'has-sessions', oldRoot, root: newRoot, sessions }
    if (!plan.targetWasEmpty && opts.strategy === undefined && plan.conflicts.length > 0) {
      return { status: 'needs-strategy', oldRoot, root: newRoot, conflicts: plan.conflicts }
    }
    if (opts.strategy !== undefined && opts.acceptedConflicts !== undefined) {
      const accepted = new Set(opts.acceptedConflicts)
      if (plan.conflicts.some(conflict => !accepted.has(conflict))) {
        return { status: 'needs-strategy', oldRoot, root: newRoot, conflicts: plan.conflicts }
      }
    }
    for (const item of opened) {
      const rel = `${item.hostId}/${encodeRemotePath(item.remotePath)}`
      const blocked = plan.conflicts.some(conflict => conflict === rel || rel.startsWith(`${conflict}/`))
      if (blocked) {
        throw new Error(`cannot move the remote root to ${newRoot}: ${rel} conflicts with an existing file or directory and was left unchanged`)
      }
    }
    let migration: MigrationReport
    try {
      migration = await runMigration(plan)
    } catch (error) {
      // The old root was only read from, so it is still the authoritative one.
      // The target may hold a partial copy, which nothing points at yet.
      throw new Error(`copying the remote root to ${newRoot} failed: ${errorText(error)}`)
    }
    // Register at the new paths before the setting changes. A failure here still
    // leaves the old root in charge; switching first would report success while
    // a workspace stayed on a path that stops routing after restart.
    const relocating = this.remoteWorkspaceRows()
    const created: WorkspaceLike[] = []
    // Rows this attempt added. A path the registry already had is not ours to delete.
    const existedIds = new Set(this.workspaces.list().map(row => String(row.id)))
    let workspacesRemapped = 0
    try {
      for (const item of relocating) {
        const local = this.placeholderAt(newRoot, item.hostId, item.remotePath)
        if (local === null) throw new Error(`workspace ${String(item.ws.id)} cannot be mapped under ${newRoot}`)
        if (resolveLocalPath(item.ws.path) === resolveLocalPath(local)) {
          workspacesRemapped += 1
          continue
        }
        await mkdir(local, { recursive: true })
        const row = await this.workspaces.create(local, item.ws.title)
        const rowId = String(row.id)
        if (!existedIds.has(rowId)) {
          existedIds.add(rowId)
          created.push(row)
        }
      }
    } catch (error) {
      for (const row of created.reverse()) {
        try {
          await this.workspaces.delete(row.id)
        } catch (cleanup) {
          this.ctx.logger?.warn(`[@dsh-permission-remote] could not roll back workspace ${String(row.id)}: ${errorText(cleanup)}`)
        }
      }
      throw new Error(`registering workspaces at ${newRoot} failed: ${errorText(error)}; the old root is still in use`)
    }
    try {
      await this.commitRemoteRoot(newRoot)
    } catch (error) {
      for (const row of created.reverse()) {
        try {
          await this.workspaces.delete(row.id)
        } catch (cleanup) {
          this.ctx.logger?.warn(`[@dsh-permission-remote] could not roll back workspace ${String(row.id)}: ${errorText(cleanup)}`)
        }
      }
      throw new Error(`the placeholders were copied to ${newRoot}, but the new root could not be saved (${errorText(error)}); the old root is still in use`)
    }
    // Sessions still sitting on the old placeholders must keep routing to their
    // server: an old placeholder that no registered workspace covers is then
    // refused by the entry guard instead of quietly becoming a local directory.
    addSupersededRoot(oldRoot)
    // Move the stored sessions themselves before the old registrations
    // disappear. Without this a session keeps pointing at the old root: its
    // log sits in a project directory the new cwd contradicts, so DSH refuses
    // to open it and the workspace service filters it from membership — the
    // "migrated sessions vanish into Ungrouped" failure. Live sessions are
    // skipped and keep routing until the operator closes them and saves again.
    const relocation = await this.relocateStoredSessions(oldRoot, newRoot, created)
    const stuck: string[] = []
    for (const item of relocating) {
      const local = this.placeholderAt(newRoot, item.hostId, item.remotePath)
      if (local === null || resolveLocalPath(item.ws.path) === resolveLocalPath(local)) continue
      try {
        await this.workspaces.delete(item.ws.id)
        workspacesRemapped += 1
      } catch (error) {
        stuck.push(String(item.ws.id))
        this.ctx.logger?.warn(`[@dsh-permission-remote] could not remove workspace ${String(item.ws.id)} from the old remote root: ${errorText(error)}`)
      }
    }
    if (stuck.length > 0) {
      throw new Error(`the remote root is now ${newRoot}, but ${stuck.length} workspace registration(s) could not be removed from the old root (${stuck.join(', ')})`)
    }
    return { status: 'changed', oldRoot, root: newRoot, migration, workspacesRemapped, ...summaryCounts(relocation) }
  }

  /**
   * Move stored sessions from every root this process migrated away from onto
   * `current`, and account them to the workspace registered at their new
   * placeholder. Used when saving the root that is already current: the
   * catch-up pass for sessions a migration skipped while they were open.
   */
  private async relocateFromSupersededRoots(current: string): Promise<SessionRelocationSummary> {
    const summary: SessionRelocationSummary = { relocated: [], skippedLive: [], failed: [] }
    for (const root of supersededRootsSnapshot()) {
      if (root === current) continue
      const part = await this.relocateStoredSessions(root, current, [])
      summary.relocated.push(...part.relocated)
      summary.skippedLive.push(...part.skippedLive)
      summary.failed.push(...part.failed)
    }
    return summary
  }

  /**
   * Rewrite each stored session whose header names `oldRoot`, move its
   * directory to the project key the new cwd implies, and attach the id to the
   * workspace registered there.
   *
   * Nothing here may fail the migration: the tree copy and the registry switch
   * already succeeded, so a stuck file is collected and reported instead.
   * Membership attach is best-effort too — a session whose workspace row cannot
   * take it stays "Ungrouped", which the sidebar tolerates and a re-save fixes.
   */
  private async relocateStoredSessions(oldRoot: string, newRoot: string, preferRows: readonly WorkspaceLike[]): Promise<SessionRelocationSummary> {
    const live = new Set<string>()
    const agents = this.ctx.get('agents') as { list?: () => AgentLike[] } | undefined
    for (const agent of agents?.list?.() ?? []) {
      const id = agent.session?.id
      if (typeof id === 'string' && id.length > 0) live.add(id)
    }
    let summary: SessionRelocationSummary
    try {
      summary = await relocateSessions({ oldRoot, newRoot, liveSessionIds: live })
    } catch (error) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] could not scan the session store while migrating to ${newRoot}: ${errorText(error)}`)
      return { relocated: [], skippedLive: [...live], failed: [] }
    }
    if (summary.relocated.length === 0 && summary.failed.length === 0) return summary
    const rows = [...preferRows, ...this.workspaces.list()]
    for (const row of summary.relocated) {
      const target = rows.find(item => resolveLocalPath(item.path) === resolveLocalPath(row.to))
      const attach = target?.attachSession
      if (attach === undefined) continue
      try {
        await attach.call(target, row.id)
      } catch (error) {
        this.ctx.logger?.warn(`[@dsh-permission-remote] session ${row.id} moved to ${row.to} but could not join its workspace: ${errorText(error)}`)
      }
    }
    if (summary.failed.length > 0) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] ${summary.failed.length} session(s) could not follow the remote root to ${newRoot}: ${summary.failed.map(item => `${item.id} (${item.reason})`).join('; ')}`)
    }
    if (summary.skippedLive.length > 0) {
      this.ctx.logger?.info(`[@dsh-permission-remote] left ${summary.skippedLive.length} open session(s) on ${oldRoot}; closing them and saving the root again moves them`)
    }
    return summary
  }

  /** Workspaces whose placeholder still routes, including ones registered during a copy. */
  private remoteWorkspaceRows(): Array<{ ws: WorkspaceLike, hostId: string, remotePath: string }> {
    const mapped: Array<{ ws: WorkspaceLike, hostId: string, remotePath: string }> = []
    for (const ws of this.workspaces.list()) {
      const route = workspaceRoute(ws.path)
      if (route !== null) mapped.push({ ws, hostId: route.hostId, remotePath: route.remotePath })
    }
    return mapped
  }

  /** The placeholder path under an explicit root, before routing has switched to it. */
  private placeholderAt(root: string, hostId: string, remotePath: string): string | null {
    if (!isValidHostId(hostId)) return null
    return joinPath(root, hostId, encodeRemotePath(remotePath))
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

  /**
   * Register one remote directory as a workspace: the placeholder directory is
   * created locally, the title carries the server when tagging is on, and the
   * workspace registry keeps an existing row's title if it already exists.
   *
   * Shared by the settings page and the `ssh_workspace` tool, so both entries
   * point at the same real directory and cannot disagree about the title.
   * Neither entry lets the calling session enter. A session starts there when
   * the user opens the workspace.
   */
  async registerWorkspace(host: HostConfig, remotePath: string, title?: string, signal?: AbortSignal): Promise<{ path: string, remotePath: string, title: string, created: boolean }> {
    if (remotePath.trim().length === 0) throw new Error('remote path is required')
    // One spelling per directory: a trailing slash would otherwise encode a
    // placeholder of its own and register a second workspace for the same path.
    const normalized = normalizeRemoteDirectory(remotePath)
    if (normalized === null) throw new Error(`remote path must be absolute: ${remotePath}`)
    // `/` covers every path, and workspace-write then bind-mounts the whole machine.
    if (normalized === '/') throw new Error(`refusing to register "/": a workspace rooted at the remote filesystem root covers every path on ${hostLabel(host)}`)
    throwIfAborted(signal)
    // Read the credential first: a credential-store failure must not be
    // mistaken for a missing directory below.
    const secret = await this.secret(host)
    let info
    try {
      info = await withSignal(this.pool.sftpStat(host, secret, normalized), signal)
    } catch (error) {
      // A mistyped path is the common failure, and the bare SFTP code says
      // nothing about the fix. Anything else (auth, network) is the remote's own
      // news and is forwarded untouched.
      if (isRemoteMissing(error)) {
        throw new Error(`remote directory not found on ${hostLabel(host)}: ${normalized}; create it first with ssh_exec (mkdir -p) or pick an existing directory`)
      }
      throw error
    }
    if (!info.isDirectory) throw new Error(`remote path is not a directory: ${normalized}`)
    throwIfAborted(signal)
    // Store the path the host names this directory. A symlink and its target
    // are one workspace, so a later `cd .` realpath matches the stored row.
    // A link to `/` is the same refusal as registering `/` itself. If realpath
    // fails after stat succeeded, registration fails with that error. The
    // default title is the real path's basename, which changes when the path
    // was a symlink.
    const resolved = normalizeRemoteDirectory(await withSignal(this.pool.sftpRealpath(host, secret, normalized), signal))
    if (resolved === null) throw new Error(`remote path must be absolute: ${normalized}`)
    if (resolved === '/') throw new Error(`refusing to register "/": a workspace rooted at the remote filesystem root covers every path on ${hostLabel(host)}`)
    const local = mapRemoteToLocal(host.id, resolved)
    if (local === null) throw new Error(`remote path must be absolute: ${resolved}`)
    throwIfAborted(signal)
    // Rows saved before realpath registration still encode the symlink spelling.
    // Comparing that string with this realpath would add a second workspace.
    const existing = await this.findRegisteredWorkspace(host, secret, resolved, signal)
    if (existing !== undefined) {
      return { path: existing.placeholderPath, remotePath: existing.remotePath, title: existing.title, created: false }
    }
    await mkdir(local, { recursive: true })
    const requested = title?.trim() || posix.basename(resolved) || resolved
    const nextTitle = createdWorkspaceTitle(host, requested, this.taggingEnabled)
    const workspace = await this.workspaces.create(local, nextTitle)
    // `create` keeps an existing record's title; only a new row carries ours.
    return { path: workspace.path, remotePath: resolved, title: workspace.title, created: true }
  }

  /**
   * A workspace this host already has for `resolved`.
   *
   * The stored remote path is whatever was encoded at registration. A later
   * realpath of that spelling is the same directory, including a trailing-slash
   * variant that `normalizeRemoteDirectory` already collapsed.
   */
  private async findRegisteredWorkspace(host: HostConfig, secret: SecretMaterial, resolved: string, signal?: AbortSignal): Promise<RemoteWorkspaceView | undefined> {
    const rows = this.listWorkspaces().filter(row => row.hostId === host.id)
    const direct = rows.find(row => normalizeRemoteDirectory(row.remotePath) === resolved)
    if (direct !== undefined) return direct
    for (const row of rows) {
      const spelled = normalizeRemoteDirectory(row.remotePath)
      if (spelled === null || spelled === resolved) continue
      try {
        const real = normalizeRemoteDirectory(await withSignal(this.pool.sftpRealpath(host, secret, spelled), signal))
        if (real === resolved) return row
      } catch {
        // The stored spelling is gone. It is not this directory.
      }
    }
    return undefined
  }

  /**
   * Whether this session may route `route` to the host.
   *
   * A workspace row does not qualify. Only a header already on that host does:
   * the session was opened from that machine's workspace. A leftover
   * placeholder under a local header is not enough. An opened session may
   * `cd /etc` on that host. Routing cannot cross hosts.
   */
  allowsRemoteCwd(route: RemoteRoute, headerCwd: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
    const registry = this.workspaces as WorkspaceRegistryLike | undefined
    // A host build without the registry cannot be checked; keep the old routing.
    if (registry === undefined) return true
    const opened = routeByCwd(headerCwd, env)
    return opened.kind === 'remote' && opened.hostId === route.hostId
  }

  toolHost(jobs: ToolHost['jobs']): ToolHost {
    return {
      pool: this.pool,
      hostOf: id => this.config.hosts.find(item => item.id === id),
      secretOf: host => this.secret(host),
      statusOf: host => this.probe(host.id),
      createWorkspace: (host, remotePath, title, signal) => this.registerWorkspace(host, remotePath, title, signal),
      resolveMode: buildResolveMode(this.ctx),
      loginEnvOf: (host, signal) => this.loginEnvs.get(host.id, signal),
      jobs,
    }
  }

  /** Read startup files once. A cancelled read is not stored; a timeout is stored as empty. */
  private async readLoginEnv(hostId: string, signal?: AbortSignal): Promise<LoginEnvRead> {
    const host = this.requireHost(hostId)
    const result = await this.pool.exec(host, await this.secret(host), loginEnvCaptureCommand(), LOGIN_ENV_CAPTURE_MS, signal)
    if (signal?.aborted === true) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    return { stdout: result.stdout, timedOut: result.timedOut, stdoutTruncated: result.stdoutTruncated }
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
  const methods = ['testConnection', 'trustFingerprint', 'probe', 'installDeps', 'installRipgrep', 'listDir', 'createDir', 'createWorkspace', 'listWorkspaces', 'tagWorkspaces', 'removeWorkspace', 'restoreHost', 'purgeHost', 'saveSecret', 'saveHost', 'refreshLoginEnv', 'deleteHost', 'remoteRootInfo', 'changeRemoteRoot', 'exportHosts', 'importHosts']
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

/**
 * Remote implementations of the routed file and shell tools.
 *
 * `working_directory` and `present` are dispatched before this table: the first
 * commits a directory through the official service, the second stages files and
 * delegates to the official tool, so neither has a runner of its own.
 */
const RUNNERS: Record<Exclude<RoutedToolName, 'working_directory' | 'present'>, (host: ToolHost, route: NonNullable<ReturnType<typeof routeByCwd> & { kind: 'remote' }>, args: Record<string, unknown>, exec: ToolExec, ctx: HostContext) => Promise<unknown>> = {
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
  // A local PTY backend would open a shell inside the placeholder directory
  // while the sidebar terminal is already on the server. Refuse instead of
  // handing the model a prompt that is not where the Session is.
  terminal_open: async () => {
    throw new Error(TERMINAL_OPEN_REFUSED)
  },
}

export function apply(rawCtx: Context, rawConfig?: unknown): void {
  const ctx = rawCtx as unknown as HostContext
  const core = new Core(ctx, readConfig(rawConfig), ctx.workspaceRegistry)
  // A fresh load starts with no superseded roots: a leftover from a previous
  // plugin instance would make an unrelated directory look like a placeholder.
  clearSupersededRoots()
  core.applyRemoteRootOverride()
  ctx.effect(() => ctx.on('settings/document-updated', ns => core.onSettingsUpdated(ns)))
  const api = new SshApi(rawCtx, core)
  const unregisters = new Set<() => void>()
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  ctx.effect(() => () => {
    // One agent disposer must not skip the remaining agents or the pool.
    const failure = settleDisposers([...unregisters])
    unregisters.clear()
    if (failure !== undefined) {
      ctx.logger?.warn(`[@dsh-permission-remote] plugin cleanup failed: ${errorText(failure)}`)
    }
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
    } catch (error) {
      throw error
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

/**
 * Refuse to put a session on a host it did not open.
 *
 * Routing a cwd to the remote only proves the placeholder directory exists, and
 * DSH keeps that directory when a workspace registration is deleted. A registry
 * row is not permission. Only a header already on that host allows entry.
 * The placeholder path is omitted. Naming it would hand the session the path
 * it would have to pass to enter.
 */
function assertEnterableRemoteCwd(core: Core, route: RemoteRoute, headerCwd: string | undefined): void {
  if (core.allowsRemoteCwd(route, headerCwd)) return
  throw new Error(`refusing to use ${route.remoteCwd} on SSH host ${route.hostId}: this session was not opened on that host. Open the workspace from the list.`)
}

/** The confirmed remote directory, checked again because realpath follows links. */
function assertResolvedRemoteCwd(core: Core, hostId: string, remotePath: string, headerCwd: string | undefined): void {
  const local = mapRemoteToLocal(hostId, remotePath)
  if (local === null) throw new Error('remote directory cannot be mapped to a workspace path')
  const mapped = routeByCwd(local)
  if (mapped.kind !== 'remote' || mapped.hostId !== hostId) {
    throw new Error('remote directory cannot be mapped to a workspace path')
  }
  assertEnterableRemoteCwd(core, { kind: 'remote', hostId, remoteCwd: remotePath, placeholderCwd: local }, headerCwd)
}

/**
 * Refuse a remote `cd` whose target is on a host this session did not open.
 * The realpath check repeats this after links are followed, before the directory is committed.
 */
function assertRemoteWorkingDirectoryTarget(core: Core, route: RemoteRoute, args: Record<string, unknown>, headerCwd: string | undefined): void {
  const requested = typeof args.cd === 'string' ? args.cd.trim() : ''
  if (requested.length === 0) return
  assertResolvedRemoteCwd(core, route.hostId, resolveRemotePath(requested, route.remoteCwd, route.placeholderCwd), headerCwd)
}

/** Confirm the remote directory, then commit its placeholder. Both checks happen before the commit. */
function commitRemoteWorkingDirectory(
  core: Core,
  ctx: HostContext,
  host: ToolHost,
  route: RemoteRoute,
  args: Record<string, unknown>,
  exec: ToolExec,
  headerCwd: string | undefined,
): Promise<unknown> {
  assertRemoteWorkingDirectoryTarget(core, route, args, headerCwd)
  return runWorkingDirectory(host, route, args, exec, async directory => {
    const directories = ctx.get('workingDirectory') as { set(agent: object, path: string, signal?: AbortSignal): Promise<string> } | undefined
    if (directories === undefined || exec.agent === undefined) throw new Error('working_directory requires an agent Session')
    return directories.set(exec.agent, directory, exec.signal)
  }, remote => {
    assertResolvedRemoteCwd(core, route.hostId, remote, headerCwd)
  })
}

/**
 * Deliver remote files by staging them where the official `present` can see them.
 *
 * `present` is not a filesystem tool that can be reimplemented remotely: DSH
 * checks `fs.lstat`/`fs.stat` for each path and then records an event the card
 * opens through the same local filesystem. Both run on this computer, so a
 * remote session's delivery has to leave a real file at a local path. The
 * placeholder path is exactly that: the local backend can `stat` it and the
 * card can open it.
 *
 * The copies are written first, then the official tool runs with the staged
 * placeholder paths. Substituting them, rather than replaying the model's
 * spelling, is what makes every accepted form work: a relative path, a
 * placeholder path, and a real remote absolute path (`/home/me/out.pdf`,
 * which bash can also use) are three spellings of one remote file. One failed
 * copy refuses the whole call, so a partial delivery never reaches the log.
 *
 * The one behaviour that is not the official one: this rewrites the placeholder
 * copy on every delivery. The event stores only the path, so the card shows
 * whatever is there now — rewriting keeps a second delivery of an updated file
 * showing current content instead of the first version.
 */
async function runPresent(
  official: ((value: unknown, execution: ToolExec) => Promise<unknown>) | undefined,
  host: ToolHost,
  route: RemoteRoute,
  args: Record<string, unknown>,
  exec: ToolExec,
): Promise<unknown> {
  if (official === undefined) throw new Error('dsh-permission-remote: present is not mounted in this session')
  const requested = Array.isArray(args.files) ? args.files : []
  // No files means nothing to stage; hand it to the official tool, whose own
  // "accepts 1 to N files" refusal already covers an empty or malformed list.
  if (requested.length === 0) return official(args, exec)
  const files = requested.map(file => {
    const record = file as { path?: unknown }
    if (typeof record.path !== 'string') throw new FsError('Cannot present a file: each entry needs a string path', 'FS_NOT_FOUND')
    return { path: record.path }
  })
  const staged = await stagePresentFiles(host, route, files, exec)
  // Replace each path with the staged one and keep every other field, so a
  // description survives. The lists always line up: staging returns one entry
  // per requested file or throws.
  const presented = requested.map((file, index) => ({ ...(file as Record<string, unknown>), path: staged[index]!.path }))
  return official({ ...args, files: presented }, exec)
}

interface CanonicalFs {
  resolve(path: string, opts?: { cwd?: string, signal?: AbortSignal }): Promise<unknown>
  processPath(target: unknown): string
}

function canonicalFs(ctx: HostContext): CanonicalFs | undefined {
  const fs = ctx.get('fs') as Partial<CanonicalFs> | undefined
  if (typeof fs?.resolve !== 'function' || typeof fs.processPath !== 'function') return undefined
  return fs as CanonicalFs
}

/**
 * A local `working_directory` call must not step into a placeholder by accident.
 *
 * The official service follows symlinks before it commits, so the lexical path
 * is not the path that lands in the session. Refuse the path that would be
 * committed, before the official tool runs. Without `fs` a local spelling can
 * still be a symlink into a placeholder, and the official tool would commit
 * that target. Refuse those calls. A path that is already a placeholder is
 * checked as itself.
 */
async function assertLocalWorkingDirectory(
  core: Core,
  args: Record<string, unknown>,
  current: string | undefined,
  headerCwd: string | undefined,
  fs: CanonicalFs | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const requested = typeof args.cd === 'string' ? args.cd.trim() : ''
  if (requested.length === 0 || current === undefined) return
  const lexical = resolveLocalPath(current, requested)
  if (fs === undefined) {
    const lexicalRoute = routeByCwd(lexical)
    if (lexicalRoute.kind === 'remote') {
      assertEnterableRemoteCwd(core, lexicalRoute, headerCwd)
      return
    }
    throw new Error('refusing to change directory: the filesystem service is unavailable, so a symlink into a remote workspace cannot be checked')
  }
  let canonical: string
  try {
    canonical = fs.processPath(await fs.resolve(requested, { cwd: current, signal }))
  } catch (error) {
    if (signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw error
    // The official tool reports a missing local directory. A lexical
    // placeholder is still refused here, so a failed resolve cannot skip it.
    const lexicalRoute = routeByCwd(lexical)
    if (lexicalRoute.kind === 'remote') assertEnterableRemoteCwd(core, lexicalRoute, headerCwd)
    return
  }
  const route = routeByCwd(canonical)
  if (route.kind === 'remote') assertEnterableRemoteCwd(core, route, headerCwd)
}

function installShadows(ctx: HostContext, core: Core, agent: AgentLike, unregisters: Set<() => void>, forget: () => void): boolean {
  const headerCwd = agent.session?.header?.cwd
  // Seed events do not emit `session/event`. The live directory, not the
  // original project in `header.cwd`, decides the first shell surface.
  const opened = routeByCwd(effectiveCwd(ctx, { agent }, headerCwd))
  const disposers: Array<() => void> = []
  let disposeDynamic = (): void => {}
  try {
    const plans = planShadows(name => agent.ctx.tools.get(name, agent))
    const hasOfficialBash = plans.some(plan => plan.name === 'bash' && plan.official !== undefined)
    const host = core.toolHost(agent.ctx.get('jobs') as ToolHost['jobs'])
    for (const plan of plans) {
      // A preset with no bash used to register the fallback here for the
      // agent's whole life. That wrapper stays after the session returns to
      // a local directory and then throws. The dynamic shell surface owns it.
      if (plan.official === undefined) continue
      const official = plan.official
      const base = capturedSchema(agent.ctx.tools, plan.name, agent) as Record<string, unknown>
      const definition: Record<string, unknown> = {
        ...base,
        name: plan.name,
        async execute(args: unknown, exec: ToolExec) {
          const cwd = effectiveCwd(ctx, exec, headerCwd)
          const current = routeByCwd(cwd)
          const record = args as Record<string, unknown>
          if (current.kind !== 'remote') {
            if (plan.name === 'working_directory') await assertLocalWorkingDirectory(core, record, cwd, headerCwd, canonicalFs(ctx), exec.signal)
            return dispatchShadow(official as ((value: unknown, execution: ToolExec) => Promise<unknown>) | undefined, false, async () => {
              throw new Error('dsh-permission-remote: local call has no official tool')
            }, args, exec)
          }
          assertEnterableRemoteCwd(core, current, headerCwd)
          if (plan.name === 'working_directory') return commitRemoteWorkingDirectory(core, ctx, host, current, record, exec, headerCwd)
          if (plan.name === 'present') return runPresent(official as ((value: unknown, execution: ToolExec) => Promise<unknown>) | undefined, host, current, record, exec)
          return RUNNERS[plan.name](host, current, record, exec, ctx)
        },
      }
      if (plan.name === 'working_directory') definition.output = workingDirectoryOutput(base.output)
      disposers.push(agent.ctx.tools.register(withRemoteTimeout(definition)))
    }
    const surface = installRemoteShellSurface(ctx, core, agent, host, headerCwd, hasOfficialBash, disposers)
    disposeDynamic = surface.disposeDynamic
    surface.sync(opened)
  } catch (error) {
    const cleanup = releaseShadows(disposeDynamic, disposers)
    ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed for agent ${agentLabel(agent)}: ${errorText(error)}`)
    if (cleanup !== undefined) {
      ctx.logger?.warn(`[@dsh-permission-remote] shadow cleanup failed for agent ${agentLabel(agent)}: ${errorText(cleanup)}`)
    }
    if (opened.kind === 'remote') throw error
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
    // Mark dropped before disposing so a second unload does not start again.
    // Each disposer still runs: one throw must not leave the guard or the
    // schema filter attached, or leave this agent in `seen`.
    const failure = releaseShadows(disposeDynamic, disposers)
    unregisters.delete(drop)
    try {
      forget()
    } catch (error) {
      ctx.logger?.warn(`[@dsh-permission-remote] shadow cleanup failed for agent ${agentLabel(agent)}: ${errorText(error)}`)
    }
    if (failure !== undefined) {
      ctx.logger?.warn(`[@dsh-permission-remote] shadow cleanup failed for agent ${agentLabel(agent)}: ${errorText(failure)}`)
    }
  }
  unregisters.add(drop)
  try {
    agent.ctx.effect(() => drop)
  } catch (error) {
    drop()
    ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed for agent ${agentLabel(agent)}: ${error instanceof Error ? error.message : String(error)}`)
    if (opened.kind === 'remote') throw error
    return false
  }
  return true
}

/**
 * Permanent pieces follow the agent. The dynamic pieces are replaced together
 * when the cwd enters or leaves a remote workspace, because a same-scope
 * `tool:pwsh` cannot be registered twice and a bash fallback with no official
 * tool must not outlive the remote cwd.
 */
function installRemoteShellSurface(
  ctx: HostContext,
  core: Core,
  agent: AgentLike,
  host: ToolHost,
  headerCwd: string | undefined,
  hasOfficialBash: boolean,
  disposers: Array<() => void>,
): { sync(route: Route): void, disposeDynamic(): void } {
  const dynamic: Array<() => void> = []
  let applied: Route = { kind: 'local' }
  const currentRoute = (): Route => routeByCwd(effectiveCwd(ctx, { agent }, headerCwd))
  const remoteNow = (): boolean => currentRoute().kind === 'remote'
  const disposeDynamic = (): void => {
    const current = dynamic.splice(0, dynamic.length)
    let failure: unknown
    for (let index = current.length - 1; index >= 0; index -= 1) {
      try {
        current[index]!()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
  }
  const applyDynamic = (route: Route): void => {
    const plan = shellSurfacePlan(route, hasOfficialBash)
    const added: Array<() => void> = []
    try {
      for (const name of plan.deny) {
        try {
          added.push(agent.ctx.tools.restrict({ deny: [name] }))
        } catch (error) {
          if (!isUnknownRestrictError(error)) throw error
        }
      }
      if (plan.shadowPwshPrompt) {
        added.push(agent.ctx.systemPrompt.section({
          name: PWSH_SECTION,
          order: agent.ctx.systemPrompt.getSectionOrder('TOOL_PWSH'),
          text: '',
        }))
      }
      if (plan.bashFallback) {
        added.push(agent.ctx.tools.register(withRemoteTimeout({
          ...fallbackSchema('bash'),
          name: 'bash',
          async execute(args: unknown, exec: ToolExec) {
            const current = routeByCwd(effectiveCwd(ctx, exec, headerCwd))
            if (current.kind === 'remote') assertEnterableRemoteCwd(core, current, headerCwd)
            if (current.kind !== 'remote') {
              return dispatchShadow(undefined, false, async () => {
                throw new Error('dsh-permission-remote: local call has no official tool')
              }, args, exec)
            }
            return RUNNERS.bash(host, current, args as Record<string, unknown>, exec, ctx)
          },
        })))
      }
    } catch (error) {
      for (let index = added.length - 1; index >= 0; index -= 1) {
        try {
          added[index]!()
        } catch {
          // A disposer failure must not hide the restrict or section error.
        }
      }
      throw error
    }
    dynamic.push(...added)
  }
  const sync = (route: Route): void => {
    const next = shellSurfacePlan(route, hasOfficialBash)
    if (sameShellSurface(next, shellSurfacePlan(applied, hasOfficialBash))) {
      applied = route
      return
    }
    // Detach first. The next `tool:pwsh` cannot share this scope with the
    // one still registered. A failed enter restores the previous set. A
    // failed leave does not: the directory change is already committed, and
    // putting the remote bash fallback back would hide the local shells.
    const previous = applied
    let removed = false
    try {
      disposeDynamic()
      removed = true
      applyDynamic(route)
      applied = route
    } catch (error) {
      if (!removed || route.kind !== 'remote') {
        applied = { kind: 'local' }
        throw error
      }
      try {
        disposeDynamic()
        applyDynamic(previous)
        applied = previous
      } catch {
        applied = { kind: 'local' }
      }
      throw error
    }
  }

  disposers.push(agent.ctx.tools.guard(execution => {
    if (!isWindowsShell(execution.name)) return undefined
    return windowsShellGuardReason(routeByCwd(effectiveCwd(ctx, execution, headerCwd)).kind === 'remote')
  }))
  disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    // Preset assembly passes the agent object as `scope`. Another agent's
    // assembly must not be filtered by this session's directory.
    if (context.scope !== undefined && context.scope !== agent) return assembled
    if (!remoteNow()) return assembled
    return { ...assembled, tools: withoutWindowsShells(assembled.tools, true) }
  }))
  // Official `tool:bash` stays. This section is empty on a local cwd, so
  // renderPrompt drops it. `complete: true` personas replace sections after
  // the waterfall; the schema filter above still runs on `assembly.tools`.
  disposers.push(agent.ctx.systemPrompt.section({
    name: REMOTE_POSIX_SECTION,
    order: agent.ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 5,
    text: () => remotePosixPrompt(remoteNow()),
  }))
  // A required runtime context, not a prompt section: it sits beside
  // `Current working directory` in the same per-turn snapshot, survives a
  // complete persona (which only collapses sections), and changes only the
  // snapshot — never the system-prompt prefix — when the directory changes.
  // Guard the call so a host whose systemPrompt predates the context API (or
  // lacks the WORKING_DIRECTORY placement) still installs the remote shell
  // surface: the feature degrades, the agent works.
  const contextOrder = typeof agent.ctx.systemPrompt.getContextOrder === 'function'
    ? agent.ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY')
    : undefined
  if (typeof agent.ctx.systemPrompt.context === 'function'
    && typeof contextOrder === 'number' && Number.isFinite(contextOrder)) {
    disposers.push(agent.ctx.systemPrompt.context({
      name: REMOTE_WORKSPACE_CONTEXT,
      order: contextOrder + 1,
      required: true,
      interpolate: false,
      text: () => remoteWorkspaceContextText(currentRoute()),
    }))
  }
  disposers.push(agent.ctx.on('session/event', (_session, event) => {
    if (event.type !== 'working-directory/change') return
    if (typeof event.data?.cwd !== 'string') return
    const route = routeByCwd(event.data.cwd)
    try {
      sync(route)
    } catch (error) {
      const remoteMounted = shellSurfacePlan(applied, hasOfficialBash).remote
      if (route.kind === 'remote' && !remoteMounted) {
        const bash = hasOfficialBash
          ? 'The preset bash tool is still registered.'
          : 'No bash tool was registered.'
        ctx.logger?.warn(`[@dsh-permission-remote] remote shell surface was not mounted for agent ${agentLabel(agent)}: ${errorText(error)}. Windows shells stay off the native tool list and cannot run. ${bash} A later working-directory change retries.`)
        return
      }
      ctx.logger?.warn(`[@dsh-permission-remote] shell surface sync failed for agent ${agentLabel(agent)}: ${errorText(error)}`)
    }
  }))
  return { sync, disposeDynamic }
}

/** Flattened relocation numbers for a `RemoteRootChange` result. */
function summaryCounts(summary: SessionRelocationSummary): {
  sessionsRelocated: number
  sessionsSkippedLive: number
  sessionsFailed: number
} {
  return {
    sessionsRelocated: summary.relocated.length,
    sessionsSkippedLive: summary.skippedLive.length,
    sessionsFailed: summary.failed.length,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Run every disposer. The first failure is returned after the rest finish. */
function settleDisposers(disposers: ReadonlyArray<() => void>): unknown {
  let failure: unknown
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    try {
      disposers[index]!()
    } catch (error) {
      failure ??= error
    }
  }
  return failure
}

function releaseShadows(disposeDynamic: () => void, disposers: Array<() => void>): unknown {
  let failure: unknown
  try {
    disposeDynamic()
  } catch (error) {
    failure = error
  }
  const permanent = settleDisposers(disposers)
  return failure ?? permanent
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

function capturedSchema(tools: HostContext['tools'], toolName: string, agent: object): object {
  const official = tools.get(toolName, agent)
  if (official === undefined) return fallbackSchema(toolName)
  const { execute: _execute, ...rest } = official as object & { execute?: unknown }
  return rest
}

const DEFAULT_WORKING_DIRECTORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { cwd: { type: 'string', description: 'Current absolute working directory.' } },
  required: ['cwd'],
}

/**
 * The official `{ cwd }` output with an added optional `remote`. Keeping
 * `remote` optional lets an old `{ cwd }` record validate; `render` falls back
 * to the single cwd line for a local call that carries no remote directory.
 */
function workingDirectoryOutput(official: unknown): object {
  const base = (official ?? {}) as { schema?: Record<string, unknown>, render?: unknown }
  const schema = (base.schema ?? DEFAULT_WORKING_DIRECTORY_SCHEMA) as Record<string, unknown> & { properties?: Record<string, unknown> }
  return {
    ...base,
    schema: {
      ...schema,
      properties: {
        ...(schema.properties ?? {}),
        remote: { type: 'string', description: 'The real directory on the SSH host that this placeholder path maps to.' },
      },
    },
    render: (_args: unknown, value: { cwd?: unknown, remote?: unknown }) => [{
      type: 'text',
      text: typeof value?.remote === 'string' && value.remote.length > 0
        ? `${String(value.cwd)}\n(remote: ${value.remote})`
        : String(value?.cwd ?? ''),
    }],
  }
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
      description: 'List the configured SSH hosts for ops on another machine: id, name, address, user, ops policy, and whether the host key is trusted. Call this before ssh_exec, ssh_read, ssh_write, or ssh_workspace when you do not know the host id or name. Policy "ask" allows reads but needs danger-full-access for commands, writes, and workspace registration, so pass sandbox_permissions "danger-full-access" and a justification; "trust" runs without a prompt; "deny" accepts nothing. An untrusted host must be trusted in Settings → SSH hosts first.',
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
      name: 'ssh_workspace',
      description: 'Add a workspace for an existing SSH host: register one remote directory as a DSH workspace. Opening that workspace from the list starts a session on that machine, and file and command tools in that session run there. The directory must already exist and be a directory; create it with ssh_exec first if it does not, and call ssh_hosts when you do not know the host id or name. The filesystem root "/" is refused. This call only adds the sidebar workspace. It does not move the current session, does not return the placeholder, and does not let this session enter that directory. On an "ask" host this needs danger-full-access, because opening the new workspace starts a session on that machine: pass sandbox_permissions "danger-full-access" and a one-sentence justification when the call is denied. Remote files are not modified. The host key must already be trusted in Settings → SSH hosts. The title defaults to the directory name; registering the same directory again keeps the existing row and its title (the result then reports created: false).',
      parameters: {
        host: { type: 'string', required: true, description: 'SSH host id, name, or address from ssh_hosts' },
        directory: { type: 'string', required: true, description: 'Absolute remote directory to register, or a path starting with "~/". "/" is refused' },
        title: { type: 'string', description: 'Sidebar title; defaults to the directory name, prefixed with the server when title tagging is on' },
        ...OPS_ESCALATION,
      },
      output: textOutput(renderSshWorkspace),
      execute(args: unknown, exec: ToolExec) {
        const record = args as Record<string, unknown>
        const host = pick(record)
        return runSshWorkspace(hostApi, host, record, exec)
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
