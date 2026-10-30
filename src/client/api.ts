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
  value: { hosts?: HostView[], maxConnections?: number, tagWorkspaceTitles?: boolean, rgRegistry?: string }
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
  revision: number
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
  return { hosts, tagWorkspaceTitles, rgRegistry, revision: row?.revision ?? 0 }
}

export async function writeTagWorkspaceTitles(ctx: ClientFace, enabled: boolean, revision: number): Promise<void> {
  await ctx.remote.settings.mutate(NS, [{ op: 'set', path: ['tagWorkspaceTitles'], value: enabled }], revision)
}

/** Store the npm registry used to fetch a ripgrep binary; empty restores npmjs. */
export async function writeRgRegistry(ctx: ClientFace, registry: string, revision: number): Promise<void> {
  await ctx.remote.settings.mutate(NS, [{ op: 'set', path: ['rgRegistry'], value: registry }], revision)
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
