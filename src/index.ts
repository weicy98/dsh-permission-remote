import { existsSync, realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join as joinPath, posix, resolve as resolveLocalPath, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { FsError, type FsTarget, type FsVersion } from '@deepseek-ai/dsh-fs'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
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
  runGlob,
  runGrep,
  runWorkingDirectory,
  runReadImage,
  clearStagedPresentFiles,
  stagePresentFiles,
  throwIfAborted,
  withSignal,
  type RunnerStatus,
  type ToolExec,
  type ToolHost,
} from './execute.ts'
import { sniffImage } from './image.ts'
import { hostLabel, isRemoteMissing, opsHostView, renderOpsDownload, renderOpsExec, renderOpsRead, renderOpsUpload, renderSshWorkspace, resolveOpsHost, runSshDownload, runSshExec, runSshRead, runSshUpload, runSshWorkspace, runSshWrite, forgetOpsHost, type OpsTransferLimits } from './ops.ts'
import { addSupersededRoot, childDirectoryPath, clearSupersededRoots, defaultRemoteRoot, encodeRemotePath, expandRemoteRoot, isValidHostId, listingPath, mapRemoteToLocal, normalizeRemoteDirectory, remoteRoot, resolveRemotePath, routeByCwd, setRemoteRootOverride, type RemoteRoute, type Route } from './router.ts'
import { relocateSessions, sessionLogExists, type SessionRelocationSummary } from './session-relocate.ts'
import { emptyMigrationState, readMigrationState, writeMigrationState, type MigrationState } from './migration-state.ts'
import { planRemoteRoot, runMigration, type MigrationReport, type MigrationStrategy } from './migrate.ts'
import {
  PWSH_SECTION,
  REMOTE_APPLY_PATCH_PROMPT,
  REMOTE_EDITOR_PROMPT,
  REMOTE_FILE_TOOLS_SECTION,
  REMOTE_POSIX_SECTION,
  REMOTE_WORKSPACE_CONTEXT,
  STR_REPLACE_EDITOR_PATH_REFUSED,
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
import { installRemoteFs, remoteFsInstalled } from './remote-fs.ts'
import { installRemoteUploads } from './uploads.ts'
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
  emit?(event: 'fs/observed', target: FsTarget, observation: { kind: 'present', version: FsVersion }, actor: unknown): void
  on(event: 'agent/created', listener: (payload: { agent: AgentLike }) => void): () => void
  on(event: 'approval/request', listener: (request: ApprovalRequestLike, next: () => Promise<unknown>) => Promise<unknown>): () => void
  /** Fired after any surface writes a settings section (`ns` is its id). */
  on(event: 'settings/document-updated', listener: (ns: unknown, revision: number) => void): () => void
  /**
   * Model-stream waterfall. The listener returns the next iterable; it must not
   * be async, because the bus does not await a promise.
   */
  on(event: 'llm/stream', listener: (
    options: { sessionId?: string, messages?: unknown, signal?: AbortSignal },
    next: () => AsyncIterable<unknown>,
  ) => AsyncIterable<unknown>): () => void
  effect(dispose: () => void): void
  logger?: { info(message: string): void, warn(message: string): void }
}

interface PromptToolsAssembly {
  /**
   * Present up to 0.2.1, where the assembly carried the schema list. 0.2.2
   * moved declarations to providers and merges them after this waterfall, so
   * the object a listener receives may not have the field at all.
   */
  tools?: ReadonlyArray<{ name: string }>
}

interface PromptAssembleContext {
  scope?: object
}

interface AgentContext {
  tools: HostContext['tools'] & {
    restrict(filter: { deny: readonly string[] }): () => void
    guard(guard: (execution: { readonly name: string, readonly arguments?: unknown, readonly agent?: ToolExec['agent'] }) => string | undefined): () => void
  }
  systemPrompt: {
    section(section: { name: string, order: number, text: string | ((context: { scope?: object }) => string), complete?: boolean }): () => void
    getSectionOrder(name: string): number
    context(context: { name: string, order: number, text: string | ((context: unknown) => string), required?: boolean, interpolate?: boolean }): () => void
    getContextOrder(name: string): number
  }
  get(service: string): unknown
  on(event: 'session/event', listener: (session: unknown, event: { type: string, data?: { cwd?: string, callId?: string, name?: string, arguments?: string } }) => void): () => void
  on(event: 'approval/request', listener: (request: ApprovalRequestLike, next: () => Promise<unknown>) => Promise<unknown>): () => void
  on(event: 'system-prompt/assemble', listener: (assembly: PromptToolsAssembly, context: PromptAssembleContext, next: () => Promise<PromptToolsAssembly>) => Promise<PromptToolsAssembly>): () => void
  effect(dispose: () => void): void
}

interface AgentLike {
  ctx: AgentContext
  session?: { header?: { cwd?: string }, id?: string }
}

interface ApprovalRequestLike {
  agent: AgentLike
  toolName: string
  callId?: string
  reason?: string
  displayReason?: { en: string, [locale: string]: string }
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
  /** Migration bookkeeping loaded from its sidecar file; see `migration-state.ts`. */
  private migrationState: MigrationState = emptyMigrationState()
  /** Single-flight load of the sidecar, awaited before any state is mutated. */
  private migrationStateLoaded: Promise<void> | null = null
  /** False when the sidecar exists but could not be read; never overwrite then. */
  private migrationStateWritable = true
  /**
   * Tail of the session-relocation queue.
   *
   * `apply` starts `resumeSessionMigrationState` without awaiting it, and saving
   * the current root again also calls `relocateFromRoots`. Both rename the same
   * session directory; the loser used to record ENOENT as a failed move. A
   * rejection still settles the tail, so one failed sweep cannot wedge the next.
   */
  private relocationTail: Promise<void> = Promise.resolve()

  readonly pool: SshPool
  private config: PluginConfig
  private readonly status = new Map<string, Promise<RunnerStatus>>()
  private readonly shellLists = new Map<string, Promise<SidebarShell[]>>()
  private readonly loginEnvs = new LoginEnvCache((hostId, signal) => this.readLoginEnv(hostId, signal))
  /** Drops realpath, stat, and containment records for one host. The file tree installs this. */
  private readonly remoteTrees = new Set<(hostId: string) => void>()
  /** The first apply installs the configured root; only a later change keeps the previous one routable. */
  private remoteRootApplied = false
  /** tool/call args for the approval-detail bridge, bounded and per session. */
  private readonly toolCalls = new Map<string, { filePath?: string, cwd?: string }>()
  private readonly sessionCwds = new Map<string, string>()

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

  /**
   * Remote roots registered for one host, normalised and de-duplicated.
   *
   * `remote-fs` needs these to decide whether a followed symlink stays inside a
   * workspace. It cannot derive the root from the placeholder spelling: the
   * encoded segment is the whole remote path for an absolute spelling and the
   * workspace root for a relative one.
   */
  workspaceRootsOf(hostId: string): readonly string[] {
    const roots = new Set<string>()
    for (const item of this.listWorkspaces()) {
      if (item.hostId !== hostId) continue
      const normalized = normalizeRemoteDirectory(item.remotePath)
      if (normalized !== null) roots.add(normalized)
    }
    return [...roots]
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
    this.dropRemoteTree(hostId)
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
    this.dropRemoteTree(hostId)
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

  /** Ceiling and deadline for one ssh_upload / ssh_download; `0` means no limit. */
  transferLimits(): OpsTransferLimits {
    return { maxBytes: this.config.transferMaxBytes, timeoutMs: this.config.transferTimeoutMs }
  }

  async trust(hostId: string, fingerprint: string): Promise<void> {
    this.requireHost(hostId)
    this.config.hosts = this.config.hosts.map(item => item.id === hostId ? { ...item, fingerprint } : item)
    this.pool.invalidate(hostId)
    this.status.delete(hostId)
    forgetOpsHost(hostId)
    // A rotated key may belong to a different machine; the cached login
    // environment snapshot came from the previous one's bashrc and must not be
    // eval'd against the new host. (The file tree is deliberately kept: the
    // address did not change, only the key.)
    this.loginEnvs.forget(hostId)
    await this.persistHosts()
  }

  /**
   * Drop everything derived from a connection that no longer applies: the
   * cached probe, the pooled session, the cached remote home, the sidebar
   * shell list, and the file tree's realpath and stat cache. Connecting is
   * interrupted, so an agent command running on that session is killed.
   */
  forgetStatus(hostId: string): void {
    this.status.delete(hostId)
    this.pool.invalidate(hostId)
    forgetOpsHost(hostId)
    this.forgetShells(hostId)
    this.loginEnvs.forget(hostId)
    this.dropRemoteTree(hostId)
  }

  /** The installed file tree forgets one host when its connection is dropped. */
  bindRemoteTree(invalidate: (hostId: string) => void): () => void {
    this.remoteTrees.add(invalidate)
    return () => { this.remoteTrees.delete(invalidate) }
  }

  private dropRemoteTree(hostId: string): void {
    for (const invalidate of this.remoteTrees) {
      try {
        invalidate(hostId)
      } catch (error) {
        this.ctx.logger?.warn(`[@dsh-permission-remote] remote file tree reset failed for ${hostId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
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
    // A new endpoint must never inherit the old machine's password. Delete it
    // before saving; `saveSecret` runs right after `saveHost` and writes the new
    // one only if the operator typed one.
    if (previous !== undefined && connectionKeyChanged(previous, normalized)) {
      await this.dropSecret(host.id)
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
    this.dropRemoteTree(hostId)
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
      if (before !== undefined && connectionKeyChanged(before, host)) await this.dropSecret(host.id)
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
    // The detached resume may still be loading the sidecar; never mutate on the
    // empty placeholder or the load would replace what this call recorded.
    await this.ensureMigrationStateLoaded()
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
      // Saving the root again catches up sessions an earlier migration had to
      // skip because they were open: sweep every root this profile migrated
      // away from onto the current one. A plain no-op save must not scan the
      // store, so this only runs when such a root is actually known.
      const roots = this.catchupRoots(newRoot)
      if (roots.length === 0) return { status: 'unchanged', oldRoot, root: newRoot }
      const relocation = await this.relocateFromRoots(roots, newRoot)
      return { status: 'unchanged', oldRoot, root: newRoot, ...summaryCounts(relocation) }
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
    // Count what is actually open on these placeholders, not only what the
    // registry accounts for: a row this plugin created has an empty `sessionIds`
    // until the next load attaches the moved sessions, so in the window between
    // "migrated" and "restarted" the registry count reads zero and the operator
    // would be migrated again without the confirmation.
    const accounted = opened.reduce((sum, item) => sum + item.ws.sessionIds.length, 0)
    const sessions = Math.max(accounted, this.liveSessionsUnder(opened))
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
    // Record the old root before the settings switch. If the process dies
    // between the settings write and the session relocation, the next load must
    // still know which old root to sweep; a record for a failed switch is
    // harmless because catchup excludes the still-current root.
    if (this.recordSupersededRoot(oldRoot)) await this.persistMigrationState()
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
    // Move the stored sessions onto the new root. Without this a session keeps
    // naming the old root: the workspace registry filters it out of membership
    // (it loses its sidebar group) and the entry guard refuses its cwd (it can
    // no longer be used). Live sessions are skipped and keep routing until the
    // operator closes them and saves again. Membership cannot be restored from
    // this process — the registry caches headers at startup — so the moved ids
    // are persisted and attached on the next plugin load.
    const relocation = await this.relocateStoredSessions(oldRoot, newRoot)
    const pendingAdded = this.recordPendingGrouping(relocation)
    if (pendingAdded) await this.persistMigrationState()
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
   * Roots an earlier migration left behind, for a catch-up sweep onto `current`.
   *
   * Reads both the persisted list (survives a restart) and the in-process one
   * (a root migrated away from in this run), so the "close the session and
   * save again" advice keeps working across restarts too.
   */
  private catchupRoots(current: string): string[] {
    // Only the persisted sidecar drives the sweep. The in-memory router list is
    // kept solely so a stale placeholder keeps routing to its server; it is not
    // a work queue. Reading it here made every later save re-scan an already
    // drained root (it is never removed from memory), while the sidecar is
    // pruned once empty.
    const roots: string[] = []
    const seen = new Set<string>([resolveLocalPath(current)])
    for (const root of this.migrationState.supersededRemoteRoots) {
      const canonical = resolveLocalPath(root)
      if (seen.has(canonical)) continue
      seen.add(canonical)
      roots.push(root)
    }
    return roots
  }

  /**
   * Queue `work` behind any relocation already running on this core.
   * Callers outside the queue use this; the queued body must not call it again.
   */
  private enqueueRelocation<T>(work: () => Promise<T>): Promise<T> {
    const run = this.relocationTail.then(work, work)
    this.relocationTail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Move stored sessions from each of `roots` onto `newRoot`.
   *
   * One pass at a time: the load-time sweep and a save of the same root both
   * enter here, and running them together renames one directory twice.
   */
  private relocateFromRoots(roots: readonly string[], newRoot: string): Promise<SessionRelocationSummary> {
    return this.enqueueRelocation(() => this.relocateFromRootsNow(roots, newRoot))
  }

  /** The body of {@link relocateFromRoots}. Must not enqueue relocation again. */
  private async relocateFromRootsNow(roots: readonly string[], newRoot: string): Promise<SessionRelocationSummary> {
    const summary: SessionRelocationSummary = { relocated: [], skippedLive: [], failed: [] }
    const survivors = new Set<string>()
    let pruned = false
    for (const root of roots) {
      const part = await this.relocateStoredSessions(root, newRoot, true)
      summary.relocated.push(...part.relocated)
      summary.skippedLive.push(...part.skippedLive)
      summary.failed.push(...part.failed)
      if (part.retainedRoots !== undefined && part.retainedRoots.length > 0) {
        summary.retainedRoots = [...(summary.retainedRoots ?? []), ...part.retainedRoots]
      }
      // A root with any remaining session (moved, skipped, or stuck) stays
      // routable and is scanned again next time; an empty one is dropped so a
      // drained migration stops paying for a store scan on every startup. A
      // root whose body still references it must also survive.
      if (part.relocated.length > 0 || part.skippedLive.length > 0 || part.failed.length > 0 || (part.retainedRoots?.length ?? 0) > 0) {
        survivors.add(resolveLocalPath(root))
      } else {
        pruned = true
        // Once, for a directory that is still there: the prune below drops the
        // root, so the next startup does not say this again. A missing directory
        // is the normal end of a migration and stays quiet.
        if (existsSync(root)) {
          this.ctx.logger?.info(`[@dsh-permission-remote] old remote root ${root} is still on disk; the sweep moved, skipped, and failed nothing`)
        }
      }
    }
    if (pruned && this.migrationState.supersededRemoteRoots.length > 0) {
      const scanned = new Set(roots.map(root => resolveLocalPath(root)))
      this.migrationState.supersededRemoteRoots = this.migrationState.supersededRemoteRoots
        .filter(root => !scanned.has(resolveLocalPath(root)) || survivors.has(resolveLocalPath(root)))
    }
    // Only a change (a newly queued membership or a dropped root) needs a
    // write; a sweep that found nothing must not rewrite settings.
    if (this.recordPendingGrouping(summary) || pruned) await this.persistMigrationState()
    return summary
  }

  /**
   * Move every stored session whose header names `oldRoot` onto `newRoot`.
   *
   * Nothing here may fail the migration: the tree copy and the registry switch
   * already succeeded, so a stuck file is collected and reported instead.
   * Membership is deliberately not attached here — the registry caches session
   * headers at startup, so an immediate attach would validate against the
   * stale cwd and throw; {@link resumeSessionMigrationState} retries on the
   * next load with headers rebuilt from disk.
   */
  private async relocateStoredSessions(oldRoot: string, newRoot: string, repairBodies = false): Promise<SessionRelocationSummary> {
    try {
      return await relocateSessions({ oldRoot, newRoot, liveSessionIds: () => this.liveSessionIds(), repairBodies })
    } catch (error) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] could not scan the session store while migrating to ${newRoot}: ${errorText(error)}`)
      // A scan failure is one error, not "every live session was skipped".
      return { relocated: [], skippedLive: [], failed: [{ id: '*', reason: `the session store could not be scanned: ${errorText(error)}` }] }
    }
  }

  /** Open sessions whose recorded cwd sits under one of the given placeholders. */
  private liveSessionsUnder(rows: readonly { ws: WorkspaceLike }[]): number {
    const agents = this.ctx.get('agents') as { list?: () => AgentLike[] } | undefined
    const list = agents?.list?.() ?? []
    if (list.length === 0) return 0
    const roots = rows.map(row => canonicalPath(row.ws.path))
    let count = 0
    for (const agent of list) {
      const cwd = agent.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) continue
      const resolved = canonicalPath(cwd)
      if (roots.some(root => resolved === root || resolved.startsWith(`${root}${sep}`))) count += 1
    }
    return count
  }

  /** Ids of sessions with a live writer; their files must never be moved. */
  private liveSessionIds(): Set<string> {
    const live = new Set<string>()
    const agents = this.ctx.get('agents') as { list?: () => AgentLike[] } | undefined
    for (const agent of agents?.list?.() ?? []) {
      const id = agent.session?.id
      if (typeof id === 'string' && id.length > 0) live.add(id)
    }
    return live
  }

  /** Remember a migrated-away root in the persisted list; true when it was new. */
  private recordSupersededRoot(root: string): boolean {
    const resolved = resolveLocalPath(root)
    if (this.migrationState.supersededRemoteRoots.some(item => resolveLocalPath(item) === resolved)) return false
    this.migrationState.supersededRemoteRoots = [...this.migrationState.supersededRemoteRoots, resolved]
    return true
  }

  /** Queue every moved session for a membership attach on a later load; true when it added one. */
  private recordPendingGrouping(summary: SessionRelocationSummary): boolean {
    // The registry can be unavailable here (a mismatched log elsewhere stops its
    // init). Recording must still work, so fall back to the computed path; the
    // flush resolves it by realpath later, when the registry is up.
    let rows: WorkspaceLike[] | undefined
    try {
      rows = this.workspaces.list()
    } catch {
      rows = undefined
    }
    // Keyed by session id so a second migration (A→B then B→C in one process)
    // overwrites the stale B path instead of leaving the id pointing nowhere.
    const wanted = new Map(this.migrationState.pendingSessionGrouping.map(entry => [entry.id, entry.path]))
    let changed = false
    for (const row of summary.relocated) {
      let path: string
      if (rows !== undefined) {
        // Record the workspace's OWN registered path (already canonical), not
        // the string we computed: with a symlinked root the two differ, and a
        // later attach validates against the registered path. When no workspace
        // covers the destination yet the computed path is kept anyway, so a
        // workspace registered later can still pick the session up.
        const target = rows.find(item => sameRealPath(item.path, row.to))
        path = target !== undefined ? target.path : row.to
      } else {
        path = row.to
      }
      if (wanted.get(row.id) === path) continue
      wanted.set(row.id, path)
      changed = true
    }
    if (changed) this.migrationState.pendingSessionGrouping = [...wanted].map(([id, path]) => ({ path, id }))
    if (summary.failed.length > 0) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] ${summary.failed.length} session(s) could not follow the remote root: ${summary.failed.map(item => `${item.id} (${item.reason})`).join('; ')}`)
    }
    if (summary.skippedLive.length > 0) {
      this.ctx.logger?.info(`[@dsh-permission-remote] left ${summary.skippedLive.length} open session(s) on the old root; closing them and saving the root again moves them`)
    }
    return changed
  }

  /**
   * Persist the migration bookkeeping to its sidecar document.
   *
   * Best-effort: the tree copy and the root switch already succeeded, so a
   * failed write must not turn a completed migration into an apparent failure.
   * The moved session is still correct on disk; losing the bookkeeping only
   * means its group is restored by a later successful sweep.
   */
  private async persistMigrationState(): Promise<void> {
    if (!this.migrationStateWritable) {
      this.ctx.logger?.warn('[@dsh-permission-remote] the migration bookkeeping was not readable this run; leaving the file untouched rather than overwriting it')
      return
    }
    try {
      await writeMigrationState(this.migrationState)
    } catch (error) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] the session migration bookkeeping could not be persisted: ${errorText(error)}`)
    }
  }

  /**
   * Load the sidecar once, before any code path mutates migration state.
   *
   * `resumeSessionMigrationState` runs detached from `apply`, so a "save and
   * migrate" can arrive before the load finishes; both entry points await this
   * single-flight promise, so a mutation never runs on the empty placeholder
   * and the load can never replace already-recorded entries.
   */
  private ensureMigrationStateLoaded(): Promise<void> {
    if (this.migrationStateLoaded === null) this.migrationStateLoaded = this.loadMigrationState()
    return this.migrationStateLoaded
  }

  /** Load the sidecar bookkeeping into this instance (plugin load). */
  private async loadMigrationState(): Promise<void> {
    const { state, problem, readError } = await readMigrationState()
    this.migrationState = state
    // A file that exists but could not be read must not be overwritten: writing
    // the empty fallback would destroy bookkeeping we merely lacked access to.
    this.migrationStateWritable = readError !== true
    if (problem !== undefined) this.ctx.logger?.warn(`[@dsh-permission-remote] ${problem}${readError === true ? '; it will not be overwritten this run' : '; starting from empty bookkeeping'}`)
  }

  /**
   * Resume what an earlier run could not finish, from the plugin load.
   *
   * Restores the persisted superseded roots into the router (a session still
   * on one must be refused as a remote placeholder, not silently treated as a
   * local directory), sweeps them onto the current root, and attaches the
   * sessions that were moved earlier. The registry rebuilds its header index
   * per process, so an attach that had to fail mid-migration succeeds here —
   * that is why the pending list is persisted instead of retried on the spot.
   */
  async resumeSessionMigrationState(): Promise<void> {
    await this.ensureMigrationStateLoaded()
    for (const root of this.migrationState.supersededRemoteRoots) addSupersededRoot(root)
    if (this.migrationState.pendingSessionGrouping.length === 0 && this.migrationState.supersededRemoteRoots.length === 0) return
    // Only sessions queued by an EARLIER load can be attached now: anything the
    // catch-up sweep moves in this load still has the registry's startup header
    // cache, so it must wait for the next load to read the rewritten header.
    const preexisting = new Set(this.migrationState.pendingSessionGrouping.map(entry => entry.id))
    // Wait for the registry first, but only briefly and never as a precondition
    // for the sweep. Two constraints pull in opposite directions:
    //   - the sweep renames directories, and between the rename and the header
    //     promote a log briefly sits where its cwd says it does not; a registry
    //     `list()` running concurrently would reject the whole store, so the
    //     sweep must not overlap a healthy startup;
    //   - a mismatched log is exactly what makes `Service.init` fail, and then
    //     the registry never becomes ready — waiting first without a fallback
    //     would deadlock, because the only thing that can repair the log is the
    //     sweep.
    // So: wait (bounded), sweep regardless of the outcome, flush only if ready.
    const registryReady = await this.waitForWorkspaceRegistry()
    const roots = this.catchupRoots(remoteRoot())
    if (roots.length > 0) {
      try {
        await this.relocateFromRoots(roots, remoteRoot())
      } catch (error) {
        this.ctx.logger?.warn(`[@dsh-permission-remote] the session catch-up sweep failed: ${errorText(error)}`)
      }
    }
    if (registryReady) {
      await this.flushPendingSessionGrouping(preexisting)
    } else {
      this.ctx.logger?.warn('[@dsh-permission-remote] the workspace registry was not ready; session grouping is deferred to the next load (the sweep still ran)')
    }
  }

  /** Poll the workspace registry until it answers, or give up after a short wait. */
  private async waitForWorkspaceRegistry(): Promise<boolean> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        this.workspaces.list()
        return true
      } catch {
        // Any throw here means "not usable yet"; wording differs by version.
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return false
  }

  /**
   * Attach each pending session to the workspace now registered at its path.
   *
   * Success removes the entry; a failure keeps it for the next load (the
   * registry may still be indexing, or the workspace row may have been
   * renamed since). Attaching is idempotent, so a retry after a partial run is
   * safe.
   */
  async flushPendingSessionGrouping(onlyIds?: ReadonlySet<string>): Promise<void> {
    if (this.migrationState.pendingSessionGrouping.length === 0) return
    let rows: WorkspaceLike[]
    try {
      rows = this.workspaces.list()
    } catch {
      // Registry not up yet; leave every entry for a later load.
      return
    }
    const remaining: Array<{ path: string, id: string }> = []
    for (const entry of this.migrationState.pendingSessionGrouping) {
      if (onlyIds !== undefined && !onlyIds.has(entry.id)) {
        remaining.push(entry)
        continue
      }
      const target = rows.find(item => sameRealPath(item.path, entry.path))
      if (target === undefined) {
        // No workspace covers the destination (yet, or any more). Keep the entry
        // while the session log is still there: registering a workspace later
        // groups it, and an operator editing the root in the generic editor
        // (which changes routing but not the files) must not cost the record.
        // Only a session whose log is gone can never be attached.
        if (await sessionLogExists(resolveDshHome(), entry.path, entry.id)) remaining.push(entry)
        continue
      }
      const attach = target.attachSession
      if (attach === undefined) {
        remaining.push(entry)
        continue
      }
      try {
        await attach.call(target, entry.id)
      } catch (error) {
        remaining.push(entry)
        this.ctx.logger?.warn(`[@dsh-permission-remote] session ${entry.id} is at ${entry.path} but could not join its workspace yet: ${errorText(error)}`)
      }
    }
    if (remaining.length !== this.migrationState.pendingSessionGrouping.length) {
      this.migrationState.pendingSessionGrouping = remaining
      await this.persistMigrationState()
    }
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

  /** Record the live cwd and raw tool-call args for approval presentation. */
  rememberSessionEvent(sessionId: string | undefined, event: { type: string, data?: { cwd?: string, callId?: string, name?: string, arguments?: string } }): void {
    if (sessionId === undefined) return
    if (event.type === 'working-directory/change' && typeof event.data?.cwd === 'string') {
      this.sessionCwds.set(sessionId, event.data.cwd)
      if (this.sessionCwds.size > 1024) {
        const oldest = this.sessionCwds.keys().next().value
        if (oldest !== undefined) this.sessionCwds.delete(oldest)
      }
      return
    }
    if (event.type !== 'tool/call' || typeof event.data?.callId !== 'string') return
    const name = event.data.name
    if (name !== 'write' && name !== 'edit' && name !== 'apply_patch' && name !== 'str_replace_editor') return
    let filePath: string | undefined
    const rawArguments = typeof event.data.arguments === 'string' ? event.data.arguments : undefined
    if (rawArguments !== undefined) {
      try {
        const parsed = JSON.parse(rawArguments) as Record<string, unknown>
        if (name === 'str_replace_editor' && typeof parsed.path === 'string') filePath = parsed.path
        else if (name === 'apply_patch' && typeof parsed.input === 'string') filePath = firstPatchPath(parsed.input)
        else if (typeof parsed.file_path === 'string') filePath = parsed.file_path
      } catch {
        // A malformed/truncated argument string only loses presentation detail.
      }
    }
    this.toolCalls.set(`${sessionId}\0${event.data.callId}`, { filePath, cwd: this.sessionCwds.get(sessionId) })
    if (this.toolCalls.size > 1024) {
      const oldest = this.toolCalls.keys().next().value
      if (oldest !== undefined) this.toolCalls.delete(oldest)
    }
  }

  toolCallDetail(sessionId: string | undefined, callId: string | undefined): { filePath?: string, cwd?: string } | undefined {
    if (sessionId === undefined || callId === undefined) return undefined
    return this.toolCalls.get(`${sessionId}\0${callId}`)
  }

  forgetSession(sessionId: string | undefined): void {
    if (sessionId === undefined) return
    this.sessionCwds.delete(sessionId)
    const prefix = `${sessionId}\0`
    for (const key of this.toolCalls.keys()) {
      if (key.startsWith(prefix)) this.toolCalls.delete(key)
    }
  }

  /** Probe data for the fs write path, without exposing the whole Core. */
  async statusOf(host: HostConfig): Promise<RunnerStatus> {
    return this.probe(host.id)
  }

  /**
   * Whether the session that supplied a sandbox policy was opened on `hostId`.
   * A policy without a session cannot prove that boundary, so it is refused.
   */
  allowsRemoteSession(sessionId: string | undefined, hostId: string): boolean {
    if (sessionId === undefined || sessionId.length === 0) return false
    const agents = this.ctx.get('agents') as { list?: () => AgentLike[] } | undefined
    const agent = (agents?.list?.() ?? []).find(item => String(item.session?.id ?? '') === sessionId)
    if (agent === undefined) return false
    return this.allowsRemoteCwd({ kind: 'remote', hostId, remoteCwd: '/', placeholderCwd: '/' }, agent.session?.header?.cwd)
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
const RUNNERS: Record<Exclude<RoutedToolName, 'working_directory' | 'present' | 'str_replace_editor'>, (host: ToolHost, route: NonNullable<ReturnType<typeof routeByCwd> & { kind: 'remote' }>, args: Record<string, unknown>, exec: ToolExec, ctx: HostContext) => Promise<unknown>> = {
  bash: (host, route, args, exec) => runBash(host, route, args, exec),
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

/** First path named by a Codex-style patch, for the approval card only. */
function firstPatchPath(input: string): string | undefined {
  const match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$|^\*\*\* Move to:\s*(.+)$/m.exec(input)
  const value = match?.[1] ?? match?.[2]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * The official write/edit/apply_patch tools own their approval prompts, so the
 * plugin cannot pass host/path detail through `resolveMode` anymore. The
 * approval request event carries the call id; the matching `tool/call` event
 * carries the raw arguments. Enrich only remote mutating prompts; editor has no
 * escalation fields and never sends an approval request.
 */
export function installRemoteApprovalDetail(ctx: AgentContext, core: Core): () => void {
  const register = ctx.on as unknown as (
    event: 'approval/request',
    listener: (request: ApprovalRequestLike, next: () => Promise<unknown>) => Promise<unknown>,
    options?: { prepend?: boolean },
  ) => () => void
  return register('approval/request', async (request, next) => {
    // Only the tools whose escalation runs through FsSandboxController send
    // this request. Return their delegation exactly once; never put `next()`
    // inside the catch below.
    if (request.toolName !== 'write' && request.toolName !== 'edit' && request.toolName !== 'apply_patch') return next()
    try {
      const session = request.agent.session
      const cached = core.toolCallDetail(session?.id, request.callId)
      const cwd = cached?.cwd ?? session?.header?.cwd
      const route = routeByCwd(cwd)
      if (route.kind !== 'remote') return next()
      const requested = cached?.filePath ?? ''
      const host = core.requireHost(route.hostId)
      const label = host.name || host.host || route.hostId
      const path = requested.length > 0 ? resolveRemotePath(requested, route.remoteCwd, route.placeholderCwd) : route.remoteCwd
      const action = request.toolName
      const currentEn = request.displayReason?.en ?? request.reason ?? ''
      const currentZh = request.displayReason?.zh ?? currentEn
      const mutable = request as { displayReason?: { en: string, [locale: string]: string } }
      mutable.displayReason = {
        ...request.displayReason,
        en: currentEn.length > 0 ? `SSH ${label}: ${action} ${path} — ${currentEn}` : `SSH ${label}: ${action} ${path}`,
        zh: currentZh.length > 0 ? `SSH ${label}：${action} ${path} — ${currentZh}` : `SSH ${label}：${action} ${path}`,
      }
    } catch {
      // Approval presentation is best effort; the approval service owns the
      // decision and any error from next().
    }
    return await next()
  }, { prepend: true })
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
  let fsPatchReady = false
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  ctx.effect(() => async () => {
    // One agent disposer must not skip the remaining agents or the pool.
    const failure = settleDisposers([...unregisters])
    unregisters.clear()
    if (failure !== undefined) {
      ctx.logger?.warn(`[@dsh-permission-remote] plugin cleanup failed: ${errorText(failure)}`)
    }
    // Delivery copies live in the placeholder tree and a card may still name
    // them, so this is the only safe moment to remove them. The disposer is
    // async so Cordis waits for the files to disappear before the pool closes.
    await clearStagedPresentFiles()
    await core.pool.dispose()
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
  // Sidebar listing, office preview, and markdown images all read ctx.fs at the
  // placeholder path. Uploads are copied before that stream's first pull.
  // `fs` is not in this plugin's inject list. A get() here runs before that
  // service is active and returns nothing, and the install would not retry.
  rawCtx.inject(['fs'], bridged => {
    const ready = bridged as unknown as HostContext
    const removeFs = installRemoteFs(ready, core)
    fsPatchReady = removeFs !== undefined || remoteFsInstalled(ready)
    const removeUploads = installRemoteUploads(ready, core)
    const unbinds: Array<() => void> = []
    if (removeFs !== undefined) {
      unregisters.add(removeFs)
      const unbind = core.bindRemoteTree(hostId => removeFs.invalidateHost(hostId))
      unbinds.push(unbind)
      unregisters.add(unbind)
    }
    if (removeUploads !== undefined) {
      unregisters.add(removeUploads)
      const unbind = core.bindRemoteTree(hostId => removeUploads.invalidateHost(hostId))
      unbinds.push(unbind)
      unregisters.add(unbind)
    }
    bridged.effect(() => () => {
      removeFs?.()
      removeUploads?.()
      for (const unbind of unbinds) unbind()
      if (removeFs !== undefined) unregisters.delete(removeFs)
      if (removeUploads !== undefined) unregisters.delete(removeUploads)
      for (const unbind of unbinds) unregisters.delete(unbind)
    })
  })
  void api

  const seen = new Set<AgentLike>()
  const denied = new Map<AgentLike, () => void>()
  const disarmRemoteDeny = (agent: AgentLike) => {
    const remove = denied.get(agent)
    if (remove === undefined) return
    remove()
  }
  const armRemoteDeny = (agent: AgentLike) => {
    if (denied.has(agent)) return
    let removeGuard: (() => void) | undefined
    try {
      removeGuard = agent.ctx.tools.guard(() => REMOTE_SURFACE_UNMOUNTED)
    } catch (error) {
      ctx.logger?.warn(`[@dsh-permission-remote] remote tools stay unmounted and local tools could not be denied for agent ${agentLabel(agent)}: ${errorText(error)}`)
      return
    }
    let dropped = false
    const drop = () => {
      if (dropped) return
      dropped = true
      denied.delete(agent)
      unregisters.delete(drop)
      try {
        removeGuard?.()
      } catch (error) {
        ctx.logger?.warn(`[@dsh-permission-remote] remote deny guard removal failed for agent ${agentLabel(agent)}: ${errorText(error)}`)
      }
    }
    denied.set(agent, drop)
    unregisters.add(drop)
    // Plugin unload runs `unregisters`. That does not run when only this agent
    // is destroyed, and `denied` would keep the agent alive.
    try {
      agent.ctx.effect(() => drop)
    } catch (error) {
      ctx.logger?.warn(`[@dsh-permission-remote] remote deny guard is not tied to agent ${agentLabel(agent)}: ${errorText(error)}`)
    }
  }
  const attach = (agent: AgentLike) => {
    if (seen.has(agent)) return
    seen.add(agent)
    let installed = false
    try {
      installed = installShadows(ctx, core, agent, unregisters, () => { seen.delete(agent) }, () => fsPatchReady)
    } catch (error) {
      // Shadows did not register. A remote session would otherwise keep the
      // official tools and run them in the placeholder directory.
      if (!installed && sessionIsRemote(ctx, agent)) armRemoteDeny(agent)
      throw error
    } finally {
      if (!installed) seen.delete(agent)
    }
    disarmRemoteDeny(agent)
  }
  ctx.on('agent/created', ({ agent }) => attach(agent))
  const agents = ctx.get('agents') as { list?: () => AgentLike[] } | undefined
  if (typeof agents?.list === 'function') {
    // These agents predate this plugin load, so each one is already running
    // somewhere. One agent whose shadows cannot mount must not abort the sweep:
    // a throw out of `apply` fails the plugin load, and then NO session gets
    // the remote surface. A remote agent that cannot arm is denied every tool
    // call until a later install succeeds. A local failure still leaves the
    // official tools. New agents keep fail-closed creation through the listener
    // above. The next plugin load retries an agent that did not arm.
    for (const agent of agents.list()) {
      try {
        attach(agent)
      } catch (error) {
        ctx.logger?.warn(`[@dsh-permission-remote] shadow install failed for agent ${agentLabel(agent)}: ${errorText(error)}`)
      }
    }
  }
  void core.autoTagWorkspaces().catch(error => {
    ctx.logger?.warn(`[@dsh-permission-remote] workspace title tagging failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  // Resume what an earlier root migration could not finish: sweep sessions
  // still on a persisted old root and restore the workspace groups that had to
  // wait for this load. Runs after load so a failure cannot block the plugin.
  void core.resumeSessionMigrationState().catch(error => {
    ctx.logger?.warn(`[@dsh-permission-remote] could not resume the session migration state: ${error instanceof Error ? error.message : String(error)}`)
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

/**
 * Map a bare absolute path in a remote session onto the placeholder spelling
 * of the same host. `str_replace_editor` requires absolute paths, but its
 * official `resolveTarget` calls `ctx.fs.resolve(path, { signal })` with no
 * cwd: without this rewrite a remote real absolute path would resolve against
 * this computer's filesystem. Placeholder paths are already remote and pass
 * through untouched; relative paths are rejected by the official tool itself.
 * A mapping failure fails closed instead of handing the path back to the local
 * provider.
 */
function rewriteRemoteEditorArgs(current: RemoteRoute, args: Record<string, unknown>): Record<string, unknown> {
  const requested = args.path
  // Both spellings matter: on a Windows host a `C:\...` path is absolute for
  // the local provider but cannot name a file on a POSIX remote host.
  if (typeof requested !== 'string' || !(isAbsolute(requested) || posix.isAbsolute(requested))) return args
  if (routeByCwd(requested).kind === 'remote') return args
  if (!posix.isAbsolute(requested)) {
    throw new Error(`str_replace_editor: "${requested}" is not a usable absolute path in this remote workspace`)
  }
  const remote = normalizeRemoteDirectory(resolveRemotePath(requested, current.remoteCwd, current.placeholderCwd))
  if (remote === null) {
    throw new Error(`str_replace_editor: "${requested}" is not a usable absolute path in this remote workspace`)
  }
  const placeholder = mapRemoteToLocal(current.hostId, remote)
  if (placeholder === null) {
    throw new Error(`str_replace_editor: cannot map "${requested}" onto this remote host`)
  }
  return { ...args, path: placeholder }
}

/** Delegate to the official execute with a path that routes to the remote fs. */
async function runRemoteStrReplaceEditor(
  official: (args: unknown, exec: ToolExec) => Promise<unknown>,
  current: RemoteRoute,
  record: Record<string, unknown>,
  exec: ToolExec,
): Promise<unknown> {
  return official(rewriteRemoteEditorArgs(current, record), exec)
}

function installShadows(ctx: HostContext, core: Core, agent: AgentLike, unregisters: Set<() => void>, forget: () => void, fsReady: () => boolean): boolean {
  const headerCwd = agent.session?.header?.cwd
  // Seed events do not emit `session/event`. The live directory, not the
  // original project in `header.cwd`, decides the first shell surface.
  const opened = routeByCwd(effectiveCwd(ctx, { agent }, headerCwd))
  const disposers: Array<() => void> = []
  let disposeDynamic = (): void => {}
  try {
    const plans = planShadows(name => agent.ctx.tools.get(name, agent))
    disposers.push(installRemoteApprovalDetail(agent.ctx, core))
    const hasOfficialBash = plans.some(plan => plan.name === 'bash' && plan.official !== undefined)
    const editorShadowReady = plans.some(plan => plan.name === 'str_replace_editor' && plan.official !== undefined)
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
          if (plan.name === 'str_replace_editor') return runRemoteStrReplaceEditor(official as (value: unknown, execution: ToolExec) => Promise<unknown>, current, record, exec)
          return RUNNERS[plan.name](host, current, record, exec, ctx)
        },
      }
      if (plan.name === 'working_directory') definition.output = workingDirectoryOutput(base.output)
      if (plan.name === 'str_replace_editor' && typeof base.presentCall === 'function') {
        // The official call card is built from the model's raw arguments, not
        // from the rewritten args we hand to execute. Rewrite there too so the
        // diff card names the placeholder path the other file tools show.
        // Presentation must never fail a call: a path that cannot be mapped
        // falls back to the raw arguments and the card shows what the model sent.
        const officialPresentCall = base.presentCall as (args: Record<string, unknown>) => unknown
        definition.presentCall = (args: Record<string, unknown>) => {
          try {
            const current = routeByCwd(effectiveCwd(ctx, { agent }, headerCwd))
            return officialPresentCall(current.kind === 'remote' ? rewriteRemoteEditorArgs(current, args) : args)
          } catch {
            return officialPresentCall(args)
          }
        }
      }
      disposers.push(agent.ctx.tools.register(withRemoteTimeout(definition)))
    }
    const surface = installRemoteShellSurface(ctx, core, agent, host, headerCwd, hasOfficialBash, disposers, fsReady, editorShadowReady)
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
    core.forgetSession(agent.session?.id)
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
  fsReady: () => boolean,
  editorShadowReady: boolean,
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
    const remote = routeByCwd(effectiveCwd(ctx, execution, headerCwd)).kind === 'remote'
    if (isWindowsShell(execution.name)) return windowsShellGuardReason(remote)
    // Guards run on the model's raw arguments, before the shadow rewrites
    // `args.path`. Refuse a bare absolute path only when no shadow is mounted
    // to do that rewrite; otherwise the official tool would resolve it against
    // this computer's filesystem.
    if (remote && execution.name === 'str_replace_editor' && !editorShadowReady) {
      const raw = execution.arguments
      const requested = typeof raw === 'object' && raw !== null ? (raw as { path?: unknown }).path : undefined
      if (typeof requested === 'string' && (isAbsolute(requested) || posix.isAbsolute(requested)) && routeByCwd(requested).kind !== 'remote') {
        return STR_REPLACE_EDITOR_PATH_REFUSED
      }
    }
    if (!remote || fsReady()) return undefined
    if (FS_SURFACE_TOOLS.has(execution.name)) return REMOTE_FS_UNPATCHED
    return undefined
  }))
  disposers.push(agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    // Preset assembly passes the agent object as `scope`. Another agent's
    // assembly must not be filtered by this session's directory.
    if (context.scope !== undefined && context.scope !== agent) return assembled
    if (!remoteNow()) return assembled
    // Hosts up to 0.2.1 carry the tool schemas in the assembly, so Windows
    // shells can be filtered here. 0.2.2 moved declarations to providers and
    // merges them after this waterfall, so there is nothing to filter and the
    // assembly must pass through untouched — reading `tools` there throws, and
    // a throw inside the waterfall rejects the whole prompt assembly. Hiding
    // on that host belongs to `tools.restrict({ deny })` in applyDynamic.
    const declared = (assembled as { tools?: unknown }).tools
    if (!Array.isArray(declared)) return assembled
    return { ...assembled, tools: withoutWindowsShells(declared as ReadonlyArray<{ name: string }>, true) }
  }))
  // Official `tool:bash` stays. This section is empty on a local cwd, so
  // renderPrompt drops it. `complete: true` personas replace sections after
  // the waterfall; on hosts that still ship schemas in the assembly the filter
  // above runs on `assembly.tools`, and on 0.2.2 the executor's tool list is
  // already restricted by `applyDynamic`.
  disposers.push(agent.ctx.systemPrompt.section({
    name: REMOTE_POSIX_SECTION,
    order: agent.ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 5,
    text: () => remotePosixPrompt(remoteNow()),
  }))
  // 0.2.2 publishes apply_patch / str_replace_editor only in custom
  // compositions. The section is empty unless one of them is actually visible,
  // so the guidance never advertises a tool the model cannot call. Hosts that
  // do not know the patch section order fall back to the edit section.
  const fileToolsOrder = ((): number | undefined => {
    for (const name of ['TOOL_APPLY_PATCH', 'TOOL_EDIT']) {
      try {
        const order = agent.ctx.systemPrompt.getSectionOrder(name)
        if (typeof order === 'number' && Number.isFinite(order)) return order + 1
      } catch {
        // An older host does not publish this placement.
      }
    }
    return undefined
  })()
  if (fileToolsOrder !== undefined) {
    disposers.push(agent.ctx.systemPrompt.section({
      name: REMOTE_FILE_TOOLS_SECTION,
      order: fileToolsOrder,
      text: (context?: { scope?: object }) => {
        // A shared section must not describe this agent's remote workspace to
        // another agent whose prompt happens to render the same section.
        if (context?.scope !== undefined && context.scope !== agent) return ''
        if (!remoteNow()) return ''
        const at = context?.scope ?? agent
        const visible = (name: string): boolean => {
          try {
            return agent.ctx.tools.get(name, at) !== undefined
          } catch {
            return false
          }
        }
        // Describe only the tools this composition actually mounts: naming a
        // tool the model cannot call wastes a prompt line and invites a call
        // that fails as unknown.
        return [
          visible('apply_patch') ? REMOTE_APPLY_PATCH_PROMPT : '',
          visible('str_replace_editor') ? REMOTE_EDITOR_PROMPT : '',
        ].filter(text => text.length > 0).join('\n\n')
      },
    }))
  }
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
    core.rememberSessionEvent(agent.session?.id, event)
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

/** The realpath of `path` when it resolves, else its lexical resolve. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolveLocalPath(path)
  }
}

/** Whether two paths name the same directory, canonicalizing symlinks when possible. */
function sameRealPath(left: string, right: string): boolean {
  const canon = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return resolveLocalPath(path)
    }
  }
  return canon(left) === canon(right)
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

/** Returned for every tool while a remote agent has no mounted shadows. */
const REMOTE_SURFACE_UNMOUNTED = 'SSH tools did not mount for this remote workspace, so tool calls are refused'

/** Official file tools would use the local backend if ctx.fs never got the remote patch. */
const REMOTE_FS_UNPATCHED = 'the remote filesystem patch is unavailable, so file tools are refused instead of writing into the local placeholder'

/**
 * Every official tool that reads or mutates through `ctx.fs`.
 *
 * `apply_patch` and `str_replace_editor` are not in the default preset, but a
 * composition that enables either one would otherwise reach the unpatched
 * provider: `apply_patch` calls `patchText`/`deleteFile`/`moveFile`, and
 * `str_replace_editor` calls `writeText`. Naming them here keeps the refusal
 * tied to the capability, not to whichever tools this deployment happens to
 * mount.
 */
const FS_SURFACE_TOOLS: ReadonlySet<string> = new Set([
  'read', 'read_image', 'write', 'edit', 'apply_patch', 'str_replace_editor',
])

function agentLabel(agent: AgentLike): string {
  return agent.session?.id ?? agent.session?.header?.cwd ?? 'unknown'
}

function sessionIsRemote(ctx: HostContext, agent: AgentLike): boolean {
  try {
    return routeByCwd(effectiveCwd(ctx, { agent }, agent.session?.header?.cwd)).kind === 'remote'
  } catch {
    return false
  }
}

const REMOTE_TIMEOUT_DESCRIPTION = 'Timeout in milliseconds. When it expires this remote command is killed. Without a sandbox runner, child processes of the command may keep running on the remote host.'

/**
 * Point one captured schema's `timeoutMs` description at the remote host.
 *
 * The official tools publish `parameters` as JSON Schema (`properties.timeoutMs`),
 * because `defineTool` compiles the declaration before registration; the older
 * bare-field spelling is still honoured so a non-compiled fixture behaves.
 */
function withRemoteTimeout(definition: object): object {
  const parameters = (definition as { parameters?: Record<string, { description?: string }> }).parameters
  if (parameters === undefined) return definition
  const properties = (parameters as { properties?: Record<string, { description?: string }> }).properties
  const timeoutField = properties?.timeoutMs ?? parameters.timeoutMs
  if (timeoutField === undefined) return definition
  const withDescription = { ...timeoutField, description: REMOTE_TIMEOUT_DESCRIPTION }
  if (properties !== undefined) {
    return { ...definition, parameters: { ...parameters, properties: { ...properties, timeoutMs: withDescription } } }
  }
  return { ...definition, parameters: { ...parameters, timeoutMs: withDescription } }
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
  // Read per call, not per registration: a Settings save applies to the next
  // transfer even in a session that is already open.
  const limits = () => core.transferLimits()
  return [publishOpsTool({
      name: 'ssh_hosts',
      description: 'List the configured SSH hosts for ops on another machine: id, name, address, user, ops policy, and whether the host key is trusted. Call this before ssh_exec, ssh_read, ssh_write, ssh_upload, ssh_download, or ssh_workspace when you do not know the host id or name. Policy "ask" allows reads but needs danger-full-access for commands, writes, uploads, downloads, and workspace registration, so pass sandbox_permissions "danger-full-access" and a justification; "trust" runs without a prompt; "deny" accepts nothing. An untrusted host must be trusted in Settings → SSH hosts first.',
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
    }), publishOpsTool({
      name: 'ssh_upload',
      description: 'Copy one local file to a configured SSH host over the SSH connection. This is for ops on a machine that is not your current workspace. local_path is an absolute path on the machine running DSH (not the remote host, and not a placeholder path when the session itself is remote); remote_path is an absolute remote path or starts with "~/". The bytes are written beside the target and renamed with mv -f, so a dropped connection never truncates the original, an existing file keeps its permission bits when the server reports them, and a new file uses the remote umask. The filesystem root "/" is refused, and so is a final symlink, a directory, or a special file (FIFO/device). Single files only; the byte ceiling and timeout come from Settings and 0 means unlimited. On an "ask" host this needs danger-full-access: pass sandbox_permissions "danger-full-access" and a one-sentence justification when the call is denied. Call ssh_hosts when you do not know the host id or name.',
      parameters: {
        host: { type: 'string', required: true, description: 'SSH host id, name, or address from ssh_hosts' },
        local_path: { type: 'string', required: true, description: 'Absolute path on the machine running DSH' },
        remote_path: { type: 'string', required: true, description: 'Absolute remote path or a path starting with "~/"' },
        ...OPS_ESCALATION,
      },
      output: textOutput(renderOpsUpload),
      execute(args: unknown, exec: ToolExec) {
        const record = args as Record<string, unknown>
        const host = pick(record)
        return runSshUpload(hostApi, host, record, exec, limits())
      },
    }), publishOpsTool({
      name: 'ssh_download',
      description: 'Copy one file from a configured SSH host to a local path over SFTP. This is for ops on a machine that is not your current workspace. remote_path is an absolute remote path or starts with "~/"; local_path is an absolute path on the machine running DSH whose parent directory already exists. The file is replaced atomically and gets mode 0600. A remote symlink, directory, or special file (FIFO/device) is refused, and so is a local directory or symlink at the target. Single files only; the byte ceiling and timeout come from Settings and 0 means unlimited. Downloading writes a local file, so it is gated like ssh_write: on an "ask" host it needs danger-full-access, with sandbox_permissions "danger-full-access" and a one-sentence justification when the call is denied. Call ssh_hosts when you do not know the host id or name.',
      parameters: {
        host: { type: 'string', required: true, description: 'SSH host id, name, or address from ssh_hosts' },
        remote_path: { type: 'string', required: true, description: 'Absolute remote path or a path starting with "~/"' },
        local_path: { type: 'string', required: true, description: 'Absolute path on the machine running DSH; its parent must already exist' },
        ...OPS_ESCALATION,
      },
      output: textOutput(renderOpsDownload),
      execute(args: unknown, exec: ToolExec) {
        const record = args as Record<string, unknown>
        const host = pick(record)
        return runSshDownload(hostApi, host, record, exec, limits())
      },
    })]
}
