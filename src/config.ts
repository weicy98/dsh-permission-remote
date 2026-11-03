import Schema from '@deepseek-ai/schemastery'
import { createVolatile, isVolatile, updateVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import { isValidHostId } from './router.ts'

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
  /**
   * When true, workspace bash loads Bash login scripts and bashrc before the
   * command and discards their output. Off keeps the sshd session environment.
   */
  loginEnv: Schema.boolean().default(false),
})

const DeletedHost = Schema.object({
  host: Host,
  deletedAt: Schema.string().default(''),
})

export const Config = Schema.object({
  // Settings only lists and writes fields marked volatile. Without this, the
  // host row is dropped from describe() and every save is a silent no-op.
  hosts: Schema.array(Host).default([]).volatile(),
  /**
   * Hosts removed from the settings list. Their workspaces stay registered, so
   * the settings page keeps showing them under "deleted hosts" and can restore
   * the host or unregister a single workspace.
   */
  deletedHosts: Schema.array(DeletedHost).default([]).volatile(),
  maxConnections: Schema.natural().min(1).max(32).default(4),
  /**
   * DSH's sidebar has no slot on a workspace row, so the owning server is
   * written into the workspace title. Off keeps the titles untouched.
   */
  tagWorkspaceTitles: Schema.boolean().default(true).volatile(),
  /**
   * npm registry used when fetching a ripgrep binary for a remote platform this
   * machine does not have installed. Empty means the default npmjs registry.
   * A mirror is usually needed where npmjs.org is slow or blocked.
   */
  rgRegistry: Schema.string().default('').volatile(),
  /**
   * Local directory the remote-workspace placeholder tree lives under. Empty
   * keeps the built-in default (`<DSH_HOME>/remote`, or `DSH_SSH_REMOTE_ROOT`).
   * The Settings action changes it and migrates the old tree there.
   */
  remoteRoot: Schema.string().default('').volatile(),
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
  /**
   * Absent on rows saved before the field existed. Treated as off.
   * `true` only when the operator turned Bash startup files on for this host.
   */
  loginEnv?: boolean
}

/** Hosts saved before `opsPolicy` existed are treated as `ask`. */
export function normalizeOpsPolicy(value: unknown): OpsPolicy {
  return value === 'trust' || value === 'deny' ? value : 'ask'
}

/** Anything other than an explicit `true` leaves workspace bash without startup files. */
export function normalizeLoginEnv(value: unknown): boolean {
  return value === true
}

/**
 * Whether the fields the SSH handshake reads changed. A cached session keyed by
 * host id would otherwise keep talking to the previous machine, and the cached
 * probe result would keep describing it. `name`, `fingerprint`, `opsPolicy`
 * and `loginEnv` are not part of the handshake, so renaming keeps the session.
 */
export function connectionKeyChanged(previous: HostConfig, next: HostConfig): boolean {
  return previous.host !== next.host
    || previous.port !== next.port
    || previous.username !== next.username
    || previous.auth !== next.auth
    || previous.privateKeyPath !== next.privateKeyPath
}

export interface DeletedHost {
  host: HostConfig
  deletedAt: string
}


export interface PluginConfig {
  hosts: HostConfig[]
  deletedHosts: DeletedHost[]
  readonly maxConnections: number
  readonly tagWorkspaceTitles: boolean
  readonly rgRegistry: string
  /** Operator-chosen placeholder root, or empty for the built-in default. */
  remoteRoot: string
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

function copyDeletedRows(value: unknown): DeletedHost[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('deleted SSH host list is not an array')
  return (value as DeletedHost[]).map(row => ({ host: { ...row.host }, deletedAt: row.deletedAt ?? '' }))
}

function commitHosts(ref: HostRef, hosts: HostConfig[]): void {
  updateVolatile(ref, createVolatile(hosts.map(host => ({ ...host }))))
}

function commitDeleted(ref: HostRef, rows: DeletedHost[]): void {
  updateVolatile(ref, createVolatile(rows.map(row => ({ host: { ...row.host }, deletedAt: row.deletedAt }))))
}

/**
 * Cordis passes `apply` the resolved config. `hosts` is then a volatile
 * reference, and running the schema on that reference throws. The returned
 * object keeps that same reference, so a later volatile commit is visible
 * here without reloading the plugin.
 */
export function readConfig(raw: unknown): PluginConfig {
  const record = isRecord(raw) ? raw : {}
  const hostRef = refOf(record.hosts)
  const deletedRef = refOf(record.deletedHosts)
  const tagRef = refOf(record.tagWorkspaceTitles)
  const tagDefault = record.tagWorkspaceTitles !== false
  const registryRef = refOf(record.rgRegistry)
  const registryDefault = typeof record.rgRegistry === 'string' ? record.rgRegistry : ''
  const rootRef = refOf(record.remoteRoot)
  const rootDefault = typeof record.remoteRoot === 'string' ? record.remoteRoot : ''
  const parsed = Config({
    ...record,
    hosts: copyHostRows(hostRef !== undefined ? hostRef.get() : record.hosts),
    deletedHosts: copyDeletedRows(deletedRef !== undefined ? deletedRef.get() : record.deletedHosts),
    // A volatile reference cannot be validated; resolve it to a value first.
    tagWorkspaceTitles: tagRef !== undefined ? tagRef.get() !== false : tagDefault,
    rgRegistry: registryRef !== undefined ? String(registryRef.get() ?? '') : registryDefault,
    remoteRoot: rootRef !== undefined ? String(rootRef.get() ?? '') : rootDefault,
  }) as unknown as { hosts?: unknown, deletedHosts?: unknown, maxConnections?: number }
  const maxConnections = parsed.maxConnections ?? 4
  const tag = tagRef === undefined ? (): boolean => tagDefault : (): boolean => tagRef.get() !== false
  const registry = (): string => String(registryRef === undefined ? registryDefault : registryRef.get() ?? '').trim()
  const root = (): string => String(rootRef === undefined ? rootDefault : rootRef.get() ?? '').trim()
  const ref = hostRef ?? parsed.hosts
  // `Config()` returns volatile wrappers for volatile fields even when the
  // input was a plain array, so prefer the parsed reference when present.
  const deletedRowRef = deletedRef ?? refOf(parsed.deletedHosts)
  const deletedRows = copyDeletedRows(deletedRowRef !== undefined ? deletedRowRef.get() : record.deletedHosts) ?? []
  if (isHostRef(ref)) return viewConfig(ref, maxConnections, tag, registry, root, rootRef, deletedRowRef, deletedRows)
  return { hosts: asHostArray(ref), deletedHosts: deletedRows, maxConnections, tagWorkspaceTitles: tagDefault, rgRegistry: registry(), remoteRoot: root() }
}

function refOf(value: unknown): HostRef | undefined {
  return isVolatile(value) ? value : undefined
}

function viewConfig(
  ref: HostRef,
  maxConnections: number,
  tagWorkspaceTitles: () => boolean,
  rgRegistry: () => string,
  remoteRoot: () => string,
  rootRef: HostRef | undefined,
  deletedRef: HostRef | undefined,
  deletedRows: DeletedHost[],
): PluginConfig {
  return {
    get hosts() {
      return asHostArray(ref.get()).map(host => ({ ...host }))
    },
    set hosts(value: HostConfig[]) {
      commitHosts(ref, value)
    },
    get deletedHosts() {
      return deletedRef === undefined
        ? deletedRows
        : copyDeletedRows(deletedRef.get()) ?? []
    },
    set deletedHosts(value: DeletedHost[]) {
      // Silently dropping the tombstone would lose the only way back to the
      // host, so an unwritable config is an error rather than a no-op.
      if (deletedRef === undefined) throw new Error('the deleted SSH host list is not writable in this config')
      commitDeleted(deletedRef, value)
    },
    maxConnections,
    get tagWorkspaceTitles() {
      return tagWorkspaceTitles()
    },
    get rgRegistry() {
      return rgRegistry()
    },
    get remoteRoot() {
      return remoteRoot()
    },
    set remoteRoot(value: string) {
      // A read-only config (no volatile ref) cannot persist a new root; the
      // migration must fail loudly rather than reporting a switch that is lost.
      if (rootRef === undefined) throw new Error('the remote root setting is not writable in this config')
      updateVolatile(rootRef, createVolatile(String(value ?? '')))
    },
  }
}

/**
 * One host row after validation, with schema defaults applied.
 *
 * Used by the JSON import: a hand-edited or foreign file must not put a row
 * into the config that the handshake then chokes on. A host id is required to
 * match the routing grammar, because a placeholder path is keyed by it.
 */
export function normalizeHostRow(raw: unknown): HostConfig {
  if (!isRecord(raw)) throw new Error('each imported host must be an object')
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const id = text(raw.id).trim()
  if (!isValidHostId(id)) throw new Error(`imported host has an invalid id: ${JSON.stringify(raw.id)}`)
  const host = text(raw.host).trim()
  if (host.length === 0) throw new Error(`imported host ${id} is missing its address`)
  const username = text(raw.username).trim()
  if (username.length === 0) throw new Error(`imported host ${id} is missing its username`)
  // A wrong port must fail the import instead of falling back to 22: a file
  // that says "2222" as a string would otherwise dial the wrong sshd, and with
  // key auth that can succeed without anything looking broken.
  const port = raw.port === undefined ? 22 : raw.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`imported host ${id} has an invalid port: ${JSON.stringify(raw.port)}`)
  }
  if (raw.auth !== undefined && raw.auth !== 'key' && raw.auth !== 'password') {
    throw new Error(`imported host ${id} has an unknown auth mode: ${JSON.stringify(raw.auth)}`)
  }
  if (raw.opsPolicy !== undefined && raw.opsPolicy !== 'ask' && raw.opsPolicy !== 'trust' && raw.opsPolicy !== 'deny') {
    throw new Error(`imported host ${id} has an unknown ops policy: ${JSON.stringify(raw.opsPolicy)}`)
  }
  // The schema owns every remaining default. Schemastery keeps keys it does not
  // declare, so the row is rebuilt from the declared fields only: a foreign file
  // must not smuggle extra keys into the config. The compiler checks this list
  // against `HostConfig`, which is what keeps it complete.
  const parsed = Host({
    ...raw,
    id,
    host,
    username,
    port,
    privateKeyPath: text(raw.privateKeyPath).trim(),
    fingerprint: text(raw.fingerprint).trim(),
  }) as HostConfig
  return {
    id: parsed.id,
    name: text(parsed.name).trim(),
    host: parsed.host,
    port: parsed.port,
    username: parsed.username,
    auth: parsed.auth,
    privateKeyPath: parsed.privateKeyPath,
    fingerprint: parsed.fingerprint,
    opsPolicy: parsed.opsPolicy,
    loginEnv: parsed.loginEnv,
  }
}

/** A JSON export of the host list; no secret ever rides along. */
export interface HostConfigExport {
  version: number
  exportedAt: string
  hosts: HostConfig[]
  deletedHosts: DeletedHost[]
}

export function exportHostConfig(hosts: readonly HostConfig[], deletedHosts: readonly DeletedHost[]): HostConfigExport {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    hosts: hosts.map(host => ({ ...host })),
    deletedHosts: deletedHosts.map(row => ({ host: { ...row.host }, deletedAt: row.deletedAt ?? '' })),
  }
}

/** A parsed import file: the host rows to merge and any tombstones it carried. */
export interface HostConfigImport {
  hosts: HostConfig[]
  deletedHosts: DeletedHost[]
  /**
   * Keys each host object actually contained, in the same order as `hosts`.
   * A missing key is not a request to reset that field to its default.
   */
  present: ReadonlyArray<ReadonlySet<string>>
}

const HOST_PATCH_FIELDS = ['name', 'host', 'port', 'username', 'auth', 'privateKeyPath', 'fingerprint', 'opsPolicy', 'loginEnv'] as const

function presentHostFields(raw: unknown): ReadonlySet<string> {
  if (!isRecord(raw)) return new Set()
  return new Set(HOST_PATCH_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(raw, field)))
}

/**
 * Keep every field the file did not mention.
 *
 * A hand-edited row that only renames a host must not clear its fingerprint,
 * drop `deny`, or forget the private-key path. A new address without a new
 * fingerprint cannot keep the old machine's host key.
 */
function overlayHost(current: HostConfig, incoming: HostConfig, present: ReadonlySet<string>): HostConfig {
  const next: HostConfig = { ...current }
  if (present.has('name')) next.name = incoming.name
  if (present.has('host')) next.host = incoming.host
  if (present.has('port')) next.port = incoming.port
  if (present.has('username')) next.username = incoming.username
  if (present.has('auth')) next.auth = incoming.auth
  if (present.has('privateKeyPath')) next.privateKeyPath = incoming.privateKeyPath
  if (present.has('fingerprint')) next.fingerprint = incoming.fingerprint
  if (present.has('opsPolicy')) next.opsPolicy = incoming.opsPolicy
  if (present.has('loginEnv')) next.loginEnv = incoming.loginEnv
  if (present.has('host') && incoming.host !== current.host && !present.has('fingerprint')) next.fingerprint = ''
  return next
}

/** Read an export payload (`{hosts:[…]}`, or a bare array) into validated rows. */
export function parseHostImport(payload: unknown): HostConfigImport {
  let hostsRaw: unknown
  let deletedRaw: unknown
  if (Array.isArray(payload)) hostsRaw = payload
  else if (isRecord(payload)) {
    hostsRaw = payload.hosts
    deletedRaw = payload.deletedHosts
  } else {
    throw new Error('imported file is not a host configuration export')
  }
  if (!Array.isArray(hostsRaw)) throw new Error('imported file has no "hosts" array')
  const hosts: HostConfig[] = []
  const present: Array<ReadonlySet<string>> = []
  for (const raw of hostsRaw) {
    hosts.push(normalizeHostRow(raw))
    present.push(presentHostFields(raw))
  }
  const seen = new Set<string>()
  for (const host of hosts) {
    if (seen.has(host.id)) throw new Error(`imported file lists host ${host.id} more than once`)
    seen.add(host.id)
  }
  const deletedHosts: DeletedHost[] = []
  if (Array.isArray(deletedRaw)) {
    for (const row of deletedRaw) {
      if (!isRecord(row)) continue
      const host = normalizeHostRow(row.host)
      if (seen.has(host.id)) continue
      seen.add(host.id)
      deletedHosts.push({ host, deletedAt: typeof row.deletedAt === 'string' ? row.deletedAt : '' })
    }
  }
  return { hosts, deletedHosts, present }
}

export interface HostImportResult {
  hosts: HostConfig[]
  deletedHosts: DeletedHost[]
  added: number
  updated: number
  removed: number
}

/**
 * Fold a parsed import into the current list.
 *
 * `merge` keeps every current host and lets the file override a matching id,
 * but only the fields the file actually contains. `replace` makes the file the
 * whole list; an id that already exists (live or deleted) keeps fields the file
 * omits. A host the file drops becomes a tombstone instead of disappearing:
 * its workspaces are still registered, and `deleteHost` already keeps a row so
 * the host can be restored. The tombstone list from the file is used by
 * `replace` only; `merge` treats the file as host rows and leaves the
 * operator's own deleted list alone.
 *
 * Either way an imported host that was a tombstone is revived, so restoring from
 * a backup does not leave a ghost "deleted host" row beside the live one.
 */
export function mergeImportedHosts(
  current: readonly HostConfig[],
  currentDeleted: readonly DeletedHost[],
  incoming: HostConfigImport,
  mode: 'merge' | 'replace',
): HostImportResult {
  const importedIds = new Set(incoming.hosts.map(host => host.id))
  const known = new Map<string, HostConfig>()
  for (const host of current) known.set(host.id, host)
  for (const row of currentDeleted) if (!known.has(row.host.id)) known.set(row.host.id, row.host)
  const placed = incoming.hosts.map((host, index) => {
    const previous = known.get(host.id)
    const fields = incoming.present[index] ?? new Set<string>()
    return previous === undefined ? { ...host } : overlayHost(previous, host, fields)
  })
  let hosts: HostConfig[]
  let added = 0
  let updated = 0
  let removed = 0
  let dropped: DeletedHost[] = []
  if (mode === 'replace') {
    // The file becomes the whole list, so an incoming id that already existed is
    // a replace (updated), not a new row. Counting every incoming row as "added"
    // made a no-op replace look like it added the whole list.
    const currentIds = new Set(current.map(host => host.id))
    hosts = placed
    added = incoming.hosts.filter(host => !currentIds.has(host.id)).length
    updated = incoming.hosts.length - added
    const droppedHosts = current.filter(host => !importedIds.has(host.id))
    removed = droppedHosts.length
    const now = new Date().toISOString()
    dropped = droppedHosts.map(host => ({ host: { ...host }, deletedAt: now }))
  } else {
    hosts = current.map(host => ({ ...host }))
    const byId = new Map(hosts.map(host => [host.id, host]))
    for (let index = 0; index < placed.length; index += 1) {
      const next = placed[index]!
      if (byId.has(next.id)) {
        byId.set(next.id, next)
        updated += 1
      } else {
        byId.set(next.id, next)
        added += 1
      }
    }
    hosts = [...byId.values()]
  }
  const baseDeleted = mode === 'replace' ? [...dropped, ...incoming.deletedHosts] : currentDeleted
  // A host that is live again must not keep a tombstone beside it, and one host
  // must not get two tombstone rows: a `replace` both drops a host that the file
  // no longer lists and may carry the file's own tombstone for it, which would
  // otherwise list the same deleted host twice. First spelling wins (a freshly
  // dropped row before the file's stale tombstone).
  const seenDeleted = new Set<string>()
  const deletedHosts = baseDeleted
    .filter(row => !importedIds.has(row.host.id))
    .filter(row => {
      if (seenDeleted.has(row.host.id)) return false
      seenDeleted.add(row.host.id)
      return true
    })
    .map(row => ({ host: { ...row.host }, deletedAt: row.deletedAt ?? '' }))
  return { hosts, deletedHosts, added, updated, removed }
}
