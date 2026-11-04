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
 * it, so it is not a target key. Tool shadows still perform the model writes.
 * A direct `writeText` or `editText` on a placeholder path is refused, so a
 * missing shadow cannot create a local file that looks like a remote write.
 * SFTP has no watch; a remote `watch` fails and the panel keeps manual refresh.
 */
import path from 'node:path'
import { posix } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import { FsError, FsTargetKey, FsVersion, type FsDirEntry, type FsInfo, type FsPathInfo, type FsTarget } from '@deepseek-ai/dsh-fs'
import type { HostConfig } from './config.ts'
import { composeCreatedPath } from './contain.ts'
import { isRemoteMissing } from './ops.ts'
import { normalizeRemoteDirectory, routeByCwd, workspaceBinding } from './router.ts'
import { SFTP_STATUS, SshFailure, isSftpPermissionDenied, type RemoteDirEntry, type SecretMaterial, type SftpAttrs } from './ssh-pool.ts'
import { remotePathInside } from './workspaces.ts'

/** Same ceiling `present` uses before it will copy a remote file. */
const TEXT_CAP = 32 * 1024 * 1024

/**
 * `agent/pre-step` stats the working directory, `.git`, and every instruction
 * candidate on each step. A realpath must not be trusted for long: replacing a
 * directory with a symlink is the escape this cache could otherwise hide, so the
 * window is only a few seconds. Attributes are shorter: `write`, `edit`, and
 * `bash` talk to SFTP directly and do not tell this cache, so the sidebar must
 * notice a new file within a few seconds. A disconnected host can still answer
 * from an older entry.
 */
const REALPATH_TTL_MS = 3_000
const ATTR_TTL_MS = 5_000
const META_CAP = 512

const MARKER = Symbol('dsh-permission-remote.remote-fs')

export interface RemoteAccess {
  requireHost(hostId: string): HostConfig
  secret(host: HostConfig): Promise<SecretMaterial>
  pool: {
    sftpRealpath(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string>
    sftpAttrs(host: HostConfig, secret: SecretMaterial, remotePath: string, follow: boolean): Promise<SftpAttrs | undefined>
    sftpReadLink(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string>
    sftpProbeDir(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<void>
    sftpReadDir(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<RemoteDirEntry[]>
    sftpRead(host: HostConfig, secret: SecretMaterial, remotePath: string, maxBytes?: number): Promise<Buffer>
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
  contains(parent: FsTarget, child: FsTarget): boolean
  watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
}

type FsSurface = Originals & object

const REQUIRED: ReadonlyArray<keyof Originals> = [
  'resolve', 'lstat', 'stat', 'listDir', 'readText', 'streamText', 'readBytes', 'readByteRange', 'contains', 'watch',
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
}

/**
 * Patch the filesystem the sidebar already uses. A second call warns and does
 * nothing. `undefined` means the patch is not installed.
 */
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
  const originals = bindOriginals(surface)
  const now = options?.now ?? Date.now
  const meta = new MetaCache(
    now,
    options?.metaTtlMs ?? REALPATH_TTL_MS,
    options?.attrTtlMs ?? ATTR_TTL_MS,
  )
  const runtime = { access, identity, originals, meta, now }
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
    guardRemoteWrite(surface, restorers, 'writeText')
    guardRemoteWrite(surface, restorers, 'editText')
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
  remove.invalidateHost = (hostId: string) => {
    meta.invalidateHost(hostId)
    for (const [key, record] of identity) {
      if (record.hostId === hostId) identity.delete(key)
    }
  }
  return remove
}

interface Runtime {
  readonly access: RemoteAccess
  readonly identity: Map<string, RemoteIdentity>
  readonly originals: Originals
  readonly meta: MetaCache
  readonly now: () => number
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
    runtime.identity.set(lexical, { hostId: route.hostId, remoteReal, at: runtime.now() })
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
      runtime.identity.set(lexical, { hostId: route.hostId, remoteReal: stale, at: runtime.now() })
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
    runtime.meta.rememberAttrs(host.id, route.remoteCwd, false, info)
    return info === undefined ? undefined : pathInfo(info)
  } catch (error) {
    return softenAttrs(error, signal, runtime.meta.attrs(host.id, route.remoteCwd, false, true), pathInfo, () => runtime.originals.lstat(requested, opts, signal))
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
      return softenAttrs(error, signal, runtime.meta.attrs(fallback.host.id, fallback.remote, true, true), infoOf, () => runtime.originals.stat(target, signal))
    }
  }
  const place = placeOf(runtime, target)
  if (place === undefined) return runtime.originals.stat(target, signal)
  throwIfFsAborted(signal)
  const fresh = runtime.meta.attrs(place.host.id, place.remote, true, false)
  if (fresh.hit) return fresh.value === undefined ? undefined : infoOf(fresh.value)
  try {
    const secret = await runtime.access.secret(place.host)
    const info = await attrsFor(runtime, place.host, secret, place.remote, true, signal)
    throwIfFsAborted(signal)
    runtime.meta.rememberAttrs(place.host.id, place.remote, true, info)
    return info === undefined ? undefined : infoOf(info)
  } catch (error) {
    return softenAttrs(error, signal, runtime.meta.attrs(place.host.id, place.remote, true, true), infoOf, () => runtime.originals.stat(target, signal))
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
      entries.push({
        name: row.name,
        type: child.type,
        target: { targetKey: FsTargetKey(childKey), displayPath: childKey },
        version: FsVersion(`${child.mtime}:${child.size ?? 0}`),
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
  const place = await verifiedPlace(runtime, target, 'any', signal)
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
  const place = await verifiedPlace(runtime, target, 'any', signal)
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
    const place = await verifiedPlace(runtime, target, 'any', signal)
    if (place === undefined) return runtime.originals.readBytes(target, signal, maxBytes)
    throwIfFsAborted(signal)
    const secret = await runtime.access.secret(place.host)
    const data = await runtime.access.pool.sftpRead(place.host, secret, place.remote, maxBytes)
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
    const place = await verifiedPlace(runtime, target, range.length === 0 ? 'file' : 'any', signal)
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
  const info = await uncachedAttrs(runtime, host, secret, remotePath, follow, signal)
  runtime.meta.rememberAttrs(host.id, remotePath, follow, info)
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

/**
 * Placeholder paths are not local files. The write and edit tools own remote
 * writes. Leaving these methods on the local backend would create a file in
 * the placeholder directory and report success.
 */
function guardRemoteWrite(surface: FsSurface, restorers: Array<() => void>, key: 'writeText' | 'editText'): void {
  const host = surface as FsSurface & Partial<Record<'writeText' | 'editText', (this: unknown, ...args: unknown[]) => unknown>>
  const saved = host[key]
  if (typeof saved !== 'function') return
  const own = Object.hasOwn(surface, key)
  host[key] = (target: unknown, ...rest: unknown[]) => {
    const record = typeof target === 'object' && target !== null ? target as { targetKey?: unknown } : undefined
    if (routeByCwd(String(record?.targetKey ?? '')).kind === 'remote') {
      return Promise.reject(new FsError('remote workspace: write through the write tool, not ctx.fs', 'FS_SANDBOX_DENIED'))
    }
    return saved.call(surface, target, ...rest)
  }
  restorers.push(() => {
    if (own) host[key] = saved
    else Reflect.deleteProperty(surface, key)
  })
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
  let info = await uncachedAttrs(runtime, host, secret, lexical, false, signal)
  throwIfFsAborted(signal)
  if (info === undefined) throw new FsError(`no entry at "${target.displayPath}"`, 'FS_NOT_FOUND')

  let effective = lexical
  if (info.type === 'symlink') {
    const real = normalizeRemoteDirectory(await runtime.access.pool.sftpRealpath(host, secret, lexical))
    throwIfFsAborted(signal)
    if (real === null) throw new FsError(`remote path is not absolute: ${lexical}`, 'FS_IO_ERROR')
    const binding = workspaceBinding(key)
    if (binding === null || !remotePathInside(binding.remotePath, real)) {
      throw new FsError(`"${target.displayPath}" points outside its workspace`, 'FS_PERMISSION_DENIED')
    }
    effective = real
    runtime.identity.set(key, { hostId: route.hostId, remoteReal: real, at: runtime.now() })
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
  runtime.meta.rememberAttrs(host.id, lexical, true, info)
  return { host, remote: effective }
}

function hostOf(runtime: Runtime, hostId: string): HostConfig {
  try {
    return runtime.access.requireHost(hostId)
  } catch (error) {
    throw asFs(error)
  }
}

function lexicalPath(requested: string, cwd: string | undefined): string | undefined {
  if (cwd !== undefined) return path.resolve(cwd, requested)
  if (path.isAbsolute(requested)) return path.resolve(requested)
  return undefined
}

function infoOf(info: SftpAttrs): FsInfo {
  const type = info.type === 'file' || info.type === 'directory' ? info.type : 'other'
  return { version: FsVersion(`${info.mtime}:${info.size}`), type, size: info.size }
}

function pathInfo(info: SftpAttrs): FsPathInfo {
  return { version: FsVersion(`${info.mtime}:${info.size}`), type: info.type, size: info.size }
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

  /** Whether an identity captured at `at` is still inside the realpath window. */
  isRealpathFresh(at: number): boolean {
    return this.now() - at < this.realTtl
  }

  attrs(hostId: string, remotePath: string, follow: boolean, stale: boolean): MetaHit<SftpAttrs | undefined> | MetaMiss {
    return this.read(this.attrEntries, `${hostId}\0${follow ? 's' : 'l'}\0${remotePath}`, stale, this.attrTtl)
  }

  rememberAttrs(hostId: string, remotePath: string, follow: boolean, value: SftpAttrs | undefined): void {
    this.write(this.attrEntries, `${hostId}\0${follow ? 's' : 'l'}\0${remotePath}`, value)
  }

  invalidateHost(hostId: string): void {
    const prefix = `${hostId}\0`
    for (const key of this.realPaths.keys()) if (key.startsWith(prefix)) this.realPaths.delete(key)
    for (const key of this.attrEntries.keys()) if (key.startsWith(prefix)) this.attrEntries.delete(key)
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
  if (isRemoteMissing(error)) return new FsError(message, 'FS_NOT_FOUND')
  if (isSftpPermissionDenied(error)) return new FsError(message, 'FS_PERMISSION_DENIED')
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
    contains: fs.contains.bind(fs),
    watch: fs.watch.bind(fs),
  }
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
