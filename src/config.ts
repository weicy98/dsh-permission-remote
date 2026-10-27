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
  hosts: Schema.array(Host).default([]),
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

export function readConfig(raw: unknown): PluginConfig {
  const value = Config(raw ?? {}) as PluginConfig
  return {
    hosts: value.hosts ?? [],
    maxConnections: value.maxConnections ?? 4,
  }
}
