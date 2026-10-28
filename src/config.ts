import Schema from '@deepseek-ai/schemastery'
import { createVolatile, isVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'

/**
 * `ask` gates commands and writes behind the session permission mode and an
 * approval card. `trust` runs them without a prompt. `deny` rejects every
 * remote ops call, reads included.
 */
export const OpsPolicy = Schema.union([
  Schema.const('ask').required(),
  Schema.const('trust').required(),
  Schema.const('deny').required(),
]).default('ask')

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
  opsPolicy: OpsPolicy,
})

export const Config = Schema.object({
  // Settings only lists and writes fields marked volatile. Without this, the
  // host row is dropped from describe() and every save is a silent no-op.
  hosts: Schema.array(Host).default([]).volatile(),
  maxConnections: Schema.natural().min(1).max(32).default(4),
  /**
   * DSH's sidebar has no slot on a workspace row, so the owning server is
   * written into the workspace title. Off keeps the titles untouched.
   */
  tagWorkspaceTitles: Schema.boolean().default(true),
})

export type OpsPolicy = 'ask' | 'trust' | 'deny'

export interface HostConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: 'key' | 'password'
  privateKeyPath: string
  fingerprint: string
  opsPolicy: OpsPolicy
}

/** Hosts saved before `opsPolicy` existed are treated as `ask`. */
export function normalizeOpsPolicy(value: unknown): OpsPolicy {
  return value === 'trust' || value === 'deny' ? value : 'ask'
}

/**
 * Whether the fields the SSH handshake reads changed. A cached session keyed by
 * host id would otherwise keep talking to the previous machine, and the cached
 * probe result would keep describing it. `name`, `fingerprint` and `opsPolicy`
 * are not part of the handshake, so renaming keeps the session.
 */
export function connectionKeyChanged(previous: HostConfig, next: HostConfig): boolean {
  return previous.host !== next.host
    || previous.port !== next.port
    || previous.username !== next.username
    || previous.auth !== next.auth
    || previous.privateKeyPath !== next.privateKeyPath
}

export interface PluginConfig {
  hosts: HostConfig[]
  maxConnections: number
  tagWorkspaceTitles: boolean
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
  }) as { hosts?: unknown, maxConnections?: number, tagWorkspaceTitles?: boolean }
  const maxConnections = parsed.maxConnections ?? 4
  const tagWorkspaceTitles = parsed.tagWorkspaceTitles !== false
  const ref = isHostRef(incoming) ? incoming : parsed.hosts
  if (isHostRef(ref)) return viewConfig(ref, maxConnections, tagWorkspaceTitles)
  return { hosts: asHostArray(ref), maxConnections, tagWorkspaceTitles }
}

function viewConfig(ref: HostRef, maxConnections: number, tagWorkspaceTitles: boolean): PluginConfig {
  return {
    get hosts() {
      return asHostArray(ref.get()).map(host => ({ ...host }))
    },
    set hosts(value: HostConfig[]) {
      commitHosts(ref, value)
    },
    maxConnections,
    tagWorkspaceTitles,
  }
}
