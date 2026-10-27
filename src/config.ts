import Schema from '@deepseek-ai/schemastery'
import { createVolatile, isVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'

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

type HostRef = Volatile<unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHostRef(value: unknown): value is HostRef {
  return isVolatile(value)
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
  updateVolatile(ref, createVolatile(hosts.map(host => ({ ...host }))))
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
  const maxConnections = parsed.maxConnections ?? 4
  const ref = isHostRef(incoming) ? incoming : parsed.hosts
  if (isHostRef(ref)) return viewConfig(ref, maxConnections)
  return { hosts: asHostArray(ref), maxConnections }
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
