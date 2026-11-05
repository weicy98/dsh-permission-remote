/** Browser calls into the host Typert service. ssh2 never enters this bundle. */

export interface HostView {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: 'key' | 'password'
  privateKeyPath: string
  fingerprint: string
  opsPolicy: 'ask' | 'trust' | 'deny'
  /** Absent on rows saved before the switch existed. Treated as off. */
  loginEnv: boolean
}

export interface RunnerView {
  os: 'linux' | 'darwin' | 'other'
  sandbox: { available: boolean, reason: string }
  sandboxTool: 'bwrap' | 'sandbox-exec' | 'none'
  /** `upload-failed`: the binary exists here but the remote refused it. */
  ripgrep: 'uploaded' | 'system' | 'missing' | 'upload-failed'
  ripgrepPath: string
  install: { id: string, title: string, auto: string, manual: string } | null
}

/** A host the operator removed; its workspaces are still registered. */
export interface DeletedHostView {
  id: string
  name: string
  address: string
  username: string
  port: number
  deletedAt: string
}

/** One registered workspace that lives on an SSH host. */
export interface RemoteWorkspaceView {
  hostId: string
  workspaceId: string
  title: string
  remotePath: string
  placeholderPath: string
  sessions: number
  createdAt: string
}

export interface WorkspaceListing {
  items: RemoteWorkspaceView[]
  deleted: DeletedHostView[]
}

export interface RpcResult<T> {
  ok: boolean
  value?: T
  error?: { message?: string }
}

export interface SettingsNamespace {
  ns: string
  value: {
    hosts?: HostView[]
    maxConnections?: number
    tagWorkspaceTitles?: boolean
    rgRegistry?: string
    remoteRoot?: string
    transferMaxBytes?: number
    transferTimeoutMs?: number
  }
  revision: number
}

export interface ClientFace {
  remote: { settings: {
    describe(): Promise<{ ok?: boolean, value?: { namespaces?: SettingsNamespace[] }, namespaces?: SettingsNamespace[] }>
    mutate(ns: string, ops: Array<{ op: 'set', path: string[], value: unknown }>, revision?: number): Promise<unknown>
  } }
  connection: { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> } }
}

const NS = 'permission-remote'

export interface HostSettings {
  hosts: HostView[]
  tagWorkspaceTitles: boolean
  rgRegistry: string
  remoteRoot: string
  transferMaxBytes: number
  transferTimeoutMs: number
  revision: number
}

/** Defaults mirrored from the host schema for rows saved before the field existed. */
const TRANSFER_MAX_BYTES_DEFAULT = 32 * 1024 * 1024
const TRANSFER_TIMEOUT_MS_DEFAULT = 120_000

/**
 * Mirrors `TRANSFER_TIMEOUT_MS_MAX` in `config.ts`; the browser bundle cannot
 * import the server module. `AbortSignal.timeout` refuses a larger delay, and
 * `setTimeout` above this overflows its 32-bit timer, so the value is capped
 * before it is stored rather than silently clamped only on read.
 */
export const TRANSFER_TIMEOUT_MS_MAX = 2 ** 31 - 1

/** A stored transfer limit. `0` is the documented "no limit" sentinel and must survive. */
function transferLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

export async function readHosts(ctx: ClientFace): Promise<HostSettings> {
  const response = await ctx.remote.settings.describe()
  const described = response.value ?? response
  const namespaces = described.namespaces ?? []
  const row = namespaces.find(item => item.ns === NS)
  const listed = Array.isArray(row?.value?.hosts) ? row.value.hosts : []
  // Rows saved before the switch existed omit it. Missing means off.
  const hosts = listed.map(host => ({ ...host, loginEnv: host.loginEnv === true }))
  // Older host builds have no such field; tagging is their default.
  const tagWorkspaceTitles = row?.value?.tagWorkspaceTitles !== false
  const rgRegistry = typeof row?.value?.rgRegistry === 'string' ? row.value.rgRegistry : ''
  const remoteRoot = typeof row?.value?.remoteRoot === 'string' ? row.value.remoteRoot : ''
  const transferMaxBytes = transferLimit(row?.value?.transferMaxBytes, TRANSFER_MAX_BYTES_DEFAULT)
  // A value saved by an older build (or edited elsewhere) may be over the
  // timer limit. Show the value that will actually apply, not the stored one.
  const transferTimeoutMs = Math.min(
    transferLimit(row?.value?.transferTimeoutMs, TRANSFER_TIMEOUT_MS_DEFAULT),
    TRANSFER_TIMEOUT_MS_MAX,
  )
  return { hosts, tagWorkspaceTitles, rgRegistry, remoteRoot, transferMaxBytes, transferTimeoutMs, revision: row?.revision ?? 0 }
}

export async function writeTagWorkspaceTitles(ctx: ClientFace, enabled: boolean, revision: number): Promise<void> {
  await ctx.remote.settings.mutate(NS, [{ op: 'set', path: ['tagWorkspaceTitles'], value: enabled }], revision)
}

/** Store the npm registry used to fetch a ripgrep binary; empty restores npmjs. */
export async function writeRgRegistry(ctx: ClientFace, registry: string, revision: number): Promise<void> {
  await ctx.remote.settings.mutate(NS, [{ op: 'set', path: ['rgRegistry'], value: registry }], revision)
}

/**
 * Store the transfer ceiling and deadline. `0` in either field means "no
 * limit"; the host schema validates that they are non-negative integers.
 */
export async function writeTransferLimits(ctx: ClientFace, maxBytes: number, timeoutMs: number, revision: number): Promise<void> {
  await ctx.remote.settings.mutate(NS, [
    { op: 'set', path: ['transferMaxBytes'], value: wholeLimit(maxBytes) },
    { op: 'set', path: ['transferTimeoutMs'], value: Math.min(wholeLimit(timeoutMs), TRANSFER_TIMEOUT_MS_MAX) },
  ], revision)
}

/**
 * Clamp one limit to a non-negative whole number. `Math.max(0, Math.floor(NaN))`
 * is `NaN`, which JSON cannot carry and the host schema would reject, so a
 * non-finite value becomes the "no limit" sentinel instead.
 */
export function wholeLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export interface RipgrepInstall {
  platform: string
  version: string
  /** The re-probe taken right after the binary was cached. */
  status: RunnerView
}

/** Forget a deleted host and unregister its workspaces. Remote files stay. */
export async function purgeHost(ctx: ClientFace, hostId: string): Promise<{ workspaces: number }> {
  const result = await callHost<{ workspaces?: number }>(ctx, 'purgeHost', { hostId })
  return { workspaces: result.workspaces ?? 0 }
}

/** Download the ripgrep binary for this host's remote platform, then re-probe. */
export async function installRipgrep(ctx: ClientFace, hostId: string): Promise<RipgrepInstall> {
  return callHost<RipgrepInstall>(ctx, 'installRipgrep', { hostId })
}

/**
 * The gateway rejects an argument the descriptor does not declare, so a method
 * declared without parameters must be called with no `input` field at all.
 */
export async function callHost<T>(ctx: ClientFace, method: string, input?: unknown): Promise<T> {
  const result = await ctx.connection.rpc.call('/api', `sshPermission/${method}`, {
    args: input === undefined ? {} : { input },
  })
  if (!result.ok) throw new Error(result.error?.message ?? `${method} failed`)
  return result.value as T
}

export async function readWorkspaces(ctx: ClientFace): Promise<WorkspaceListing> {
  const listed = await callHost<{ items?: RemoteWorkspaceView[], deleted?: DeletedHostView[] }>(ctx, 'listWorkspaces')
  return {
    items: Array.isArray(listed.items) ? listed.items : [],
    deleted: Array.isArray(listed.deleted) ? listed.deleted : [],
  }
}


/** Where remote-workspace placeholders live now, and the built-in default. */
export interface RemoteRootInfo {
  current: string
  defaultRoot: string
}

/** Result of a remote-root change; `needs-strategy`/`has-sessions` touched nothing. */
export interface RemoteRootChange {
  status: 'changed' | 'unchanged' | 'needs-strategy' | 'has-sessions'
  oldRoot: string
  root: string
  sessions?: number
  conflicts?: string[]
  workspacesRemapped?: number
  /** Stored sessions whose header and directory were moved onto the new root. */
  sessionsRelocated?: number
  /** Live sessions left in place; they follow once closed and the root is saved again. */
  sessionsSkippedLive?: number
  /** Sessions that could not be moved. */
  sessionsFailed?: number
  migration?: {
    copied: number
    skipped: number
    overwritten: number
    /** Paths left untouched: different content kept, or a file/directory clash. */
    conflicts: string[]
  }
}

export async function readRemoteRootInfo(ctx: ClientFace): Promise<RemoteRootInfo> {
  return callHost<RemoteRootInfo>(ctx, 'remoteRootInfo')
}

export async function changeRemoteRoot(
  ctx: ClientFace,
  root: string,
  options?: { strategy?: 'auto' | 'overwrite', force?: boolean, conflicts?: readonly string[] },
): Promise<RemoteRootChange> {
  return callHost<RemoteRootChange>(ctx, 'changeRemoteRoot', {
    root,
    strategy: options?.strategy,
    force: options?.force === true,
    // The list the page showed. A conflict that was not on it is asked again.
    conflicts: options?.conflicts,
  })
}

/** A JSON export of the host list. Passwords and key passphrases never ride. */
export interface HostConfigExport {
  version: number
  exportedAt: string
  hosts: HostView[]
  deletedHosts: Array<{ host: HostView, deletedAt: string }>
}

export async function exportHosts(ctx: ClientFace): Promise<HostConfigExport> {
  return callHost<HostConfigExport>(ctx, 'exportHosts')
}

export interface HostImportResult {
  ok: true
  added: number
  updated: number
  removed: number
}

export async function importHosts(
  ctx: ClientFace,
  payload: unknown,
  mode: 'merge' | 'replace',
): Promise<HostImportResult> {
  return callHost<HostImportResult>(ctx, 'importHosts', { payload, mode })
}
