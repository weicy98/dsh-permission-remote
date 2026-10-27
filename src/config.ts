import Schema from '@deepseek-ai/schemastery'

const Host = Schema.object({
  id: Schema.string().required(),
  name: Schema.string().default(''),
  host: Schema.string().required(),
  port: Schema.natural().min(1).max(65535).default(22),
  username: Schema.string().required(),
  /** `key` reads a local private-key path. `password` reads ctx.credentials. */
  auth: Schema.union([
    Schema.const('key').required(),
    Schema.const('password').required(),
  ]).default('key'),
  /** Local path of the private key. The key bytes are never copied into config. */
  privateKeyPath: Schema.string().default(''),
  /** SHA-256 host key accepted by the operator. Empty until the first trust. */
  fingerprint: Schema.string().default(''),
})

export const Config = Schema.object({
  // Settings only lists and writes fields marked volatile. Without this, the
  // host row is dropped from describe() and every save is a silent no-op.
  hosts: Schema.array(Host).default([]).volatile(),
  maxConnections: Schema.natural().min(1).max(32).default(4),
})

export interface HostConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: 'key' | 'password'
  privateKeyPath: string
  fingerprint: string
}

export interface PluginConfig {
  hosts: HostConfig[]
  maxConnections: number
}

const volatileWrite = Symbol.for('cosmokit.volatile.write')

interface HostRef {
  get(): unknown
  [volatileWrite](value: unknown): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHostRef(value: unknown): value is HostRef {
  if (typeof value !== 'object' || value === null || !(volatileWrite in value)) return false
  return typeof (value as { get?: unknown }).get === 'function'
}

function asHostArray(value: unknown): HostConfig[] {
  if (!Array.isArray(value)) throw new Error('SSH host list is not an array')
  return value as HostConfig[]
}

function copyHostRows(value: unknown): HostConfig[] | undefined {
  if (value === undefined || value === null) return undefined
  return asHostArray(value).map(item => ({ ...item }))
}

function commitHosts(ref: HostRef, hosts: HostConfig[]): void {
  const frozen = Object.freeze(hosts.map(host => Object.freeze({ ...host })))
  const writer = (ref as unknown as Record<symbol, (value: unknown) => void>)[volatileWrite]
  writer(frozen)
}

/**
 * Cordis passes `apply` the resolved config. `hosts` is then a volatile
 * reference, and running the schema on that reference throws. The returned
 * object keeps that same reference, so a later volatile commit is visible
 * here without reloading the plugin.
 */
export function readConfig(raw: unknown): PluginConfig {
  const record = isRecord(raw) ? raw : {}
  const incoming = record.hosts
  const parsed = Config({
    ...record,
    hosts: copyHostRows(isHostRef(incoming) ? incoming.get() : incoming),
  }) as { hosts?: unknown, maxConnections?: number }
  const normalized = asHostArray(isHostRef(parsed.hosts) ? parsed.hosts.get() : parsed.hosts)
  const maxConnections = parsed.maxConnections ?? 4
  if (isHostRef(incoming)) return viewConfig(incoming, maxConnections)
  if (isHostRef(parsed.hosts)) return viewConfig(parsed.hosts, maxConnections)
  return { hosts: normalized, maxConnections }
}

function viewConfig(ref: HostRef, maxConnections: number): PluginConfig {
  return {
    get hosts() {
      return asHostArray(ref.get()).map(host => ({ ...host }))
    },
    set hosts(value: HostConfig[]) {
      commitHosts(ref, value)
    },
    maxConnections,
  }
}
