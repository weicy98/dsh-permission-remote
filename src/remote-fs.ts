/**
 * Remote directory listings for the sidebar file tree.
 *
 * The tree asks `workspaceFiles.list` with the session cwd, which is the local
 * placeholder. That service then calls `ctx.fs` (`lstat`, `resolve`, `contains`,
 * `listDir`). Office preview and markdown images do the same with `readBytes`
 * and `streamText`, and they pass `processPath(target)` back into `resolve`.
 * `processPath` is the target key, so the key stays the placeholder spelling
 * the client already joins. A remote path as the key would fail `contains`.
 *
 * `mapRemoteToLocal` is a sibling of the workspace placeholder, not a child of
 * it, so it is not a target key. The write/edit methods below mutate the remote
 * target directly so the official file tools stay inside the remote execution
 * world. SFTP has no watch; a remote `watch` fails and the panel keeps manual
 * refresh.
 */
import path from 'node:path'
import { posix } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import {
  FsError,
  FsTargetKey,
  type FsVersion,
  type FsDirEntry,
  type FsEditOutcome,
  type FsEditRequest,
  type FsInfo,
  type FsPathInfo,
  type FsDeleteOutcome,
  type FsMoveOutcome,
  type FsTarget,
  type FsWriteIntent,
  type FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import { SandboxUnavailableError, type SandboxExecutionPolicy, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { HostConfig } from './config.ts'
import { composeCreatedPath } from './contain.ts'
import type { RunnerStatus } from './execute.ts'
import { isRemoteMissing } from './ops.ts'
import { applyHunks, type PatchHunk } from './patch-hunks.ts'
import { fileWriteAllowed } from './profile.ts'
import { isPresentCachePath, mapRemoteToLocal, normalizeRemoteDirectory, resolveRemotePath, routeByCwd, workspaceBinding } from './router.ts'
import { commitRemoteDelete, commitRemoteText, parseRemoteVersion, remoteRoots, remoteVersionEvidence, remoteVersionToken, resolveCreatedPath, type RemoteVersionEvidence } from './remote-write.ts'
import { SFTP_STATUS, SshFailure, isByteLimitExceeded, isSftpPermissionDenied, type ExecResult, type RemoteDirEntry, type SecretMaterial, type SftpAttrs, type SshPool } from './ssh-pool.ts'
import { remotePathInside } from './workspaces.ts'

/** Same ceiling `present` uses before it will copy a remote file. */
const TEXT_CAP = 32 * 1024 * 1024

/**
 * `agent/pre-step` stats the working directory, `.git`, and every instruction
 * candidate on each step. A realpath must not be trusted for long: replacing a
 * directory with a symlink is the escape this cache could otherwise hide, so the
 * window is only a few seconds. Attributes are shorter. `write` and `edit` drop
 * the path they just changed. A remote `bash` tool drops the host's attributes
 * when the process exits, because the command can create or replace files the
 * cache had already recorded as absent. The sidebar PTY, ops tools, and PTC
 * have no such boundary, so a manual refresh can still show the previous
 * existence and size for a few seconds. A disconnected host can still answer
 * from an older entry.
 */
const REALPATH_TTL_MS = 3_000
const ATTR_TTL_MS = 5_000
const META_CAP = 512

const MARKER = Symbol('dsh-permission-remote.remote-fs')

export interface RemoteAccess {
  requireHost(hostId: string): HostConfig
  secret(host: HostConfig): Promise<SecretMaterial>
  /** Probe data needed by remote mutations; optional so read-only installs keep working. */
  statusOf?: (host: HostConfig) => Promise<RunnerStatus>
  /** Whether the session that supplied the policy was opened on this host. */
  allowsRemoteSession?: (sessionId: string | undefined, hostId: string) => boolean
  /**
   * Remote workspace roots registered on one host.
   *
   * A session's workspace root cannot be recovered from a placeholder path:
   * `<root>/<host>/<encoded>` names the whole remote path, while
   * `<root>/<host>/<encoded workspace root>/suffix` names the root plus a
   * relative suffix. Both spellings route to the same file, so containment has
   * to be decided against the registered root, never against the target itself.
   */
  workspaceRootsOf?: (hostId: string) => readonly string[]
  pool: {
    exec?: (host: HostConfig, secret: SecretMaterial, command: string, timeoutMs: number, signal?: AbortSignal, stdin?: string | Buffer) => Promise<ExecResult>
    sftpRealpath(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string>
    sftpAttrs(host: HostConfig, secret: SecretMaterial, remotePath: string, follow: boolean): Promise<SftpAttrs | undefined>
    sftpReadLink(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string>
    sftpProbeDir(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<void>
    sftpReadDir(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<RemoteDirEntry[]>
    sftpRead(host: HostConfig, secret: SecretMaterial, remotePath: string, maxBytes?: number, signal?: AbortSignal): Promise<Buffer>
    sftpReadAt(host: HostConfig, secret: SecretMaterial, remotePath: string, offset: number, length: number): Promise<Buffer>
    sftpReadChunks(host: HostConfig, secret: SecretMaterial, remotePath: string, signal?: AbortSignal): AsyncIterable<Buffer>
  }
}

export interface FsContext {
  get(service: string): unknown
  logger?: { warn(message: string): void }
}

interface RemoteIdentity {
  readonly hostId: string
  readonly remoteReal: string
  readonly at: number
}

interface Place {
  readonly host: HostConfig
  readonly remote: string
}

interface Originals {
  resolve(path: string, opts?: { cwd?: string, signal?: AbortSignal }): Promise<FsTarget>
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined>
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>
  readByteRange(target: FsTarget, range: { offset: number, length: number }, signal?: AbortSignal): Promise<Uint8Array>
  writeText(target: FsTarget, content: string, expected?: FsWriteIntent, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
  editText(target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsEditOutcome>
  /**
   * The remaining mutating methods of the fs service definition. DSH 0.2.2
   * publishes them for `apply_patch`; they are reimplemented remotely when the
   * mounted provider has them, and refused for a remote target otherwise so
   * they never fall through to the local backend. A local target still reaches
   * the mounted provider unchanged.
   */
  patchText?(target: FsTarget, hunks: readonly PatchHunk[], expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsEditOutcome>
  deleteFile?(target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsDeleteOutcome>
  moveFile?(source: FsTarget, destination: FsTarget, options: { hunks?: readonly PatchHunk[], expectedSource?: { version: FsVersion }, expectedDestination?: FsWriteIntent }, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsMoveOutcome>
  contains(parent: FsTarget, child: FsTarget): boolean
  watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
}

type FsSurface = Originals & object

const REQUIRED: ReadonlyArray<keyof Originals> = [
  'resolve', 'lstat', 'stat', 'listDir', 'readText', 'streamText', 'readBytes', 'readByteRange', 'writeText', 'editText', 'contains', 'watch',
]

export interface RemoteFsOptions {
  /** Test clock. Production uses `Date.now`. */
  now?: () => number
  /** How long a realpath is reused while the host still answers. Default 3s. */
  metaTtlMs?: number
  /** How long a stat result is reused. Default 5s. */
  attrTtlMs?: number
}

/** Installed tree. Calling it restores `ctx.fs`. `invalidateHost` drops one server. */
export interface RemoteTree {
  (): void
  invalidateHost(hostId: string): void
  /** Drop cached attributes and version evidence. Realpath and identity stay. */
  forgetHostAttrs(hostId: string): void
}

/**
 * Patch the filesystem the sidebar already uses. A second call warns and does
 * nothing. `undefined` means the patch is not installed.
 */
/** Whether this process already has the remote filesystem patch installed. */
export function remoteFsInstalled(ctx: FsContext): boolean {
  try {
    const service = ctx.get('fs')
    return typeof service === 'object' && service !== null && marked(unwrap(service))
  } catch {
    return false
  }
}

export function installRemoteFs(ctx: FsContext, access: RemoteAccess, options?: RemoteFsOptions): RemoteTree | undefined {
  let service: unknown
  try {
    service = ctx.get('fs')
  } catch (error) {
    ctx.logger?.warn(`[@dsh-permission-remote] remote file tree skipped: filesystem service is unavailable (${errorText(error)})`)
    return undefined
  }
  if (typeof service !== 'object' || service === null) {
    ctx.logger?.warn('[@dsh-permission-remote] remote file tree skipped: filesystem service is unavailable')
    return undefined
  }
  const fs = unwrap(service)
  if (marked(fs)) {
    ctx.logger?.warn('[@dsh-permission-remote] remote file tree already installed')
    return undefined
  }
  const missing = REQUIRED.filter(name => typeof (fs as Partial<Originals>)[name] !== 'function')
  if (missing.length > 0) {
    ctx.logger?.warn(`[@dsh-permission-remote] remote file tree skipped: filesystem is missing ${missing.join(', ')}`)
    return undefined
  }
  const surface = fs as FsSurface
  const identity = new Map<string, RemoteIdentity>()
  const originals = bindOptionalMutations(surface, bindOriginals(surface))
  const now = options?.now ?? Date.now
  const meta = new MetaCache(
    now,
    options?.metaTtlMs ?? REALPATH_TTL_MS,
    options?.attrTtlMs ?? ATTR_TTL_MS,
  )
  const versions = new Map<string, number>()
  const descriptors = new Map<string, { base: string } & RemoteVersionEvidence>()
  const locks = new Map<string, Promise<void>>()
  const runtime = { access, identity, originals, meta, now, versions, descriptors, locks }
  const restorers: Array<() => void> = []
  try {
    restorers.push(replaceMethod(surface, 'resolve', (requested, opts) => resolveRemote(runtime, requested, opts)))
    restorers.push(replaceMethod(surface, 'lstat', (requested, opts, signal) => lstatRemote(runtime, requested, opts, signal)))
    restorers.push(replaceMethod(surface, 'stat', (target, signal) => statRemote(runtime, target, signal)))
    restorers.push(replaceMethod(surface, 'listDir', (target, signal) => listRemote(runtime, target, signal)))
    restorers.push(replaceMethod(surface, 'readText', (target, signal) => readRemoteText(runtime, target, signal)))
    restorers.push(replaceMethod(surface, 'streamText', (target, signal) => streamRemoteText(runtime, target, signal)))
    restorers.push(replaceMethod(surface, 'readBytes', (target, signal, maxBytes) => readRemoteBytes(runtime, target, signal, maxBytes)))
    restorers.push(replaceMethod(surface, 'readByteRange', (target, range, signal) => readRemoteRange(runtime, target, range, signal)))
    restorers.push(replaceMethod(surface, 'contains', (parent, child) => containsRemote(runtime, parent, child)))
    restorers.push(replaceMethod(surface, 'watch', (target, changed, signal) => watchRemote(runtime, target, changed, signal)))
    restorers.push(replaceMethod(surface, 'writeText', (target, content, expected, signal, policy) => writeRemoteText(runtime, target, content, expected, signal, policy)))
    restorers.push(replaceMethod(surface, 'editText', (target, edit, expected, signal, policy) => editRemoteText(runtime, target, edit, expected, signal, policy)))
    // 0.2.2 added these three methods for `apply_patch`. When the mounted
    // provider has them, route remote targets through the implementations
    // below. Older hosts keep the refusal: a missing method must not be
    // invented, and no official tool calls one there.
    if (patchMutationsAvailable(originals)) {
      restorers.push(replaceMethod(surface, 'patchText', (
        target: FsTarget, hunks: readonly PatchHunk[], expected?: { version: FsVersion },
        signal?: AbortSignal, policy?: SandboxExecutionPolicy,
      ) => patchRemoteText(runtime, target, hunks, expected, signal, policy)))
      restorers.push(replaceMethod(surface, 'deleteFile', (
        target: FsTarget, expected?: { version: FsVersion },
        signal?: AbortSignal, policy?: SandboxExecutionPolicy,
      ) => deleteRemoteFile(runtime, target, expected, signal, policy)))
      restorers.push(replaceMethod(surface, 'moveFile', (
        source: FsTarget, destination: FsTarget,
        options: { hunks?: readonly PatchHunk[], expectedSource?: { version: FsVersion }, expectedDestination?: FsWriteIntent },
        signal?: AbortSignal, policy?: SandboxExecutionPolicy,
      ) => moveRemoteFile(runtime, source, destination, options, signal, policy)))
    } else {
      guardRemoteMutation(surface, originals, restorers, 'patchText')
      guardRemoteMutation(surface, originals, restorers, 'deleteFile')
      guardRemoteMutation(surface, originals, restorers, 'moveFile')
    }
    Object.defineProperty(fs, MARKER, { value: true, configurable: true, enumerable: false })
  } catch (error) {
    for (const restore of restorers) restore()
    ctx.logger?.warn(`[@dsh-permission-remote] remote file tree skipped: ${errorText(error)}`)
    return undefined
  }
  const remove = (() => {
    for (const restore of restorers) restore()
    Reflect.deleteProperty(fs, MARKER)
  }) as RemoteTree
  const dropDescriptors = (hostId: string) => {
    const prefix = `${hostId}\0`
    for (const key of descriptors.keys()) {
      if (key.startsWith(prefix)) descriptors.delete(key)
    }
  }
  remove.invalidateHost = (hostId: string) => {
    meta.invalidateHost(hostId)
    for (const [key, record] of identity) {
      if (record.hostId === hostId) identity.delete(key)
    }
    for (const key of versions.keys()) {
      if (key.startsWith(`${hostId}\0`)) versions.delete(key)
    }
    dropDescriptors(hostId)
    for (const key of locks.keys()) {
      if (key.startsWith(`${hostId}\0`)) locks.delete(key)
    }
  }
  remove.forgetHostAttrs = (hostId: string) => {
    meta.forgetHostAttrs(hostId)
    dropDescriptors(hostId)
  }
  return remove
}

interface Runtime {
  readonly access: RemoteAccess
  readonly identity: Map<string, RemoteIdentity>
  readonly originals: Originals
  readonly meta: MetaCache
  readonly now: () => number
  readonly versions: Map<string, number>
  readonly descriptors: Map<string, { base: string } & RemoteVersionEvidence>
  readonly locks: Map<string, Promise<void>>
}

async function resolveRemote(runtime: Runtime, requested: string, opts?: { cwd?: string, signal?: AbortSignal }): Promise<FsTarget> {
  throwIfFsAborted(opts?.signal)
  if (requested.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const lexical = lexicalPath(requested, opts?.cwd)
  if (lexical === undefined) return runtime.originals.resolve(requested, opts)
  const route = routeByCwd(lexical)
  if (route.kind !== 'remote') return runtime.originals.resolve(requested, opts)
  const host = hostOf(runtime, route.hostId)
  try {
    const secret = await runtime.access.secret(host)
    throwIfFsAborted(opts?.signal)
    const remoteReal = await realRemote(runtime, host, secret, route.remoteCwd, opts?.signal)
    rememberIdentity(runtime, lexical, { hostId: route.hostId, remoteReal, at: runtime.now() })
    return { targetKey: FsTargetKey(lexical), displayPath: lexical }
  } catch (error) {
    throwIfFsAborted(opts?.signal)
    if (!isSoftFailure(error)) throw asFs(error, opts?.signal)
    // `workingDirectory.ensure` and `existsAsMarker` run before every model
    // step. A transport error there rejects `agent/pre-step` and the turn
    // never starts. A previous realpath still names the file. With none, the
    // placeholder spelling is enough for the following stat to decide.
    const stale = runtime.meta.realpath(host.id, route.remoteCwd, true)
    if (stale !== undefined) {
      rememberIdentity(runtime, lexical, { hostId: route.hostId, remoteReal: stale, at: runtime.now() })
    }
    return { targetKey: FsTargetKey(lexical), displayPath: lexical }
  }
}

async function lstatRemote(runtime: Runtime, requested: string, opts: { cwd?: string } | undefined, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
  throwIfFsAborted(signal)
  if (requested.trim().length === 0) throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
  const lexical = lexicalPath(requested, opts?.cwd)
  if (lexical === undefined) return runtime.originals.lstat(requested, opts, signal)
  const route = routeByCwd(lexical)
  if (route.kind !== 'remote') return runtime.originals.lstat(requested, opts, signal)
  const host = hostOf(runtime, route.hostId)
  try {
    const secret = await runtime.access.secret(host)
    throwIfFsAborted(signal)
    // This is deliberately not served from the attribute cache: a directory
    // can be replaced by a symlink between two sidebar clicks.
    const ticket = runtime.meta.attrTicket(host.id)
    const info = await uncachedAttrs(runtime, host, secret, route.remoteCwd, false, signal)
    throwIfFsAborted(signal)
    // Seen as a link: drop any realpath/attribute cache for it, so the next
    // resolve follows the current target instead of a stale one.
    if (info?.type === 'symlink') {
      runtime.identity.delete(lexical)
      runtime.meta.forgetRealpath(host.id, route.remoteCwd)
      runtime.meta.forgetAttrs(host.id, route.remoteCwd, true)
      runtime.meta.forgetAttrs(host.id, route.remoteCwd, false)
    }
    runtime.meta.rememberAttrs(host.id, route.remoteCwd, false, info, ticket)
    if (info === undefined) return undefined
    // `lstat` is the sidebar/existence fast path: do not spawn a shell `stat`
    // for every entry. A cached descriptor from a preceding `stat` is still
    // reused when its base matches; otherwise the weak listing base is enough
    // for display and a later guarded write fails closed as unavailable.
    return pathInfo(info, versionFor(runtime, host.id, route.remoteCwd, info))
  } catch (error) {
    return softenAttrs(error, signal, runtime.meta.attrs(host.id, route.remoteCwd, false, true), info => pathInfo(info, versionFor(runtime, host.id, route.remoteCwd, info)), () => runtime.originals.lstat(requested, opts, signal))
  }
}

async function statRemote(runtime: Runtime, target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
  const key = String(target.targetKey)
  const recorded = runtime.identity.get(key)
  // A fresh identity has already been through resolve. If there is none (for
  // example a child target created by listDir), verify the final component
  // before the follow-stat below can leave the workspace.
  if (recorded === undefined || !runtime.meta.isRealpathFresh(recorded.at)) {
    try {
      const verified = await verifiedPlace(runtime, target, 'any', signal)
      if (verified === undefined) return runtime.originals.stat(target, signal)
    } catch (error) {
      if (error instanceof FsError && error.code === 'FS_NOT_FOUND') return undefined
      const fallback = placeOf(runtime, target)
      if (fallback === undefined) return runtime.originals.stat(target, signal)
      return softenAttrs(error, signal, runtime.meta.attrs(fallback.host.id, fallback.remote, true, true), info => infoOf(info, versionFor(runtime, fallback.host.id, fallback.remote, info)), () => runtime.originals.stat(target, signal))
    }
  }
  const place = placeOf(runtime, target)
  if (place === undefined) return runtime.originals.stat(target, signal)
  throwIfFsAborted(signal)
  const fresh = runtime.meta.attrs(place.host.id, place.remote, true, false)
  if (fresh.hit) {
    if (fresh.value === undefined) return undefined
    if (fresh.value.type !== 'file') return infoOf(fresh.value, versionFor(runtime, place.host.id, place.remote, fresh.value))
    const versionKeyForPlace = versionKey(place.host.id, place.remote)
    const known = cachedEvidence(runtime, versionKeyForPlace, baseVersion(fresh.value))
    if (known !== undefined) return infoOf(fresh.value, versionFor(runtime, place.host.id, place.remote, fresh.value, known))
    const ticket = runtime.meta.attrTicket(place.host.id)
    const secret = await runtime.access.secret(place.host)
    const evidence = await remoteVersionEvidence(runtime.access.pool as unknown as SshPool, place.host, secret, place.remote, signal, { hash: true })
    if (runtime.meta.attrTicket(place.host.id) === ticket) rememberDescriptor(runtime, versionKeyForPlace, baseVersion(fresh.value), evidence)
    return infoOf(fresh.value, versionFor(runtime, place.host.id, place.remote, fresh.value, evidence))
  }
  try {
    const ticket = runtime.meta.attrTicket(place.host.id)
    const secret = await runtime.access.secret(place.host)
    const info = await attrsFor(runtime, place.host, secret, place.remote, true, signal)
    throwIfFsAborted(signal)
    if (runtime.meta.attrTicket(place.host.id) !== ticket) {
      return info === undefined ? undefined : infoOf(info, versionFor(runtime, place.host.id, place.remote, info))
    }
    runtime.meta.rememberAttrs(place.host.id, place.remote, true, info, ticket)
    const evidence = info === undefined || info.type !== 'file' ? {} : await remoteVersionEvidence(runtime.access.pool as unknown as SshPool, place.host, secret, place.remote, signal, { hash: true })
    if (runtime.meta.attrTicket(place.host.id) !== ticket) {
      return info === undefined ? undefined : infoOf(info, versionFor(runtime, place.host.id, place.remote, info, evidence))
    }
    if (info !== undefined) rememberDescriptor(runtime, versionKey(place.host.id, place.remote), baseVersion(info), evidence)
    return info === undefined ? undefined : infoOf(info, versionFor(runtime, place.host.id, place.remote, info, evidence))
  } catch (error) {
    return softenAttrs(error, signal, runtime.meta.attrs(place.host.id, place.remote, true, true), info => infoOf(info, versionFor(runtime, place.host.id, place.remote, info)), () => runtime.originals.stat(target, signal))
  }
}

async function listRemote(runtime: Runtime, target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
  const parentKey = String(target.targetKey)
  try {
    const place = await verifiedPlace(runtime, target, 'directory', signal)
    if (place === undefined) return runtime.originals.listDir(target, signal)
    throwIfFsAborted(signal)
    const secret = await runtime.access.secret(place.host)
    const info = await attrsFor(runtime, place.host, secret, place.remote, true, signal)
    throwIfFsAborted(signal)
    if (info === undefined) throw new FsError(`no entry at "${target.displayPath}"`, 'FS_NOT_FOUND')
    if (info.type !== 'directory') throw new FsError(`"${target.displayPath}" is not a directory`, 'FS_NOT_DIRECTORY')
    const rows = await runtime.access.pool.sftpReadDir(place.host, secret, place.remote)
    throwIfFsAborted(signal)
    const entries: FsDirEntry[] = []
    for (const row of rows) {
      if (row.name === '.' || row.name === '..' || row.name.length === 0 || row.name.includes('/') || row.name.includes('\\')) continue
      const childRemote = posix.join(place.remote, row.name)
      const child = await childEntry(runtime, place.host, secret, childRemote, row, signal)
      const childKey = path.join(parentKey, row.name)
      // A child that is a symlink now must not keep a stale realpath identity,
      // or containment would keep judging it by the old target while a listing
      // follows the link. Drop it so the next resolve re-probes.
      if (row.type === 'symlink') {
        runtime.identity.delete(String(childKey))
        runtime.meta.forgetRealpath(place.host.id, childRemote)
      }
      // `placeOf` routes this placeholder key on its own. Recording the joined
      // path would answer `contains` from the link's own path. Only `resolve`
      // realpaths a symlink, and only that result belongs in `identity`.
      const childBase = `${child.mtime}:${child.size ?? 0}`
      const childGeneration = generationFor(runtime, versionKey(place.host.id, childRemote))
      entries.push({
        name: row.name,
        type: child.type,
        target: { targetKey: FsTargetKey(childKey), displayPath: childKey },
        // Keep the same descriptor grammar as stat/write versions. A listing
        // token is weak by design; a consumer that needs a guard will get
        // `unavailable` instead of a misleading stale answer.
        version: remoteVersionToken({ base: childBase, ...(childGeneration !== undefined ? { generation: childGeneration } : {}) }),
        ...child.size === undefined ? {} : { size: child.size },
      })
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    return entries
  } catch (error) {
    throw asFs(error, signal)
  }
}

async function childEntry(
  runtime: Runtime,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  row: RemoteDirEntry,
  signal?: AbortSignal,
): Promise<{ type: 'file' | 'directory' | 'other', size?: number, mtime: number }> {
  if (row.type !== 'symlink') {
    const type = row.type === 'file' || row.type === 'directory' ? row.type : 'other'
    return { type, mtime: row.mtime, ...type === 'file' ? { size: row.size } : {} }
  }
  // A link to a directory has to list as a directory or the tree cannot expand it.
  // A link to a file stays `other`: opening uses `lstat`, which is still a
  // symlink, and the file panel rejects that as not a regular file.
  const followed = await attrsFor(runtime, host, secret, remotePath, true, signal)
  throwIfFsAborted(signal)
  if (followed?.type === 'directory') return { type: 'directory', mtime: followed.mtime }
  return { type: 'other', mtime: row.mtime }
}

async function readRemoteText(runtime: Runtime, target: FsTarget, signal?: AbortSignal): Promise<string> {
  const place = await verifiedPlace(runtime, target, 'file', signal)
  if (place === undefined) return runtime.originals.readText(target, signal)
  let total = 0
  let text = ''
  for await (const chunk of decodeRemoteText(runtime, place, target.displayPath, signal)) {
    total += Buffer.byteLength(chunk)
    if (total > TEXT_CAP) throw new FsError(`file is ${total} bytes, over the ${TEXT_CAP} byte limit`, 'FS_TOO_LARGE')
    text += chunk
  }
  return text
}

async function streamRemoteText(runtime: Runtime, target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
  const place = await verifiedPlace(runtime, target, 'file', signal)
  if (place === undefined) return runtime.originals.streamText(target, signal)
  return decodeRemoteText(runtime, place, target.displayPath, signal)
}

async function* decodeRemoteText(runtime: Runtime, place: Place, display: string, signal?: AbortSignal): AsyncGenerator<string> {
  throwIfFsAborted(signal)
  let chunks: AsyncIterable<Buffer>
  try {
    const secret = await runtime.access.secret(place.host)
    chunks = runtime.access.pool.sftpReadChunks(place.host, secret, place.remote, signal)
  } catch (error) {
    throw asFs(error, signal)
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for await (const chunk of chunks) {
      throwIfFsAborted(signal)
      if (chunk.includes(0)) throw new FsError(`"${display}" is not UTF-8 text`, 'FS_NOT_TEXT')
      const text = decodeChunk(decoder, chunk, true, display)
      if (text.length > 0) yield text
    }
    const tail = decodeChunk(decoder, undefined, false, display)
    if (tail.length > 0) yield tail
  } catch (error) {
    if (error instanceof FsError) throw error
    throw asFs(error, signal)
  }
}

function decodeChunk(decoder: TextDecoder, chunk: Buffer | undefined, stream: boolean, display: string): string {
  try {
    return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream })
  } catch (error) {
    if (error instanceof TypeError) throw new FsError(`"${display}" is not UTF-8 text`, 'FS_NOT_TEXT')
    throw error
  }
}

async function readRemoteBytes(runtime: Runtime, target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
  try {
    const place = await verifiedPlace(runtime, target, 'file', signal)
    if (place === undefined) return runtime.originals.readBytes(target, signal, maxBytes)
    throwIfFsAborted(signal)
    const secret = await runtime.access.secret(place.host)
    const data = await runtime.access.pool.sftpRead(place.host, secret, place.remote, maxBytes, signal)
    throwIfFsAborted(signal)
    return data
  } catch (error) {
    throw asFs(error, signal)
  }
}

async function readRemoteRange(
  runtime: Runtime,
  target: FsTarget,
  range: { offset: number, length: number },
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) || range.length < 0) {
    throw new FsError('read range is not a non-negative safe integer', 'FS_IO_ERROR')
  }
  try {
    // A zero-length range is still a request against the target: do not let a
    // directory or special file succeed just because no bytes are requested.
    const place = await verifiedPlace(runtime, target, 'file', signal)
    if (place === undefined) return runtime.originals.readByteRange(target, range, signal)
    throwIfFsAborted(signal)
    if (range.length === 0) return new Uint8Array()
    const secret = await runtime.access.secret(place.host)
    const data = await runtime.access.pool.sftpReadAt(place.host, secret, place.remote, range.offset, range.length)
    throwIfFsAborted(signal)
    return data
  } catch (error) {
    throw asFs(error, signal)
  }
}


/** Local filesystem parity: the diff basis is not read above this size. */
const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024

interface MutationContext {
  readonly host: HostConfig
  readonly secret: SecretMaterial
  readonly pool: SshPool
  readonly status: RunnerStatus
  readonly mode: SandboxMode
  readonly roots: Awaited<ReturnType<typeof remoteRoots>>
  readonly targetPath: string
}

/**
 * Resolve the remote path and enforce the session/policy sandbox boundary.
 *
 * A model `write`/`edit` always carries a `SandboxExecutionPolicy`; a missing
 * policy means a caller that cannot be checked, so a remote mutation fails
 * closed instead of silently using the local backend.
 */
async function mutationContext(
  runtime: Runtime,
  target: FsTarget,
  policy: SandboxExecutionPolicy | undefined,
  signal?: AbortSignal,
): Promise<MutationContext | undefined> {
  const key = String(target.targetKey)
  const route = routeByCwd(key)
  if (route.kind !== 'remote') return undefined
  throwIfFsAborted(signal)
  if (policy === undefined) throw new FsError('remote write requires a sandbox policy', 'FS_SANDBOX_DENIED')
  if (policy.mode === 'read-only') throw new FsError('remote write is not allowed by the current sandbox mode', 'FS_SANDBOX_DENIED')
  // The session's workspace root is the one source of containment. It cannot
  // come from the target: `workspaceBinding(key)` decodes the *second*
  // placeholder segment, which is the whole remote path for an absolute
  // spelling but only the workspace root for a relative one, so comparing the
  // two would reject every write that names a remote absolute path. Following
  // the link below then checks the realpath-resolved target against this root.
  const binding = workspaceBinding(policy.workspaceRoot)
  if (binding === null || binding.hostId !== route.hostId) {
    throw new FsError(`"${target.displayPath}" is outside the session's remote host`, 'FS_SANDBOX_DENIED')
  }
  if (runtime.access.allowsRemoteSession === undefined) {
    throw new FsError('this session cannot prove its remote workspace boundary', 'FS_SANDBOX_DENIED')
  }
  if (policy.sessionId === undefined || !runtime.access.allowsRemoteSession(String(policy.sessionId), route.hostId)) {
    throw new FsError('this session was not opened on that host', 'FS_SANDBOX_DENIED')
  }
  if (runtime.access.statusOf === undefined || runtime.access.pool.exec === undefined) {
    throw new FsError('remote writes are unavailable without a probe and exec pool', 'FS_IO_ERROR')
  }
  const host = hostOf(runtime, route.hostId)
  const secret = await runtime.access.secret(host)
  const pool = runtime.access.pool as unknown as SshPool
  const status = await runtime.access.statusOf(host)
  const targetPath = await resolveCreatedPath(pool, host, secret, route.remoteCwd)
  throwIfFsAborted(signal)
  const roots = await remoteRoots(status, binding.remotePath, pool, host, secret, true)
  throwIfFsAborted(signal)
  const mode = policy.mode
  // workspace-write includes the real temp roots; danger-full-access is the
  // explicit wider grant. The session/host binding above still applies.
  if (!fileWriteAllowed(mode, targetPath, roots)) {
    throw new FsError('remote write is not allowed by the current sandbox mode', 'FS_SANDBOX_DENIED')
  }
  return { host, secret, pool, status, mode, roots, targetPath }
}

/**
 * Move one identity to the most-recently-used end without changing its
 * timestamp. The `at` field is realpath freshness evidence, not LRU state; a
 * touch must never make a stale realpath look fresh.
 */
function touchIdentity(runtime: Runtime, key: string): void {
  const record = runtime.identity.get(key)
  if (record === undefined) return
  runtime.identity.delete(key)
  runtime.identity.set(key, record)
}

/**
 * Keep the lexical -> realpath identity small.
 *
 * `identity` is keyed by the placeholder spelling and had no size bound, so a
 * long session that resolved many distinct remote paths grew it monotonically.
 * This mirrors `MetaCache.write`: re-inserting a key moves it to the end and the
 * oldest entry is dropped once the map is over `META_CAP`. Evicting an identity
 * is safe but fail-closed: `containsRemote` returns false without one, so a
 * caller that keeps a target across hundreds of unrelated resolves can see a
 * spurious "outside the workspace". `containsRemote` touches both identities on
 * every successful hit, which keeps an actively used root young. A caller that
 * never calls `contains()` across more than `META_CAP` distinct resolves can
 * still hit the fail-closed false; that is the safe direction, and the next
 * `resolve` repairs it.
 */
function rememberIdentity(runtime: Runtime, key: string, record: RemoteIdentity): void {
  runtime.identity.delete(key)
  runtime.identity.set(key, record)
  while (runtime.identity.size > META_CAP) {
    const oldest = runtime.identity.keys().next().value
    if (oldest === undefined) break
    runtime.identity.delete(oldest)
  }
}

/** Resolve a mutation context before the local lock is taken. */
async function resolveMutationContext(
  runtime: Runtime,
  target: FsTarget,
  policy: SandboxExecutionPolicy | undefined,
  signal?: AbortSignal,
): Promise<MutationContext | undefined> {
  try {
    return await mutationContext(runtime, target, policy, signal)
  } catch (error) {
    throw asFs(error, signal)
  }
}

/**
 * The local lock key for one remote target.
 *
 * `route.remoteCwd` is only a lexically normalized spelling: a symlink alias,
 * or the whole-path and workspace-suffix placeholder spellings of one file, can
 * produce different `remoteCwd` values for the same remote file. The remote
 * `lockScript` hashes the realpath-resolved `context.targetPath`, but it only
 * wraps the commit exec. The LOCAL lock is what covers observation, decode,
 * diff and commit, so it must converge on the same resolved path too.
 * `mutationContext` resolves it through `resolveCreatedPath` before the lock.
 *
 * Hard links are NOT unified: `realpath` returns different spellings for two
 * names of the same inode, so they still take different local locks. The atomic
 * `mv` in the commit script prevents torn content, but a lost update between
 * two unguarded hard-link writers remains possible.
 */
function realpathLockKey(context: MutationContext): string {
  return `${context.host.id}\0${context.targetPath}`
}

async function withTargetLock<T>(runtime: Runtime, key: string, action: () => Promise<T>): Promise<T> {
  const previous = runtime.locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => gate)
  runtime.locks.set(key, tail)
  await previous
  try {
    return await action()
  } finally {
    release()
    if (runtime.locks.get(key) === tail) runtime.locks.delete(key)
  }
}

/**
 * Stat the target and derive its version.
 *
 * `capture` asks for the file bytes too. When the host needs a content hash for
 * version evidence, that hash already reads the whole file; handing the same
 * bytes back lets a caller that needs a diff basis (write, edit, patch, delete,
 * move) skip a second transfer. The bytes are only returned when they were
 * read, so a caller never mistakes an unread file for an empty one. A failed
 * capture is reported separately: the caller then knows retrying the same
 * capped read is pointless instead of silently attempting it again.
 */
async function currentRemoteAttrs(
  runtime: Runtime,
  context: MutationContext,
  signal?: AbortSignal,
  capture?: { maxBytes: number },
): Promise<{ info: SftpAttrs | undefined, version: FsVersion | undefined, content?: Buffer, captureFailed?: boolean }> {
  const info = await runtime.access.pool.sftpAttrs(context.host, context.secret, context.targetPath, true)
  throwIfFsAborted(signal)
  if (info === undefined) return { info, version: undefined }
  let captureFailed = false
  if (capture !== undefined && info.type === 'file') {
    // One read serves both the hash and the caller. A file over the caller's
    // cap still needs a version, so fall back to the hash-only path.
    let content: Buffer | undefined
    try {
      content = await runtime.access.pool.sftpRead(context.host, context.secret, context.targetPath, capture.maxBytes, signal)
    } catch (error) {
      if (signal?.aborted === true) throw asFs(error, signal)
      content = undefined
      captureFailed = true
    }
    throwIfFsAborted(signal)
    if (content !== undefined) {
      // One read feeds both the hash and the caller's diff basis, so the
      // version token and the text cannot disagree about what the file held.
      // `baseVersion(info)` still comes from the stat above, exactly as on the
      // hash-only path; the stat -> read ordering is unchanged by the reuse.
      const evidence = await remoteVersionEvidence(context.pool, context.host, context.secret, context.targetPath, signal, { hash: true, content })
      rememberDescriptor(runtime, versionKey(context.host.id, context.targetPath), baseVersion(info), evidence)
      return { info, version: versionFor(runtime, context.host.id, context.targetPath, info, evidence), content }
    }
  }
  const evidence = info.type === 'file'
    ? await remoteVersionEvidence(context.pool, context.host, context.secret, context.targetPath, signal, { hash: true })
    : {}
  rememberDescriptor(runtime, versionKey(context.host.id, context.targetPath), baseVersion(info), evidence)
  // Keep stat() and the write check on one version source. When a probe fails,
  // the current descriptor has no content proof; a guarded write then fails
  // closed as FS_IO_ERROR instead of claiming a false stale change.
  return {
    info,
    version: versionFor(runtime, context.host.id, context.targetPath, info, evidence),
    ...(captureFailed ? { captureFailed: true } : {}),
  }
}

async function writeRemoteText(
  runtime: Runtime,
  target: FsTarget,
  content: string,
  expected: FsWriteIntent | undefined,
  signal: AbortSignal | undefined,
  policy: SandboxExecutionPolicy | undefined,
): Promise<FsWriteOutcome> {
  refusePresentSnapshot(target, 'write to')
  const route = routeByCwd(String(target.targetKey))
  if (route.kind !== 'remote') return runtime.originals.writeText(target, content, expected, signal, policy)
  const context = await resolveMutationContext(runtime, target, policy, signal)
  if (context === undefined) return runtime.originals.writeText(target, content, expected, signal, policy)
  return withTargetLock(runtime, realpathLockKey(context), () => writeRemoteTextUnlocked(runtime, context, target, content, expected, signal))
}

async function writeRemoteTextUnlocked(
  runtime: Runtime,
  context: MutationContext,
  target: FsTarget,
  content: string,
  expected: FsWriteIntent | undefined,
  signal: AbortSignal | undefined,
): Promise<FsWriteOutcome> {
  throwIfFsAborted(signal)
  let existing: SftpAttrs | undefined
  let existingVersion: FsVersion | undefined
  let basis: Buffer | undefined
  let captureFailed = false
  // Only capture when a diff basis is actually wanted. A write of huge content
  // needs no basis; reading the old file just to hash it would add a transfer
  // that the strong-stat path never made before.
  const wantBasis = Buffer.byteLength(content, 'utf8') < DIFF_BASIS_MAX_BYTES
  try {
    const current = await currentRemoteAttrs(runtime, context, signal, wantBasis ? { maxBytes: DIFF_BASIS_MAX_BYTES } : undefined)
    existing = current.info
    existingVersion = current.version
    basis = current.content
    captureFailed = current.captureFailed === true
  } catch (error) {
    throw asFs(error, signal)
  }
  if (existing !== undefined && existing.type !== 'file') {
    throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  if (expected?.kind === 'replaceIfVersion') {
    if (existing === undefined || existingVersion === undefined) {
      throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    const comparison = compareRemoteVersion(expected.version, existingVersion)
    if (comparison === 'unavailable') {
      throw new FsError(`cannot verify "${target.displayPath}" before writing: remote version evidence is unavailable`, 'FS_IO_ERROR')
    }
    if (comparison !== 'match') {
      throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
  } else if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
    throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
  }

  let before: string | null = null
  // A failed capture already proved the old file is over the cap; retrying the
  // same capped read would only add a doomed SFTP round-trip.
  if (existing !== undefined && wantBasis && !captureFailed) {
    try {
      // Reuse the version probe's bytes when it captured them; only fall back to
      // a separate read when the file was too large for that capture.
      const raw = basis ?? await runtime.access.pool.sftpRead(context.host, context.secret, context.targetPath, DIFF_BASIS_MAX_BYTES, signal)
      throwIfFsAborted(signal)
      if (!raw.includes(0)) before = normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(raw))
    } catch (error) {
      if (error instanceof FsError) throw error
      // A stale/binary/oversize diff basis is presentation data only; the
      // write below still has to succeed like the local backend.
      before = null
    }
  }
  try {
    await commitRemoteText(context.pool, context.host, context.secret, context.status, context.mode, context.roots, context.targetPath, content, signal, existing?.mode, expected)
  } catch (error) {
    rethrowCommitFailure(runtime, context, error, signal)
  }
  runtime.meta.forgetAttrs(context.host.id, context.targetPath, true)
  runtime.meta.forgetRealpath(context.host.id, context.targetPath)
  let afterInfo: SftpAttrs | undefined
  try {
    afterInfo = await runtime.access.pool.sftpAttrs(context.host, context.secret, context.targetPath, true)
  } catch (error) {
    throw asFs(error, signal)
  }
  if (afterInfo === undefined) {
    throw new FsError(`"${target.displayPath}" disappeared while its write was being verified`, 'FS_IO_ERROR')
  }
  // `content` is exactly what was written over stdin (UTF-8 bytes, no line
  // ending rewrite inside commitRemoteText). Reuse it for the hash so a
  // seconds-only stat host does not re-read the whole file after the commit.
  // Strong stat evidence still wins, and the 32 MiB hash bound still applies.
  const evidence = await remoteVersionEvidence(context.pool, context.host, context.secret, context.targetPath, signal, { hash: true, content: Buffer.from(content) })
  const version = bumpVersion(runtime, context.host.id, context.targetPath, afterInfo, evidence)
  return {
    operation: existing === undefined ? 'create' : 'update',
    version,
    before,
    after: normalizeLineEndings(content),
  }
}

function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

function detectLineEndings(raw: string): 'LF' | 'CRLF' {
  const sample = raw.slice(0, 4096)
  const crlf = sample.split('\r\n').length - 1
  return crlf > sample.split('\n').length - 1 - crlf ? 'CRLF' : 'LF'
}

function restoreLineEndings(content: string, lineEndings: 'LF' | 'CRLF'): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string, replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  if (!replaceAll && replacements > 1) {
    throw new FsError(`old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`, 'FS_AMBIGUOUS_EDIT')
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}

async function editRemoteText(
  runtime: Runtime,
  target: FsTarget,
  edit: FsEditRequest,
  expected: { version: FsVersion } | undefined,
  signal: AbortSignal | undefined,
  policy: SandboxExecutionPolicy | undefined,
): Promise<FsEditOutcome> {
  refusePresentSnapshot(target, 'edit')
  const route = routeByCwd(String(target.targetKey))
  if (route.kind !== 'remote') return runtime.originals.editText(target, edit, expected, signal, policy)
  const context = await resolveMutationContext(runtime, target, policy, signal)
  if (context === undefined) return runtime.originals.editText(target, edit, expected, signal, policy)
  return withTargetLock(runtime, realpathLockKey(context), () => editRemoteTextUnlocked(runtime, context, target, edit, expected, signal))
}

async function editRemoteTextUnlocked(
  runtime: Runtime,
  context: MutationContext,
  target: FsTarget,
  edit: FsEditRequest,
  expected: { version: FsVersion } | undefined,
  signal: AbortSignal | undefined,
): Promise<FsEditOutcome> {
  throwIfFsAborted(signal)
  let existing: SftpAttrs | undefined
  let currentVersion: FsVersion | undefined
  let captured: Buffer | undefined
  try {
    // The version probe may read the whole file; keep those bytes for the edit
    // instead of transferring the same file a second time below.
    const current = await currentRemoteAttrs(runtime, context, signal, { maxBytes: TEXT_CAP })
    existing = current.info
    currentVersion = current.version
    captured = current.content
  } catch (error) {
    throw asFs(error, signal)
  }
  if (existing === undefined) {
    throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
  }
  if (existing.type !== 'file') {
    throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  if (expected !== undefined) {
    if (currentVersion === undefined) {
      throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    const comparison = compareRemoteVersion(expected.version, currentVersion)
    if (comparison === 'unavailable') {
      throw new FsError(`cannot verify "${target.displayPath}" before editing: remote version evidence is unavailable`, 'FS_IO_ERROR')
    }
    if (comparison !== 'match') {
      throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
  }
  let raw: Buffer
  if (captured !== undefined) {
    raw = captured
  } else {
    try {
      raw = await runtime.access.pool.sftpRead(context.host, context.secret, context.targetPath, TEXT_CAP, signal)
    } catch (error) {
      throw asFs(error, signal)
    }
    throwIfFsAborted(signal)
  }
  if (raw.includes(0)) throw new FsError(`cannot edit "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new FsError(`cannot edit "${target.displayPath}": not UTF-8 text`, 'FS_NOT_TEXT')
  }
  const before = normalizeLineEndings(decoded)
  const edited = applyLiteralEdit(before, edit.oldString, edit.newString, edit.replaceAll, target.displayPath)
  const content = restoreLineEndings(edited.content, detectLineEndings(decoded))
  try {
    await commitRemoteText(context.pool, context.host, context.secret, context.status, context.mode, context.roots, context.targetPath, content, signal, existing.mode, expected === undefined ? undefined : { kind: 'replaceIfVersion', version: expected.version })
  } catch (error) {
    rethrowCommitFailure(runtime, context, error, signal)
  }
  runtime.meta.forgetAttrs(context.host.id, context.targetPath, true)
  runtime.meta.forgetRealpath(context.host.id, context.targetPath)
  let afterInfo: SftpAttrs | undefined
  try {
    afterInfo = await runtime.access.pool.sftpAttrs(context.host, context.secret, context.targetPath, true)
  } catch (error) {
    throw asFs(error, signal)
  }
  if (afterInfo === undefined) {
    throw new FsError(`"${target.displayPath}" disappeared while its edit was being verified`, 'FS_IO_ERROR')
  }
  // `content` is the CRLF-restored string actually sent over stdin; the
  // returned `after` is LF-normalized and must NOT be hashed here.
  const evidence = await remoteVersionEvidence(context.pool, context.host, context.secret, context.targetPath, signal, { hash: true, content: Buffer.from(content) })
  const afterVersion = bumpVersion(runtime, context.host.id, context.targetPath, afterInfo, evidence)
  return { version: afterVersion, before, after: edited.content }
}

/** Whether the mounted provider publishes the 0.2.2 patch mutations. */
function patchMutationsAvailable(originals: Originals): boolean {
  return typeof originals.patchText === 'function'
    && typeof originals.deleteFile === 'function'
    && typeof originals.moveFile === 'function'
}

/** Serialize a mutation that touches two paths without deadlocking. */
async function withTargetLocks<T>(runtime: Runtime, keys: string[], action: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort()
  const step = (index: number): Promise<T> => index >= ordered.length
    ? action()
    : withTargetLock(runtime, ordered[index]!, () => step(index + 1))
  return step(0)
}

/**
 * Drop the cached facts about a path after it was created, changed or removed.
 *
 * Only the attribute and realpath caches are invalidated, matching what
 * `writeText` / `editText` already do. Two things are deliberately left alone:
 *
 * - `runtime.versions` (the per-path generation counter): `bumpVersion`
 *   documents that it must stay monotonic for the lifetime of the patch,
 *   because resetting it could make a later write reuse an older generation and
 *   compare equal to a stale token.
 * - `runtime.identity` (lexical -> realpath): `containsRemote` fails closed when
 *   an identity is missing, so dropping it would make `ctx.fs.contains()` return
 *   false for a path that was just written. The next `resolve` refreshes it.
 *
 * The version side is refreshed by the caller's own `sftpAttrs` + `bumpVersion`
 * probe.
 */
function forgetTarget(runtime: Runtime, hostId: string, remotePath: string): void {
  runtime.meta.forgetAttrs(hostId, remotePath, true)
  runtime.meta.forgetAttrs(hostId, remotePath, false)
  runtime.meta.forgetRealpath(hostId, remotePath)
}

/**
 * Surface a failed remote commit, dropping any cache that could describe the
 * pre-commit state.
 *
 * A remote command can fail AFTER it changed the file: `mv` may have run and a
 * later `chmod` failed, or the transport may drop after the rename. The
 * official `apply_patch` tells `failed` from `unknown` by re-`stat`ing the
 * target and comparing versions (`unchanged`), and `statRemote` serves a cached
 * attribute for up to 5 seconds. Keeping that cache would report the old version
 * and turn a possibly-applied operation into `failed`. `FS_IO_ERROR` and
 * `FS_ABORTED` are exactly the two codes whose effect is uncertain; the guard
 * codes (stale/sandbox/not-observed) are decided before the rename, so their
 * cache stays valid.
 */
function rethrowCommitFailure(
  runtime: Runtime,
  context: MutationContext,
  error: unknown,
  signal: AbortSignal | undefined,
): never {
  const failure = asFs(error, signal)
  // Any commit failure can be ambiguous: the rename may already have happened
  // and a later step or the transport failed. Dropping the cache costs one
  // re-probe and removes a whole class of "reported failed but actually
  // applied" misjudgements, whatever code the failure mapped to.
  forgetTarget(runtime, context.host.id, context.targetPath)
  throw failure
}

interface RemoteSourceState {
  readonly context: MutationContext
  readonly info: SftpAttrs
  readonly version: FsVersion
  /** The file bytes, present only when the caller asked to capture them. */
  readonly content?: Buffer
  /** True when the capture was attempted but the file exceeded its byte cap. */
  readonly captureFailed?: boolean
}

/**
 * Common pre-check for patch/delete/move sources.
 *
 * The lstat on the lexical spelling is what keeps a delete or move from
 * following a final symlink and removing its target. `currentRemoteAttrs`
 * supplies the version evidence used by the compare-and-swap guard and by the
 * remote shell script; both see the same realpath-resolved target.
 */
async function requireRemoteFile(
  runtime: Runtime,
  context: MutationContext,
  target: FsTarget,
  expected: { version: FsVersion } | undefined,
  signal: AbortSignal | undefined,
  verb: 'patch' | 'delete' | 'move',
  rejectFinalSymlink: boolean,
  capture?: { maxBytes: number },
): Promise<RemoteSourceState> {
  throwIfFsAborted(signal)
  const route = routeByCwd(String(target.targetKey))
  if (route.kind !== 'remote') {
    throw new FsError(`cannot ${verb} "${target.displayPath}": not a remote target`, 'FS_IO_ERROR')
  }
  let info: SftpAttrs | undefined
  try {
    info = await uncachedAttrs(runtime, context.host, context.secret, route.remoteCwd, false, signal)
  } catch (error) {
    throw asFs(error, signal)
  }
  if (info === undefined) {
    throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
  }
  // A delete or move must never follow a final symlink: `rm` on the resolved
  // target would remove a different file than the one the patch named. The
  // official apply_patch preflight refuses those too (PATCH_SYMLINK_SOURCE).
  // `patchText` is different: the official tool resolves the path first and the
  // local backend patches through a symlink, so refusing here would be a remote
  // only divergence. Its target still has to be a regular file after following.
  if (info.type === 'symlink' && rejectFinalSymlink) {
    throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_PERMISSION_DENIED')
  }
  if (info.type !== 'file' && info.type !== 'symlink') {
    throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  let version: FsVersion | undefined
  let followed: SftpAttrs | undefined
  let content: Buffer | undefined
  let captureFailed: boolean | undefined
  try {
    const current = await currentRemoteAttrs(runtime, context, signal, capture)
    version = current.version
    followed = current.info
    content = current.content
    captureFailed = current.captureFailed
  } catch (error) {
    throw asFs(error, signal)
  }
  if (followed !== undefined && followed.type !== 'file') {
    throw new FsError(`cannot ${verb} "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  if (version === undefined) {
    throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
  }
  if (expected !== undefined) {
    const comparison = compareRemoteVersion(expected.version, version)
    if (comparison === 'unavailable') {
      throw new FsError(`cannot verify "${target.displayPath}" before ${verb}: remote version evidence is unavailable`, 'FS_IO_ERROR')
    }
    if (comparison !== 'match') {
      throw new FsError(`cannot ${verb} "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
  }
  // Return the *followed* attributes, not the lstat ones. A final symlink's
  // lstat mode carries S_IFLNK (for example 0o120777); passing `mode & 0o7777`
  // to the atomic write would chmod the target file 0777. The callers use
  // `info.mode` to preserve the file's permission bits on commit, so it must be
  // the target file's mode. `followed` is undefined only when the follow-stat
  // found nothing, which the version check above already rejects.
  return {
    context,
    info: followed ?? info,
    version,
    ...(content === undefined ? {} : { content }),
    ...(captureFailed === true ? { captureFailed: true } : {}),
  }
}

/**
 * Decode one remote UTF-8 file, keeping its line-ending style for the commit.
 *
 * `content` skips the transfer when the caller already has the bytes: the
 * version probe reads the whole file on hosts without nanosecond stat, and
 * reading it again just to decode it doubles that cost.
 */
async function readRemoteSourceText(
  runtime: Runtime,
  context: MutationContext,
  target: FsTarget,
  signal?: AbortSignal,
  content?: Buffer,
): Promise<{ before: string, lineEndings: 'LF' | 'CRLF' }> {
  let raw: Buffer
  if (content !== undefined) {
    raw = content
  } else {
    try {
      raw = await runtime.access.pool.sftpRead(context.host, context.secret, context.targetPath, TEXT_CAP, signal)
    } catch (error) {
      throw asFs(error, signal)
    }
    throwIfFsAborted(signal)
  }
  if (raw.includes(0)) throw new FsError(`cannot edit "${target.displayPath}": binary file`, 'FS_NOT_TEXT')
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new FsError(`cannot edit "${target.displayPath}": not UTF-8 text`, 'FS_NOT_TEXT')
  }
  return { before: normalizeLineEndings(decoded), lineEndings: detectLineEndings(decoded) }
}

/** Bounded LF-normalized content for a diff card; unavailable basis is null. */
async function boundedRemoteBefore(
  runtime: Runtime,
  context: MutationContext,
  signal?: AbortSignal,
  content?: Buffer,
  captureFailed = false,
): Promise<string | null> {
  // The version probe already tried and failed to read this file within the
  // same cap; a second read cannot succeed. The diff basis is presentation
  // data only, so report it as unavailable instead of repeating the transfer.
  if (captureFailed) return null
  try {
    // Reuse the bytes the version probe already read instead of transferring
    // the same file a second time on hosts without nanosecond stat.
    const raw = content ?? await runtime.access.pool.sftpRead(context.host, context.secret, context.targetPath, DIFF_BASIS_MAX_BYTES, signal)
    throwIfFsAborted(signal)
    if (raw.includes(0)) return null
    return normalizeLineEndings(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch (error) {
    if (error instanceof FsError) throw error
    return null
  }
}

/** Post-write verification shared by patch and move. */
async function versionAfterRemoteWrite(
  runtime: Runtime,
  context: MutationContext,
  target: FsTarget,
  committedContent: string,
  signal?: AbortSignal,
): Promise<FsVersion> {
  forgetTarget(runtime, context.host.id, context.targetPath)
  let afterInfo: SftpAttrs | undefined
  try {
    afterInfo = await runtime.access.pool.sftpAttrs(context.host, context.secret, context.targetPath, true)
  } catch (error) {
    throw asFs(error, signal)
  }
  if (afterInfo === undefined) {
    throw new FsError(`"${target.displayPath}" disappeared while its write was being verified`, 'FS_IO_ERROR')
  }
  // `committedContent` is the exact string written over stdin, already
  // line-ending restored. Hashing those bytes removes the post-write full read
  // on a seconds-only stat host; strong stat evidence still wins and the
  // 32 MiB hash bound still applies.
  const evidence = await remoteVersionEvidence(context.pool, context.host, context.secret, context.targetPath, signal, { hash: true, content: Buffer.from(committedContent) })
  return bumpVersion(runtime, context.host.id, context.targetPath, afterInfo, evidence)
}

function patchFailureError(target: FsTarget, failure: { hunkLineNumber: number, stage: string }): FsError {
  return new FsError(
    `cannot patch "${target.displayPath}": hunk at patch line ${failure.hunkLineNumber} (${failure.stage}) does not match`,
    'FS_PATCH_MISMATCH',
  )
}

async function patchRemoteText(
  runtime: Runtime,
  target: FsTarget,
  hunks: readonly PatchHunk[],
  expected: { version: FsVersion } | undefined,
  signal: AbortSignal | undefined,
  policy: SandboxExecutionPolicy | undefined,
): Promise<FsEditOutcome> {
  refusePresentSnapshot(target, 'patch')
  const route = routeByCwd(String(target.targetKey))
  if (route.kind !== 'remote') return runtime.originals.patchText!(target, hunks, expected, signal, policy)
  const context = await resolveMutationContext(runtime, target, policy, signal)
  if (context === undefined) return runtime.originals.patchText!(target, hunks, expected, signal, policy)
  return withTargetLock(runtime, realpathLockKey(context), () =>
    patchRemoteTextUnlocked(runtime, context, target, hunks, expected, signal))
}

async function patchRemoteTextUnlocked(
  runtime: Runtime,
  context: MutationContext,
  target: FsTarget,
  hunks: readonly PatchHunk[],
  expected: { version: FsVersion } | undefined,
  signal: AbortSignal | undefined,
): Promise<FsEditOutcome> {
  // `requireRemoteFile` hashes the file for version evidence on hosts without
  // nanosecond stat; capturing those bytes here means the text comes from the
  // same transfer instead of a second full read.
  const { info, content } = await requireRemoteFile(runtime, context, target, expected, signal, 'patch', false, { maxBytes: TEXT_CAP })
  const { before, lineEndings } = await readRemoteSourceText(runtime, context, target, signal, content)
  const result = applyHunks(before, hunks)
  if (!result.ok) throw patchFailureError(target, result.failure)
  const after = result.after
  const committed = restoreLineEndings(after, lineEndings)
  try {
    await commitRemoteText(
      context.pool, context.host, context.secret, context.status, context.mode, context.roots,
      context.targetPath, committed, signal, info.mode,
      expected === undefined ? undefined : { kind: 'replaceIfVersion', version: expected.version },
    )
  } catch (error) {
    rethrowCommitFailure(runtime, context, error, signal)
  }
  const version = await versionAfterRemoteWrite(runtime, context, target, committed, signal)
  return { version, before, after }
}

async function deleteRemoteFile(
  runtime: Runtime,
  target: FsTarget,
  expected: { version: FsVersion } | undefined,
  signal: AbortSignal | undefined,
  policy: SandboxExecutionPolicy | undefined,
): Promise<FsDeleteOutcome> {
  refusePresentSnapshot(target, 'delete')
  const route = routeByCwd(String(target.targetKey))
  if (route.kind !== 'remote') return runtime.originals.deleteFile!(target, expected, signal, policy)
  const context = await resolveMutationContext(runtime, target, policy, signal)
  if (context === undefined) return runtime.originals.deleteFile!(target, expected, signal, policy)
  return withTargetLock(runtime, realpathLockKey(context), () =>
    deleteRemoteFileUnlocked(runtime, context, target, expected, signal))
}

async function deleteRemoteFileUnlocked(
  runtime: Runtime,
  context: MutationContext,
  target: FsTarget,
  expected: { version: FsVersion } | undefined,
  signal: AbortSignal | undefined,
): Promise<FsDeleteOutcome> {
  const { content, captureFailed } = await requireRemoteFile(runtime, context, target, expected, signal, 'delete', true, { maxBytes: DIFF_BASIS_MAX_BYTES })
  const before = await boundedRemoteBefore(runtime, context, signal, content, captureFailed)
  try {
    await commitRemoteDelete(
      context.pool, context.host, context.secret, context.status, context.mode, context.roots,
      context.targetPath, signal, expected,
    )
  } catch (error) {
    rethrowCommitFailure(runtime, context, error, signal)
  }
  forgetTarget(runtime, context.host.id, context.targetPath)
  return { before }
}

async function moveRemoteFile(
  runtime: Runtime,
  source: FsTarget,
  destination: FsTarget,
  options: { hunks?: readonly PatchHunk[], expectedSource?: { version: FsVersion }, expectedDestination?: FsWriteIntent } = {},
  signal: AbortSignal | undefined = undefined,
  policy: SandboxExecutionPolicy | undefined = undefined,
): Promise<FsMoveOutcome> {
  // Either end of a move can be the snapshot: writing it as the destination
  // would replace frozen bytes, and moving it away would break a card's path.
  refusePresentSnapshot(source, 'move')
  refusePresentSnapshot(destination, 'move onto')
  const sourceRoute = routeByCwd(String(source.targetKey))
  const destinationRoute = routeByCwd(String(destination.targetKey))
  if (sourceRoute.kind !== 'remote' && destinationRoute.kind !== 'remote') {
    return runtime.originals.moveFile!(source, destination, options, signal, policy)
  }
  if (sourceRoute.kind !== 'remote' || destinationRoute.kind !== 'remote' || sourceRoute.hostId !== destinationRoute.hostId) {
    throw new FsError('cannot move between a remote workspace and this computer', 'FS_SANDBOX_DENIED')
  }
  if (String(source.targetKey) === String(destination.targetKey)) {
    throw new FsError(`cannot move "${source.displayPath}" to itself`, 'FS_SAME_TARGET')
  }
  // Resolve both realpaths before locking: the lock keys must agree with
  // write/edit/patch/delete on the resolved remote path, and a move needs both
  // keys in a stable (sorted) order to avoid deadlocking two concurrent moves.
  const sourceContext = await resolveMutationContext(runtime, source, policy, signal)
  const destinationContext = await resolveMutationContext(runtime, destination, policy, signal)
  if (sourceContext === undefined || destinationContext === undefined) {
    throw new FsError(`cannot move "${source.displayPath}" to a non-remote destination`, 'FS_SANDBOX_DENIED')
  }
  return withTargetLocks(runtime, [
    realpathLockKey(sourceContext),
    realpathLockKey(destinationContext),
  ], () => moveRemoteFileUnlocked(runtime, sourceContext, destinationContext, source, destination, options, signal))
}

async function moveRemoteFileUnlocked(
  runtime: Runtime,
  sourceContext: MutationContext,
  destinationContext: MutationContext,
  source: FsTarget,
  destination: FsTarget,
  options: { hunks?: readonly PatchHunk[], expectedSource?: { version: FsVersion }, expectedDestination?: FsWriteIntent },
  signal: AbortSignal | undefined,
): Promise<FsMoveOutcome> {
  const { info: sourceInfo, content: sourceContent, captureFailed: sourceCaptureFailed } = await requireRemoteFile(runtime, sourceContext, source, options.expectedSource, signal, 'move', true, { maxBytes: TEXT_CAP })
  // One remote file has two placeholder spellings: the whole path encoded in
  // one segment, or the workspace root encoded plus a relative suffix. They are
  // different `targetKey`s but the same file, so the string comparison above
  // cannot see it. Publishing the destination and then deleting the source
  // would destroy that file, so compare the realpath-resolved targets and
  // refuse a same-file move as FS_SAME_TARGET, like the local backend.
  if (sourceContext.targetPath === destinationContext.targetPath) {
    throw new FsError(`cannot move "${source.displayPath}" to itself`, 'FS_SAME_TARGET')
  }
  // Destination version/intent checks come FIRST, matching the local backend's
  // error precedence: a stale destination is reported before a hunk mismatch.
  // The captured source bytes are the only size information available before
  // the source is decoded; they decide whether a destination diff basis is
  // worth reading. `restoreLineEndings` / hunks may change the final size, so
  // this is an estimate for presentation data, not a correctness boundary.
  const wantDestinationBasis = sourceCaptureFailed !== true
    && (sourceContent === undefined || sourceContent.length < DIFF_BASIS_MAX_BYTES)
  let existing: SftpAttrs | undefined
  let existingVersion: FsVersion | undefined
  let destinationBasis: Buffer | undefined
  let destinationCaptureFailed = false
  try {
    const current = await currentRemoteAttrs(runtime, destinationContext, signal, wantDestinationBasis ? { maxBytes: DIFF_BASIS_MAX_BYTES } : undefined)
    existing = current.info
    existingVersion = current.version
    destinationBasis = current.content
    destinationCaptureFailed = current.captureFailed === true
  } catch (error) {
    throw asFs(error, signal)
  }
  if (existing !== undefined && existing.type !== 'file') {
    throw new FsError(`cannot write "${destination.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  const intent = options.expectedDestination
  if (intent?.kind === 'createIfAbsent' && existing !== undefined) {
    throw new FsError(`cannot overwrite existing "${destination.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
  }
  if (intent?.kind === 'replaceIfVersion') {
    if (existing === undefined || existingVersion === undefined) {
      throw new FsError(`cannot write "${destination.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
    const comparison = compareRemoteVersion(intent.version, existingVersion)
    if (comparison === 'unavailable') {
      throw new FsError(`cannot verify "${destination.displayPath}" before writing: remote version evidence is unavailable`, 'FS_IO_ERROR')
    }
    if (comparison !== 'match') {
      throw new FsError(`cannot write "${destination.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
    }
  }
  // Decode only after the destination checks, reusing the captured source bytes
  // so the source text still costs no second transfer.
  const { before: sourceText, lineEndings } = await readRemoteSourceText(runtime, sourceContext, source, signal, sourceContent)
  let after = sourceText
  if (options.hunks !== undefined) {
    const result = applyHunks(sourceText, options.hunks)
    if (!result.ok) throw patchFailureError(source, result.failure)
    after = result.after
  }
  const content = restoreLineEndings(after, lineEndings)
  // Match the local backend's bounded diffs: `sourceBefore` is judged on the
  // source text it returns, the destination basis on the content being written.
  const sourceBefore = Buffer.byteLength(sourceText, 'utf8') < DIFF_BASIS_MAX_BYTES ? sourceText : null
  const destinationBefore = existing !== undefined && wantDestinationBasis
    ? await boundedRemoteBefore(runtime, destinationContext, signal, destinationBasis, destinationCaptureFailed)
    : null
  try {
    await commitRemoteText(
      destinationContext.pool, destinationContext.host, destinationContext.secret,
      destinationContext.status, destinationContext.mode, destinationContext.roots,
      destinationContext.targetPath, content, signal, sourceInfo.mode, intent,
    )
  } catch (error) {
    rethrowCommitFailure(runtime, destinationContext, error, signal)
  }
  const destinationOutcome: FsWriteOutcome = {
    operation: existing === undefined ? 'create' : 'update',
    version: await versionAfterRemoteWrite(runtime, destinationContext, destination, content, signal),
    before: destinationBefore,
    after,
  }
  // The destination is already published. A failed source removal is reported,
  // not rolled back: this is the same contract as the local backend.
  try {
    await commitRemoteDelete(
      sourceContext.pool, sourceContext.host, sourceContext.secret,
      sourceContext.status, sourceContext.mode, sourceContext.roots,
      sourceContext.targetPath, signal, options.expectedSource,
    )
  } catch (error) {
    const failure = asFs(error, signal)
    if (failure.code === 'FS_IO_ERROR' || failure.code === 'FS_ABORTED') {
      forgetTarget(runtime, sourceContext.host.id, sourceContext.targetPath)
    }
    return {
      sourceBefore,
      destination: destinationOutcome,
      sourceDeleted: false,
      sourceFailure: { code: failure.code, message: failure.message },
    }
  }
  forgetTarget(runtime, sourceContext.host.id, sourceContext.targetPath)
  return { sourceBefore, destination: destinationOutcome, sourceDeleted: true }
}

/**
 * Containment uses only paths `resolve` already realpath'd. Falling back to
 * the placeholder spelling would keep a symlink whose target is `/etc` inside
 * the workspace, because that spelling still sits under the placeholder. When
 * a remote placeholder has no realpath yet, fail closed; only paths that route
 * locally may use the original lexical check.
 */
function containsRemote(runtime: Runtime, parent: FsTarget, child: FsTarget): boolean {
  const rawLeft = runtime.identity.get(String(parent.targetKey))
  const rawRight = runtime.identity.get(String(child.targetKey))
  const left = rawLeft !== undefined && runtime.meta.isRealpathFresh(rawLeft.at) ? rawLeft : undefined
  const right = rawRight !== undefined && runtime.meta.isRealpathFresh(rawRight.at) ? rawRight : undefined
  if (left !== undefined && right !== undefined) {
    // LRU touch: a long-lived root that is checked regularly must not age out
    // just because unrelated paths were resolved in between.
    touchIdentity(runtime, String(parent.targetKey))
    touchIdentity(runtime, String(child.targetKey))
    if (left.hostId !== right.hostId) return false
    return remotePathInside(left.remoteReal, right.remoteReal)
  }
  if (left !== undefined || right !== undefined) return false
  if (routeByCwd(String(parent.targetKey)).kind === 'remote' || routeByCwd(String(child.targetKey)).kind === 'remote') return false
  return runtime.originals.contains(parent, child)
}

/**
 * OpenSSH's `readlink` of a non-link is EINVAL, which the server reports as
 * status Failure. "No such file" is the same answer on some other servers.
 * Permission denied and an unsupported readlink are not that answer.
 */
const NOT_A_LINK = /not a symbolic link|not a symlink|^failure$|^invalid argument$/i

/**
 * Whether `readlink` failed because the path is not a link.
 *
 * SFTP has no dedicated code for this: OpenSSH answers EINVAL, which reaches us
 * as `FAILURE` with "Invalid argument", and some servers send a bare "Failure".
 * A `NO_SUCH_FILE` or permission code is a different answer and is handled by
 * the caller. Guessing from text is only safe because every server that says
 * something else is treated as unknown, which fails closed.
 */
function isNotALink(error: unknown): boolean {
  if (!(error instanceof SshFailure)) return false
  if (error.status !== undefined && error.status !== SFTP_STATUS.FAILURE) return false
  return NOT_A_LINK.test(error.message.trim())
}

/**
 * STAT without `SSH_FILEXFER_ATTR_PERMISSIONS` has no mode, and ssh2 then
 * reports every type as false. A successful `OPENDIR` means this path is a
 * directory; the names are not read. Any other open error, other than
 * permission or absence, is a non-directory that already had attributes: the
 * file panel treats that as a file. OpenSSH sends a mode, so this probe does
 * not run there.
 *
 * `lstat` must not use that listing first. `readdir` follows a symlink, so a
 * link to a file would be reported as a file and `locateFile` would read the
 * target. A `readlink` target proves a symlink. Only a not-a-link error may
 * fall through to the listing. Anything else stays `other`.
 */
async function attrsFor(
  runtime: Runtime,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  follow: boolean,
  signal?: AbortSignal,
): Promise<SftpAttrs | undefined> {
  const fresh = runtime.meta.attrs(host.id, remotePath, follow, false)
  if (fresh.hit) return fresh.value
  const ticket = runtime.meta.attrTicket(host.id)
  const info = await uncachedAttrs(runtime, host, secret, remotePath, follow, signal)
  runtime.meta.rememberAttrs(host.id, remotePath, follow, info, ticket)
  return info
}

async function uncachedAttrs(
  runtime: Runtime,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  follow: boolean,
  signal?: AbortSignal,
): Promise<SftpAttrs | undefined> {
  const info = await runtime.access.pool.sftpAttrs(host, secret, remotePath, follow)
  throwIfFsAborted(signal)
  if (info === undefined || info.mode !== undefined || info.type !== 'other') return info
  if (!follow) {
    const kind = await linkKind(runtime, host, secret, remotePath, signal)
    if (kind === 'symlink') return { ...info, type: 'symlink' }
    if (kind === 'unknown') return info
  }
  try {
    await runtime.access.pool.sftpProbeDir(host, secret, remotePath)
    throwIfFsAborted(signal)
    return { ...info, type: 'directory' }
  } catch (error) {
    throwIfFsAborted(signal)
    if (error instanceof FsError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (isRemoteMissing(error) || isSftpPermissionDenied(error)) return info
    return { ...info, type: 'file' }
  }
}

async function linkKind(
  runtime: Runtime,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  signal?: AbortSignal,
): Promise<'symlink' | 'not-link' | 'unknown'> {
  try {
    await runtime.access.pool.sftpReadLink(host, secret, remotePath)
    throwIfFsAborted(signal)
    return 'symlink'
  } catch (error) {
    throwIfFsAborted(signal)
    if (error instanceof FsError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (isNotALink(error)) return 'not-link'
    if (isRemoteMissing(error)) return 'not-link'
    return 'unknown'
  }
}

function watchRemote(
  runtime: Runtime,
  target: FsTarget,
  changed: (error?: Error) => void,
  signal: AbortSignal,
): Promise<() => Promise<void>> {
  if (signal.aborted) return Promise.reject(new FsError('aborted', 'FS_ABORTED'))
  if (routeByCwd(String(target.targetKey)).kind === 'remote') {
    return Promise.reject(new FsError('SFTP has no directory watch', 'FS_IO_ERROR'))
  }
  return runtime.originals.watch(target, changed, signal)
}

async function realRemote(runtime: Runtime, host: HostConfig, secret: SecretMaterial, lexical: string, signal?: AbortSignal): Promise<string> {
  const normalized = posix.normalize(lexical)
  const cached = runtime.meta.realpath(host.id, normalized, false)
  if (cached !== undefined) return cached
  const value = await walkReal(runtime, host, secret, normalized, signal)
  runtime.meta.rememberRealpath(host.id, normalized, value)
  return value
}

async function walkReal(runtime: Runtime, host: HostConfig, secret: SecretMaterial, lexical: string, signal?: AbortSignal): Promise<string> {
  let cursor = lexical
  const missing: string[] = []
  while (true) {
    throwIfFsAborted(signal)
    const known = runtime.meta.realpath(host.id, cursor, false)
    if (known !== undefined) {
      const composed = normalizeRemoteDirectory(composeCreatedPath(known, missing))
      if (composed === null) throw new FsError(`remote path is not absolute: ${cursor}`, 'FS_IO_ERROR')
      return composed
    }
    try {
      const real = normalizeRemoteDirectory(await runtime.access.pool.sftpRealpath(host, secret, cursor))
      if (real === null) throw new FsError(`remote path is not absolute: ${cursor}`, 'FS_IO_ERROR')
      runtime.meta.rememberRealpath(host.id, cursor, real)
      const composed = normalizeRemoteDirectory(composeCreatedPath(real, missing))
      if (composed === null) throw new FsError(`remote path is not absolute: ${cursor}`, 'FS_IO_ERROR')
      return composed
    } catch (error) {
      if (error instanceof FsError) throw error
      if (!isRemoteMissing(error)) throw error
      if (cursor === '/') {
        const composed = normalizeRemoteDirectory(composeCreatedPath('/', missing))
        if (composed === null) throw new FsError('remote path is not absolute: /', 'FS_IO_ERROR')
        return composed
      }
      missing.unshift(posix.basename(cursor))
      const parent = posix.dirname(cursor)
      if (parent === cursor) throw new FsError(`remote path is not absolute: ${lexical}`, 'FS_IO_ERROR')
      cursor = parent
    }
  }
}

function placeOf(runtime: Runtime, target: FsTarget): Place | undefined {
  const key = String(target.targetKey)
  const recorded = runtime.identity.get(key)
  if (recorded !== undefined && runtime.meta.isRealpathFresh(recorded.at)) {
    return { host: hostOf(runtime, recorded.hostId), remote: recorded.remoteReal }
  }
  const route = routeByCwd(key)
  if (route.kind !== 'remote') return undefined
  return { host: hostOf(runtime, route.hostId), remote: route.remoteCwd }
}

/**
 * Verify a remote target immediately before an operation follows it.
 *
 * `resolve` is not enough: a directory can be replaced by a symlink after its
 * realpath was cached. This always asks the server for a fresh `lstat` of the
 * exact path the caller named, follows an inside-workspace link explicitly,
 * and rejects a link whose target leaves the workspace. The caller can then
 * consume `place.remote` without a stale identity deciding containment.
 */
async function verifiedPlace(
  runtime: Runtime,
  target: FsTarget,
  expected: 'file' | 'directory' | 'any',
  signal?: AbortSignal,
): Promise<Place | undefined> {
  const key = String(target.targetKey)
  const route = routeByCwd(key)
  if (route.kind !== 'remote') return undefined
  const host = hostOf(runtime, route.hostId)
  const secret = await runtime.access.secret(host)
  throwIfFsAborted(signal)
  const lexical = route.remoteCwd
  const ticket = runtime.meta.attrTicket(host.id)
  let info = await uncachedAttrs(runtime, host, secret, lexical, false, signal)
  throwIfFsAborted(signal)
  if (info === undefined) throw new FsError(`no entry at "${target.displayPath}"`, 'FS_NOT_FOUND')

  let effective = lexical
  if (info.type === 'symlink') {
    const real = normalizeRemoteDirectory(await runtime.access.pool.sftpRealpath(host, secret, lexical))
    throwIfFsAborted(signal)
    if (real === null) throw new FsError(`remote path is not absolute: ${lexical}`, 'FS_IO_ERROR')
    // `workspaceBinding(key)` cannot answer this: for an absolute-remote
    // spelling its `remotePath` is the whole path, so comparing it with the
    // link's target would refuse a link that points inside the same workspace.
    // The registered roots are spelling-independent, so ask for those.
    if (!remotePathInsideAnyWorkspace(runtime, route.hostId, real)) {
      throw new FsError(`"${target.displayPath}" points outside its workspace`, 'FS_PERMISSION_DENIED')
    }
    effective = real
    rememberIdentity(runtime, key, { hostId: route.hostId, remoteReal: real, at: runtime.now() })
    runtime.meta.rememberRealpath(host.id, lexical, real)
    runtime.meta.forgetAttrs(host.id, lexical, true)
    info = await uncachedAttrs(runtime, host, secret, real, true, signal)
    throwIfFsAborted(signal)
    if (info === undefined) throw new FsError(`no entry at "${target.displayPath}"`, 'FS_NOT_FOUND')
  }

  const type = info.type
  if (expected === 'directory' && type !== 'directory') {
    throw new FsError(`"${target.displayPath}" is not a directory`, 'FS_NOT_DIRECTORY')
  }
  if (expected === 'file' && type !== 'file') {
    throw new FsError(`"${target.displayPath}" is not a regular file`, 'FS_NOT_REGULAR_FILE')
  }
  runtime.meta.rememberAttrs(host.id, lexical, true, info, ticket)
  return { host, remote: effective }
}

/** Whether a remote path is inside one of the roots registered for this host. */
function remotePathInsideAnyWorkspace(runtime: Runtime, hostId: string, remotePath: string): boolean {
  const roots = runtime.access.workspaceRootsOf?.(hostId)
  // No registry means containment cannot be proved. Fail closed: the caller is
  // following a link, and guessing a root from the link itself is what the
  // relative/absolute spelling inconsistency was.
  if (roots === undefined || roots.length === 0) return false
  return roots.some(root => remotePathInside(root, remotePath))
}

function hostOf(runtime: Runtime, hostId: string): HostConfig {
  try {
    return runtime.access.requireHost(hostId)
  } catch (error) {
    throw asFs(error)
  }
}

function lexicalPath(requested: string, cwd: string | undefined): string | undefined {
  if (cwd !== undefined) {
    const opened = routeByCwd(cwd)
    if (opened.kind === 'remote') {
      // A target key or a path inside this host's placeholder tree is already
      // in the local spelling the filesystem service uses. Keep it as-is.
      const direct = path.resolve(cwd, requested)
      // A delivery snapshot is the one absolute path under a remote cwd that is
      // real, on this computer. Everything below reads an absolute path as a
      // path on the SSH host and hands it to `resolveRemotePath`, which would
      // translate this one into a placeholder on a server that has no such
      // file. `present` and the card both call in with the session's placeholder
      // cwd, so without this the snapshot never reaches the local backend and
      // every delivery would fail on the official tool's `stat`.
      if (isPresentCachePath(direct)) return direct
      const directRoute = routeByCwd(direct)
      if (directRoute.kind === 'remote' && directRoute.hostId === opened.hostId) return direct
      // Everything else is a path in the remote namespace. Resolving it with
      // the local `path` module would let `../..` escape the placeholder tree
      // and turn a remote read/write into a local one, so translate the path
      // through `resolveRemotePath` before mapping it back to a placeholder.
      const remote = normalizeRemoteDirectory(resolveRemotePath(requested, opened.remoteCwd, opened.placeholderCwd))
      const local = remote === null ? null : mapRemoteToLocal(opened.hostId, remote)
      if (local !== null) return local
    }
    return path.resolve(cwd, requested)
  }
  if (path.isAbsolute(requested)) return path.resolve(requested)
  return undefined
}

function versionKey(hostId: string, remotePath: string): string {
  return `${hostId}\0${remotePath}`
}

function baseVersion(info: SftpAttrs): string {
  return `${info.mtime}:${info.size}`
}

function rememberDescriptor(runtime: Runtime, key: string, base: string, evidence: RemoteVersionEvidence): void {
  // Do not carry evidence across a base change. A failed probe on the same
  // base also drops the descriptor: the current version then has no content
  // proof, so a guarded write fails closed as FS_IO_ERROR instead of falsely
  // claiming the file changed.
  if (evidence.strong === undefined && evidence.hash === undefined) runtime.descriptors.delete(key)
  else runtime.descriptors.set(key, { base, ...evidence })
  if (runtime.descriptors.size > META_CAP) {
    const oldest = runtime.descriptors.keys().next().value
    if (oldest !== undefined) runtime.descriptors.delete(oldest)
  }
}

/**
 * Since a base-only stat response can be transient, use the last evidence for
 * the same base. It is still bounded by the remote attribute/metadata cache.
 */
function cachedEvidence(runtime: Runtime, key: string, base: string): RemoteVersionEvidence | undefined {
  const descriptor = runtime.descriptors.get(key)
  if (descriptor === undefined || descriptor.base !== base) return undefined
  return { ...(descriptor.strong !== undefined ? { strong: descriptor.strong } : {}), ...(descriptor.hash !== undefined ? { hash: descriptor.hash } : {}) }
}

function rememberGeneration(runtime: Runtime, key: string, generation: number): void {
  runtime.versions.set(key, generation)
  if (runtime.versions.size > META_CAP) {
    const oldest = runtime.versions.keys().next().value
    if (oldest !== undefined) runtime.versions.delete(oldest)
  }
}

function generationFor(runtime: Runtime, key: string): number | undefined {
  return runtime.versions.get(key)
}

function versionFor(runtime: Runtime, hostId: string, remotePath: string, info: SftpAttrs, evidence?: RemoteVersionEvidence): FsVersion {
  const key = versionKey(hostId, remotePath)
  const base = baseVersion(info)
  const effective = evidence !== undefined && (evidence.strong !== undefined || evidence.hash !== undefined)
    ? evidence
    : cachedEvidence(runtime, key, base)
  const generation = generationFor(runtime, key)
  return remoteVersionToken({
    base,
    ...(effective?.strong !== undefined ? { strong: effective.strong } : {}),
    ...(effective?.hash !== undefined ? { hash: effective.hash } : {}),
    ...(generation !== undefined ? { generation } : {}),
  })
}

function bumpVersion(runtime: Runtime, hostId: string, remotePath: string, info: SftpAttrs, evidence: RemoteVersionEvidence): FsVersion {
  const key = versionKey(hostId, remotePath)
  const base = baseVersion(info)
  rememberDescriptor(runtime, key, base, evidence)
  // The counter is monotonic for the lifetime of this patch. Do not reset it
  // when the file's SFTP base changes: a reset could make a later write reuse
  // an older generation and accidentally compare equal to a stale token.
  const generation = (runtime.versions.get(key) ?? 0) + 1
  rememberGeneration(runtime, key, generation)
  return remoteVersionToken({
    base,
    ...(evidence.strong !== undefined ? { strong: evidence.strong } : {}),
    ...(evidence.hash !== undefined ? { hash: evidence.hash } : {}),
    generation,
  })
}

type VersionComparison = 'match' | 'stale' | 'unavailable'

/**
 * Compare the evidence in two version descriptors.
 *
 * Strong evidence wins. If the expected descriptor carries strong evidence but
 * the current one does not, the check cannot prove equality: that is
 * `unavailable`, not `stale`, and callers must fail closed without lying about
 * the file having changed.
 */
function compareRemoteVersion(expected: FsVersion, current: FsVersion): VersionComparison {
  const left = parseRemoteVersion(expected)
  const right = parseRemoteVersion(current)
  if (left === undefined || right === undefined) return String(expected) === String(current) ? 'match' : 'stale'
  // `base` is the cheap SFTP identity (mtime:size). It cannot prove equality
  // by itself, but a changed base is still a changed observed file and must
  // never be reported as a match. This also protects against generation
  // resets when a path is re-observed under a new base.
  if (left.base !== right.base) return 'stale'
  // A generation is this session's own mutation counter. If both descriptors
  // carry one and they differ, this plugin already wrote the target after the
  // expected version was observed; the file is stale even when the content
  // hash happens to match again (for example an identical rewrite).
  if (left.generation !== undefined && right.generation !== undefined && left.generation !== right.generation) {
    return 'stale'
  }
  if (left.strong !== undefined && right.strong !== undefined) return left.strong === right.strong ? 'match' : 'stale'
  if (left.hash !== undefined && right.hash !== undefined) return left.hash === right.hash ? 'match' : 'stale'
  if (left.strong !== undefined || left.hash !== undefined || right.strong !== undefined || right.hash !== undefined) return 'unavailable'
  // Generation-only tokens record that this session wrote the file, not what
  // its current content is; external writers are invisible to the counter.
  return 'unavailable'
}

function infoOf(info: SftpAttrs, version: FsVersion): FsInfo {
  const type = info.type === 'file' || info.type === 'directory' ? info.type : 'other'
  return { version, type, size: info.size }
}

function pathInfo(info: SftpAttrs, version: FsVersion): FsPathInfo {
  return { version, type: info.type, size: info.size }
}

function throwIfFsAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new FsError('aborted', 'FS_ABORTED')
}

interface MetaHit<T> {
  readonly hit: true
  readonly value: T
}

interface MetaMiss {
  readonly hit: false
}

/**
 * Successful realpath and attribute probes. A fresh hit skips the network.
 * An expired hit is still served when the host cannot be asked again.
 * Absence is a stored value, so a missing instruction file is not restatted
 * on the next step. The cap drops the oldest key; a dropped entry only costs
 * another probe.
 */
class MetaCache {
  private readonly realPaths = new Map<string, { at: number, value: string }>()
  private readonly attrEntries = new Map<string, { at: number, value: SftpAttrs | undefined }>()
  /** Bumped when a host's attributes are dropped, so an in-flight probe cannot write them back. */
  private readonly attrEpoch = new Map<string, number>()

  constructor(
    private readonly now: () => number,
    private readonly realTtl: number,
    private readonly attrTtl: number,
  ) {}

  realpath(hostId: string, remotePath: string, stale: boolean): string | undefined {
    const hit = this.read(this.realPaths, `${hostId}\0${remotePath}`, stale, this.realTtl)
    return hit.hit ? hit.value : undefined
  }

  rememberRealpath(hostId: string, remotePath: string, value: string): void {
    this.write(this.realPaths, `${hostId}\0${remotePath}`, value)
  }

  /** Drop one path's cached realpath after it was observed as a symlink. */
  forgetRealpath(hostId: string, remotePath: string): void {
    this.realPaths.delete(`${hostId}\0${remotePath}`)
  }

  /** Drop one path's cached attributes after its type changed. */
  forgetAttrs(hostId: string, remotePath: string, follow: boolean): void {
    this.attrEntries.delete(`${hostId}\0${follow ? 's' : 'l'}\0${remotePath}`)
  }

  /** Generation a probe must present to store attributes captured before a flush. */
  attrTicket(hostId: string): number {
    return this.attrEpoch.get(hostId) ?? 0
  }

  /**
   * Drop every cached attribute for one host and invalidate probes already in flight.
   *
   * Realpath entries stay: those have their own short TTL, and forgetting them
   * here would make a command's exit also forget which directory a symlink
   * pointed at. The generation moves first, so a probe that read the old
   * generation cannot `rememberAttrs` after this returns.
   */
  forgetHostAttrs(hostId: string): void {
    this.attrEpoch.set(hostId, this.attrTicket(hostId) + 1)
    const prefix = `${hostId}\0`
    for (const key of this.attrEntries.keys()) {
      if (key.startsWith(prefix)) this.attrEntries.delete(key)
    }
  }

  /** Whether an identity captured at `at` is still inside the realpath window. */
  isRealpathFresh(at: number): boolean {
    return this.now() - at < this.realTtl
  }

  attrs(hostId: string, remotePath: string, follow: boolean, stale: boolean): MetaHit<SftpAttrs | undefined> | MetaMiss {
    return this.read(this.attrEntries, `${hostId}\0${follow ? 's' : 'l'}\0${remotePath}`, stale, this.attrTtl)
  }

  rememberAttrs(hostId: string, remotePath: string, follow: boolean, value: SftpAttrs | undefined, ticket: number): void {
    if (this.attrTicket(hostId) !== ticket) return
    this.write(this.attrEntries, `${hostId}\0${follow ? 's' : 'l'}\0${remotePath}`, value)
  }

  invalidateHost(hostId: string): void {
    this.forgetHostAttrs(hostId)
    const prefix = `${hostId}\0`
    for (const key of this.realPaths.keys()) if (key.startsWith(prefix)) this.realPaths.delete(key)
  }

  private read<T>(map: Map<string, { at: number, value: T }>, key: string, stale: boolean, ttl: number): MetaHit<T> | MetaMiss {
    const entry = map.get(key)
    if (entry === undefined) return { hit: false }
    if (!stale && this.now() - entry.at >= ttl) return { hit: false }
    return { hit: true, value: entry.value }
  }

  private write<T>(map: Map<string, { at: number, value: T }>, key: string, value: T): void {
    if (map.has(key)) map.delete(key)
    map.set(key, { at: this.now(), value })
    while (map.size > META_CAP) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
}

/**
 * Only a transport or protocol failure is soft. A `TypeError` or a credential
 * read that throws must stay `FS_IO_ERROR`, or the sidebar reports the file
 * as missing. Absence and permission denied are answers about the path.
 */
function isSoftFailure(error: unknown): boolean {
  if (!(error instanceof SshFailure)) return false
  // A server that cannot realpath must not silently degrade containment to a
  // lexical comparison; surface it instead of keeping the placeholder spelling.
  if (error.status === SFTP_STATUS.OP_UNSUPPORTED) return false
  if (isRemoteMissing(error)) return false
  return !isSftpPermissionDenied(error)
}

/**
 * A failed attribute probe. Prefer the last remote answer, then a placeholder
 * that really exists on this computer (the workspace root `ensure` stats).
 * An unknown path becomes absent instead of `FS_IO_ERROR`, because
 * `existsAsMarker` rethrows every other code and that aborts the step.
 * `ensure` then treats a remote subdirectory with no placeholder and no
 * cached stat as gone and commits the project root.
 */
async function softenAttrs<T>(
  error: unknown,
  signal: AbortSignal | undefined,
  stale: MetaHit<SftpAttrs | undefined> | MetaMiss,
  present: (info: SftpAttrs) => T,
  local: () => Promise<T | undefined>,
): Promise<T | undefined> {
  throwIfFsAborted(signal)
  if (!isSoftFailure(error)) throw asFs(error, signal)
  if (stale.hit) return stale.value === undefined ? undefined : present(stale.value)
  try {
    return await local()
  } catch (localError) {
    throwIfFsAborted(signal)
    if (localError instanceof FsError && localError.code === 'FS_ABORTED') throw localError
    return undefined
  }
}

function asFs(error: unknown, signal?: AbortSignal): FsError {
  if (signal?.aborted === true) return new FsError('aborted', 'FS_ABORTED')
  if (error instanceof FsError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof SandboxUnavailableError) return new FsError(message, 'FS_SANDBOX_DENIED')
  if (isRemoteMissing(error)) return new FsError(message, 'FS_NOT_FOUND')
  if (isSftpPermissionDenied(error)) return new FsError(message, 'FS_PERMISSION_DENIED')
  // Structured first; the message test stays as a fallback for providers that
  // raise their own oversize error instead of going through `SshFailure`.
  if (isByteLimitExceeded(error)) return new FsError(message, 'FS_TOO_LARGE')
  if (/over the /i.test(message) && /byte limit/i.test(message)) return new FsError(message, 'FS_TOO_LARGE')
  return new FsError(message, 'FS_IO_ERROR')
}

function bindOriginals(fs: FsSurface): Originals {
  return {
    resolve: fs.resolve.bind(fs),
    lstat: fs.lstat.bind(fs),
    stat: fs.stat.bind(fs),
    listDir: fs.listDir.bind(fs),
    readText: fs.readText.bind(fs),
    streamText: fs.streamText.bind(fs),
    readBytes: fs.readBytes.bind(fs),
    readByteRange: fs.readByteRange.bind(fs),
    writeText: fs.writeText.bind(fs),
    editText: fs.editText.bind(fs),
    contains: fs.contains.bind(fs),
    watch: fs.watch.bind(fs),
  }
}

/**
 * The optional mutating methods, bound when the mounted provider has them.
 *
 * Kept apart from `bindOriginals` so the required surface stays required: a
 * provider without `patchText` is a legal composition, and the guard has to
 * look at the real method before deciding to wrap it.
 */
function bindOptionalMutations(fs: FsSurface, originals: Originals): Originals {
  const patch = fs as unknown as Partial<Record<'patchText' | 'deleteFile' | 'moveFile', (...args: never[]) => unknown>>
  if (typeof patch.patchText === 'function') originals.patchText = patch.patchText.bind(fs) as Originals['patchText']
  if (typeof patch.deleteFile === 'function') originals.deleteFile = patch.deleteFile.bind(fs) as Originals['deleteFile']
  if (typeof patch.moveFile === 'function') originals.moveFile = patch.moveFile.bind(fs) as Originals['moveFile']
  return originals
}

/**
 * Refuse a mutation aimed at a delivery snapshot.
 *
 * A snapshot is the one local path a remote session can name and have the local
 * backend actually write, because it is deliberately kept out of the remote
 * namespace (`lexicalPath` and `router.ts` explain why). That makes it the one
 * local write the model can reach without an absolute path it was never shown —
 * `present` reports the snapshot path to the card, so the model can read it back
 * out of a tool result. A delivery copy is frozen by construction: editing it in
 * place would rewrite the bytes an already-recorded card opens, which is exactly
 * what content addressing prevents.
 *
 * The check reads `targetKey`, not the display path. The local backend keys a
 * target by realpath, so a symlink pointing into the snapshot tree is caught as
 * its target, and a superseded root is covered because `isPresentCachePath`
 * consults every routable root.
 */
function refusePresentSnapshot(target: FsTarget, verb: string): void {
  if (!isPresentCachePath(String(target.targetKey))) return
  throw new FsError(
    `cannot ${verb} "${target.displayPath}": it is a read-only delivery snapshot; present the remote file again to deliver updated content`,
    'FS_PERMISSION_DENIED',
  )
}

/**
 * Refuse a mutating fs method this backend does not implement remotely.
 *
 * `writeText`, `editText`, and (on 0.2.2) `patchText`, `deleteFile` and
 * `moveFile` are reimplemented remotely. On an older provider that lacks the
 * patch mutations, leaving them on the mounted provider would run the
 * provider's own local implementation against the placeholder spelling, which
 * really is a path on this computer: `apply_patch` would then edit a local file
 * that only looks like the remote one, and `present`/uploads may already have
 * put a real file there. A remote target is refused with FS_SANDBOX_DENIED so
 * the model is told the operation is unavailable rather than silently writing
 * to the wrong machine; a local target still reaches the provider unchanged.
 *
 * The method is absent from the mounted service in some compositions. Nothing
 * is replaced then, so the tool layer sees the missing method instead of a
 * refusal that would claim this plugin blocked something it never saw.
 */
function guardRemoteMutation(
  surface: FsSurface,
  originals: Originals,
  restorers: Array<() => void>,
  key: 'patchText' | 'deleteFile' | 'moveFile',
): void {
  const saved = originals[key]
  if (typeof saved !== 'function') return
  const own = Object.hasOwn(surface, key)
  const targetOf = (value: unknown): string => {
    const record = typeof value === 'object' && value !== null ? value as { targetKey?: unknown } : undefined
    return String(record?.targetKey ?? '')
  }
  // The fs contract declares every mutation async, so a refusal is a rejected
  // promise like any other provider failure, not a synchronous throw.
  const refuse = (displayPath: string): Promise<never> => Promise.reject(new FsError(
    `remote workspace: ${displayPath} cannot be changed by this operation; use write or edit instead`,
    'FS_SANDBOX_DENIED',
  ))
  // A delivery snapshot is local, so `routeByCwd` alone would let it through to
  // the mounted provider — which is a real local delete/move/patch of a frozen
  // card's bytes. This branch is only reached on a provider without the 0.2.2
  // patch mutations, so `refusePresentSnapshot` inside the remote
  // implementations never runs here. Check the snapshot first, in every arm.
  // Snapshot refusals go through a rejected promise, like `refuse` above: this
  // replacement is not `async`, so a synchronous throw would reach the caller
  // before it had a promise to handle.
  const refuseSnapshot = (target: FsTarget, verb: string): Promise<never> | undefined => {
    try {
      refusePresentSnapshot(target, verb)
      return undefined
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const replacement = key === 'moveFile'
    // A move touches two paths. Either side being remote is enough to make a
    // local call wrong: the source would be copied from this computer, or the
    // destination written onto it.
    ? (source: FsTarget, destination: FsTarget, ...rest: unknown[]) => {
      const frozen = refuseSnapshot(source, 'move') ?? refuseSnapshot(destination, 'move onto')
      if (frozen !== undefined) return frozen
      if (routeByCwd(targetOf(source)).kind === 'remote') return refuse(String(source?.displayPath ?? 'the source'))
      if (routeByCwd(targetOf(destination)).kind === 'remote') return refuse(String(destination?.displayPath ?? 'the destination'))
      return (saved as (...args: unknown[]) => unknown).call(surface, source, destination, ...rest)
    }
    : (target: FsTarget, ...rest: unknown[]) => {
      const frozen = refuseSnapshot(target, key === 'deleteFile' ? 'delete' : 'patch')
      if (frozen !== undefined) return frozen
      if (routeByCwd(targetOf(target)).kind === 'remote') return refuse(String(target?.displayPath ?? 'the target'))
      return (saved as (...args: unknown[]) => unknown).call(surface, target, ...rest)
    }
  ;(surface as unknown as Record<string, unknown>)[key] = replacement
  restorers.push(() => {
    if (own) (surface as unknown as Record<string, unknown>)[key] = saved
    else Reflect.deleteProperty(surface, key)
  })
}

function replaceMethod<K extends keyof Originals>(fs: FsSurface, key: K, next: Originals[K]): () => void {
  const own = Object.hasOwn(fs, key)
  const saved = fs[key]
  fs[key] = next
  return () => {
    if (own) fs[key] = saved
    else Reflect.deleteProperty(fs, key)
  }
}

function marked(fs: object): boolean {
  return (fs as { [MARKER]?: boolean })[MARKER] === true
}

function unwrap(service: object): object {
  const branded = service as { [symbols.original]?: object }
  const inner = branded[symbols.original]
  return typeof inner === 'object' && inner !== null ? inner : service
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
