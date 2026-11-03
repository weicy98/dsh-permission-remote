/**
 * Copy a user-uploaded file onto the remote machine before the model sees it.
 *
 * `processPathFromHostPath` runs synchronously inside the adapter's first
 * pull, after messages are frozen, so the bytes cannot move at that moment.
 * `llm/stream` listeners run before that pull. This one returns a generator
 * that finishes the copy and only then yields the downstream stream. The
 * projection reads `agents.currentInitiator()`, which the agent loop keeps
 * set for that pull, and returns the remote absolute path.
 *
 * The copy lives in the remote home, not the workspace: the file tree and git
 * status stay the project's. Bash can read it because the sandbox bind-mounts
 * `/` read-only. Images are not file blocks and stay where they are.
 */
import path from 'node:path'
import { posix } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import type { HostConfig } from './config.ts'
import { isRemoteMissing } from './ops.ts'
import { normalizeRemoteDirectory, routeByCwd, type RemoteRoute } from './router.ts'
import { settleThen, type SecretMaterial } from './ssh-pool.ts'

/** Same ceiling `present` uses before it will copy a remote file. */
const UPLOAD_CAP = 32 * 1024 * 1024
const LEAF_MAX = 120

const MARKER = Symbol('dsh-permission-remote.uploads')

export interface UploadAccess {
  requireHost(hostId: string): HostConfig
  secret(host: HostConfig): Promise<SecretMaterial>
  pool: {
    sftpRealpath(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string>
    sftpStat(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<{ isDirectory: boolean, size: number }>
    /** `lstat` (follow=false) so an existing symbolic link can be refused. */
    sftpAttrs?(host: HostConfig, secret: SecretMaterial, remotePath: string, follow: boolean): Promise<{ type: 'file' | 'directory' | 'symlink' | 'other', size: number } | undefined>
    sftpPutFile(host: HostConfig, secret: SecretMaterial, localPath: string, remotePath: string): Promise<void>
  }
}

interface StreamOptions {
  sessionId?: string
  messages?: unknown
  signal?: AbortSignal
}

type StreamListener = (options: StreamOptions, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>

export interface UploadContext {
  get(service: string): unknown
  on(event: 'llm/stream', listener: StreamListener): () => void
  logger?: { warn(message: string): void }
}

interface FileRef {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
  readonly hostPath: string
}

type UploadRecord = { readonly kind: 'ready', readonly remotePath: string } | { readonly kind: 'failed' }

/** `aborted` is a successful copy whose turn was cancelled before projection. */
type Outcome = { readonly kind: 'ready', readonly remotePath: string, readonly aborted?: boolean } | { readonly kind: 'failed' }

interface FsPathMap {
  processPathFromHostPath(hostPath: string): string | undefined
}

/**
 * One leaf under the upload directory. `..` and a leading dot are not path
 * segments: the id directory is the only parent we add.
 */
export function uploadLeaf(name: string): string {
  const stripped = posix.basename(name).replace(/^\.+/, '')
  const safe = stripped.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, LEAF_MAX)
  return safe.length === 0 ? 'file' : safe
}

const SHA256_PREFIX = 'sha256:'

/**
 * Directory name for one upload. DSH ids are `sha256:` plus the hex digest.
 * The first 16 characters of that whole string are `sha256:` and nine hex
 * digits, and the colon is not a digest. The directory is 16 hex digits.
 */
export function uploadDigest(attachmentId: string): string {
  if (attachmentId.includes('/') || attachmentId.includes('\\') || attachmentId.includes('\0')) {
    throw new Error('attachment id is not a safe digest')
  }
  const hex = attachmentId.startsWith(SHA256_PREFIX) ? attachmentId.slice(SHA256_PREFIX.length) : attachmentId
  if (!/^[0-9a-fA-F]{16,}$/.test(hex)) throw new Error('attachment id is not a safe digest')
  return hex.slice(0, 16).toLowerCase()
}

/** Absolute remote path of one upload. A short or slashed id is refused. */
export function remoteUploadPath(home: string, attachmentId: string, name: string): string {
  const digest = uploadDigest(attachmentId)
  const root = normalizeRemoteDirectory(home)
  if (root === null) throw new Error('remote home is not an absolute path')
  return posix.join(root, '.dsh-permission-remote', 'uploads', digest, uploadLeaf(name))
}

/** Installed upload rewrite. Calling it restores `ctx.fs`. `invalidateHost` drops one server. */
export interface RemoteUploads {
  (): void
  invalidateHost(hostId: string): void
}

/**
 * Install the stream wrapper and the path rewrite. A second call warns and
 * does nothing. Without `processPathFromHostPath` there is nothing to rewrite,
 * so the listener is not installed either.
 */
export function installRemoteUploads(ctx: UploadContext, access: UploadAccess): RemoteUploads | undefined {
  let service: unknown
  try {
    service = ctx.get('fs')
  } catch (error) {
    ctx.logger?.warn(`[@dsh-permission-remote] remote uploads skipped: filesystem service is unavailable (${errorText(error)})`)
    return undefined
  }
  if (typeof service !== 'object' || service === null) {
    ctx.logger?.warn('[@dsh-permission-remote] remote uploads skipped: filesystem service is unavailable')
    return undefined
  }
  const fs = unwrap(service)
  if (marked(fs)) {
    ctx.logger?.warn('[@dsh-permission-remote] remote uploads already installed')
    return undefined
  }
  if (typeof (fs as Partial<FsPathMap>).processPathFromHostPath !== 'function') {
    ctx.logger?.warn('[@dsh-permission-remote] remote uploads skipped: filesystem has no processPathFromHostPath')
    return undefined
  }
  const surface = fs as FsPathMap
  const records = new Map<string, UploadRecord>()
  const flights = new Map<string, Promise<Outcome>>()
  const homes = new Map<string, Promise<string>>()
  const epochs = new Map<string, number>()
  const own = Object.hasOwn(surface, 'processPathFromHostPath')
  const saved = surface.processPathFromHostPath
  const original = saved.bind(surface)
  surface.processPathFromHostPath = hostPath => mappedPath(ctx, records, original, hostPath)
  let removeListener: (() => void) | undefined
  try {
    removeListener = ctx.on('llm/stream', (options, next) => {
      if (typeof options.sessionId !== 'string' || options.sessionId.length === 0) return next()
      const route = sessionRoute(ctx, options.sessionId)
      if (route === undefined) return next()
      // The body stays suspended until the stream is pulled, which is when the
      // adapter would otherwise project the file blocks.
      return (async function* () {
        if (isAborted(options.signal)) throw abortError()
        await stageAll(ctx, access, records, flights, homes, epochs, route, options)
        if (isAborted(options.signal)) throw abortError()
        yield* next()
      })()
    })
    Object.defineProperty(fs, MARKER, { value: true, configurable: true, enumerable: false })
  } catch (error) {
    if (own) surface.processPathFromHostPath = saved
    else Reflect.deleteProperty(surface, 'processPathFromHostPath')
    ctx.logger?.warn(`[@dsh-permission-remote] remote uploads skipped: ${errorText(error)}`)
    return undefined
  }
  const remove = (() => {
    removeListener?.()
    if (own) surface.processPathFromHostPath = saved
    else Reflect.deleteProperty(surface, 'processPathFromHostPath')
    Reflect.deleteProperty(fs, MARKER)
    records.clear()
    flights.clear()
    homes.clear()
    epochs.clear()
  }) as RemoteUploads
  remove.invalidateHost = (hostId: string) => {
    // A resolved home is this machine's `~`. After the host id points at
    // another machine, the next copy must realpath `.` again. An upload that
    // is already in flight captured the old home; its result must not be
    // published, or the model keeps a path on the previous machine.
    homes.delete(hostId)
    epochs.set(hostId, (epochs.get(hostId) ?? 0) + 1)
    const prefix = `${hostId}\0`
    for (const key of records.keys()) if (key.startsWith(prefix)) records.delete(key)
    for (const key of flights.keys()) if (key.startsWith(prefix)) flights.delete(key)
  }
  return remove
}

function mappedPath(
  ctx: UploadContext,
  records: Map<string, UploadRecord>,
  original: (hostPath: string) => string | undefined,
  hostPath: string,
): string | undefined {
  const hostId = initiatorHost(ctx)
  if (hostId === undefined) return original(hostPath)
  const record = records.get(recordKey(hostId, hostPath))
  if (record === undefined) return original(hostPath)
  if (record.kind === 'failed') return undefined
  return record.remotePath
}

async function stageAll(
  ctx: UploadContext,
  access: UploadAccess,
  records: Map<string, UploadRecord>,
  flights: Map<string, Promise<Outcome>>,
  homes: Map<string, Promise<string>>,
  epochs: Map<string, number>,
  route: RemoteRoute,
  options: StreamOptions,
): Promise<void> {
  const refs = fileRefs(ctx, options.messages)
  if (refs.length === 0) return
  let host: HostConfig
  try {
    host = access.requireHost(route.hostId)
  } catch (error) {
    if (isAborted(options.signal) || isAbort(error)) throw abortError()
    ctx.logger?.warn(`[@dsh-permission-remote] remote upload skipped: ${errorText(error)}`)
    for (const ref of refs) fail(records, route.hostId, ref.hostPath)
    return
  }
  await Promise.all(refs.map(ref => begin(ctx, access, records, flights, homes, epochs, host, ref, options.signal)))
}

function begin(
  ctx: UploadContext,
  access: UploadAccess,
  records: Map<string, UploadRecord>,
  flights: Map<string, Promise<Outcome>>,
  homes: Map<string, Promise<string>>,
  epochs: Map<string, number>,
  host: HostConfig,
  ref: FileRef,
  signal?: AbortSignal,
): Promise<void> {
  if (isAborted(signal)) return Promise.reject(abortError())
  if (!acceptable(ref)) {
    fail(records, host.id, ref.hostPath)
    ctx.logger?.warn(`[@dsh-permission-remote] remote upload skipped for ${uploadLeaf(ref.name)}: file is not a readable upload under ${UPLOAD_CAP} bytes`)
    return Promise.resolve()
  }
  // The digest and the leaf are the remote path, minus the home directory,
  // so two blocks can share a flight before the home lookup resolves.
  const flightKey = `${host.id}\0${flightIdentity(ref.attachmentId)}\0${uploadLeaf(ref.name)}`
  const existing = flights.get(flightKey)
  if (existing !== undefined) return applyOutcome(records, host.id, ref.hostPath, existing)
  const epoch = epochs.get(host.id) ?? 0
  let start!: () => void
  const flight = new Promise<Outcome>((resolve, reject) => {
    start = () => {
      uploadOne(ctx, access, homes, host, ref, signal).then(outcome => {
        resolve((epochs.get(host.id) ?? 0) === epoch ? outcome : { kind: 'failed' })
      }, reject)
    }
  })
  flights.set(flightKey, flight)
  // `finally` returns a new promise. An abort rejects `flight`, and that
  // derived promise would reject with nobody waiting. DSH exits on an
  // unhandled rejection. Both handlers settle the cleanup promise.
  settleThen(flight, () => {
    if (flights.get(flightKey) === flight) flights.delete(flightKey)
  })
  start()
  return applyOutcome(records, host.id, ref.hostPath, flight)
}

/** A bad id still gets its own flight; `uploadOne` records the failure. */
function flightIdentity(attachmentId: string): string {
  try {
    return uploadDigest(attachmentId)
  } catch {
    return attachmentId
  }
}

function applyOutcome(records: Map<string, UploadRecord>, hostId: string, hostPath: string, flight: Promise<Outcome>): Promise<void> {
  return flight.then(outcome => {
    if (outcome.kind === 'failed') {
      fail(records, hostId, hostPath)
      return
    }
    ready(records, hostId, hostPath, outcome.remotePath)
    if (outcome.aborted === true) throw abortError()
  })
}

async function uploadOne(
  ctx: UploadContext,
  access: UploadAccess,
  homes: Map<string, Promise<string>>,
  host: HostConfig,
  ref: FileRef,
  signal: AbortSignal | undefined,
): Promise<Outcome> {
  if (isAborted(signal)) throw abortError()
  let remotePath: string
  try {
    remotePath = remoteUploadPath(await homeOf(access, homes, host), ref.attachmentId, ref.name)
  } catch (error) {
    if (isAborted(signal) || isAbort(error)) throw abortError()
    ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: ${errorText(error)}`)
    return { kind: 'failed' }
  }
  try {
    const secret = await access.secret(host)
    if (isAborted(signal)) throw abortError()
    // Refuse a pre-existing symbolic link: `sftpPutFile` opens with `w`, so
    // following the link would truncate a file outside the upload directory.
    if (access.pool.sftpAttrs !== undefined) {
      let attrs: { type: string } | undefined
      try {
        attrs = await access.pool.sftpAttrs(host, secret, remotePath, false)
      } catch (error) {
        if (!isRemoteMissing(error)) {
          ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: ${errorText(error)}`)
          return { kind: 'failed' }
        }
      }
      if (attrs !== undefined && attrs.type !== 'file' && attrs.type !== 'directory') {
        ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: the upload path is a ${attrs.type === 'symlink' ? 'symbolic link' : 'non-regular file'}`)
        return { kind: 'failed' }
      }
    }
    let info: { isDirectory: boolean, size: number } | undefined
    try {
      info = await access.pool.sftpStat(host, secret, remotePath)
    } catch (error) {
      if (isAborted(signal) || isAbort(error)) throw abortError()
      if (!isRemoteMissing(error)) {
        ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: ${errorText(error)}`)
        return { kind: 'failed' }
      }
    }
    if (info?.isDirectory === true) {
      ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: a directory is already at the upload path`)
      return { kind: 'failed' }
    }
    if (info !== undefined && info.size === ref.bytes) return { kind: 'ready', remotePath }
    await access.pool.sftpPutFile(host, secret, ref.hostPath, remotePath)
    if (isAborted(signal)) return { kind: 'ready', remotePath, aborted: true }
    return { kind: 'ready', remotePath }
  } catch (error) {
    if (isAborted(signal) || isAbort(error)) throw abortError()
    ctx.logger?.warn(`[@dsh-permission-remote] remote upload failed for ${uploadLeaf(ref.name)}: ${errorText(error)}`)
    return { kind: 'failed' }
  }
}

function homeOf(access: UploadAccess, homes: Map<string, Promise<string>>, host: HostConfig): Promise<string> {
  const cached = homes.get(host.id)
  if (cached !== undefined) return cached
  const pending = resolveHome(access, host)
  homes.set(host.id, pending)
  void pending.catch(() => {
    if (homes.get(host.id) === pending) homes.delete(host.id)
  })
  return pending
}

async function resolveHome(access: UploadAccess, host: HostConfig): Promise<string> {
  const secret = await access.secret(host)
  const home = normalizeRemoteDirectory(await access.pool.sftpRealpath(host, secret, '.'))
  if (home === null) throw new Error('remote home is not an absolute path')
  return home
}

function acceptable(ref: FileRef): boolean {
  return Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= UPLOAD_CAP && path.isAbsolute(ref.hostPath)
}

function ready(records: Map<string, UploadRecord>, hostId: string, hostPath: string, remotePath: string): void {
  records.set(recordKey(hostId, hostPath), { kind: 'ready', remotePath })
}

function fail(records: Map<string, UploadRecord>, hostId: string, hostPath: string): void {
  records.set(recordKey(hostId, hostPath), { kind: 'failed' })
}

function recordKey(hostId: string, hostPath: string): string {
  return `${hostId}\0${hostPath}`
}

function fileRefs(ctx: UploadContext, messages: unknown): FileRef[] {
  if (!Array.isArray(messages)) return []
  const attachments = attachmentsOf(ctx)
  const refs: FileRef[] = []
  for (const message of messages) {
    const content = typeof message === 'object' && message !== null ? (message as { content?: unknown }).content : undefined
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const record = block as { type?: unknown, attachment?: unknown }
      if (record.type !== 'file' || typeof record.attachment !== 'object' || record.attachment === null) continue
      const attachment = record.attachment as { attachmentId?: unknown, name?: unknown, bytes?: unknown }
      if (typeof attachment.attachmentId !== 'string' || typeof attachment.name !== 'string' || typeof attachment.bytes !== 'number') continue
      const ref = { attachmentId: attachment.attachmentId, name: attachment.name, bytes: attachment.bytes }
      let hostPath: string | undefined
      try {
        hostPath = attachments?.fileHostPath(ref)
      } catch {
        // fileReadPath already turns this into "no readable path".
        continue
      }
      if (hostPath === undefined) continue
      refs.push({ ...ref, hostPath })
    }
  }
  return refs
}

function attachmentsOf(ctx: UploadContext): { fileHostPath(ref: { attachmentId: string, name: string, bytes: number }): string | undefined } | undefined {
  try {
    const service = ctx.get('attachments') as { fileHostPath?: unknown } | undefined
    if (typeof service?.fileHostPath !== 'function') return undefined
    return service as { fileHostPath(ref: { attachmentId: string, name: string, bytes: number }): string | undefined }
  } catch {
    return undefined
  }
}

function sessionRoute(ctx: UploadContext, sessionId: string): RemoteRoute | undefined {
  const cwd = liveCwd(ctx, sessionId)
  const route = routeByCwd(cwd)
  return route.kind === 'remote' ? route : undefined
}

function liveCwd(ctx: UploadContext, sessionId: string): string | undefined {
  try {
    const sessions = ctx.get('sessions') as { get?: (id: string) => object | undefined } | undefined
    const session = sessions?.get?.(sessionId)
    if (session === undefined) return undefined
    try {
      const directories = ctx.get('workingDirectory') as { get?: (session: object) => string } | undefined
      const cwd = directories?.get?.(session)
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    } catch {
      // A session without a recorded directory falls through to the header.
    }
    const header = (session as { header?: { cwd?: string } }).header
    return header?.cwd
  } catch {
    return undefined
  }
}

function initiatorHost(ctx: UploadContext): string | undefined {
  try {
    const agents = ctx.get('agents') as { currentInitiator?: () => { session?: object } | undefined } | undefined
    const agent = agents?.currentInitiator?.()
    if (agent?.session === undefined) return undefined
    let cwd: string | undefined
    try {
      const directories = ctx.get('workingDirectory') as { get?: (session: object) => string } | undefined
      cwd = directories?.get?.(agent.session)
    } catch {
      cwd = undefined
    }
    if (cwd === undefined || cwd.length === 0) cwd = (agent.session as { header?: { cwd?: string } }).header?.cwd
    const route = routeByCwd(cwd)
    return route.kind === 'remote' ? route.hostId : undefined
  } catch {
    return undefined
  }
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function abortError(): Error {
  const error = new Error('remote upload aborted')
  error.name = 'AbortError'
  return error
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
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
