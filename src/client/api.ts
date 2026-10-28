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
}

export interface RunnerView {
  os: 'linux' | 'darwin' | 'other'
  sandbox: { available: boolean, reason: string }
  sandboxTool: 'bwrap' | 'sandbox-exec' | 'none'
  ripgrep: 'uploaded' | 'system' | 'missing'
  install: { id: string, title: string, auto: string, manual: string } | null
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

export interface RpcResult<T> {
  ok: boolean
  value?: T
  error?: { message?: string }
}

export interface SettingsNamespace {
  ns: string
  value: { hosts?: HostView[], maxConnections?: number }
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

export async function readHosts(ctx: ClientFace): Promise<{ hosts: HostView[], revision: number }> {
  const response = await ctx.remote.settings.describe()
  const described = response.value ?? response
  const namespaces = described.namespaces ?? []
  const row = namespaces.find(item => item.ns === NS)
  const hosts = Array.isArray(row?.value?.hosts) ? row.value.hosts : []
  return { hosts, revision: row?.revision ?? 0 }
}

export async function writeHosts(ctx: ClientFace, hosts: HostView[], revision: number): Promise<void> {
  await ctx.remote.settings.mutate(NS, [{ op: 'set', path: ['hosts'], value: hosts }], revision)
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

export async function readWorkspaces(ctx: ClientFace): Promise<RemoteWorkspaceView[]> {
  const listed = await callHost<{ items?: RemoteWorkspaceView[] }>(ctx, 'listWorkspaces')
  return Array.isArray(listed.items) ? listed.items : []
}
