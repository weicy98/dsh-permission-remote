import { readFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { Client, type ConnectConfig } from './ssh2-client.ts'
import type { HostConfig } from './config.ts'
import { claimPending } from './pool-claim.ts'
import { shJoin } from './shell-quote.ts'

const OUTPUT_CAP = 1024 * 1024

/** Decode one SSH chunk. Incomplete UTF-8 stays in `decoder` until the next chunk or `end()`. */
export function takeChannelText(decoder: StringDecoder, chunk: Buffer): string {
  return decoder.write(chunk)
}

/** The live log emits the truncation line once, whichever stream hits the cap first. */
export function truncationMarker(noted: { current: boolean }): string {
  if (noted.current) return ''
  noted.current = true
  return '\n[output truncated]'
}

export interface ExecResult {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

/** One remote command on its own SSH channel. `close` kills that channel only. */
export interface RemoteCommand {
  readonly done: Promise<ExecResult>
  close(): void
}

export interface CommandChunk {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

/**
 * Run `cleanup` when `work` settles, without leaving a second rejection behind.
 *
 * `work.finally(cleanup)` returns a new promise that re-rejects with the same
 * reason. Nothing observes that copy, so a failed command becomes an unhandled
 * rejection, which dsh promotes to "fatal load failure" and exits on. Passing
 * both settle handlers keeps the single rejection on `work`, where the caller
 * awaits it.
 */
export function settleThen(work: Promise<unknown>, cleanup: () => void): void {
  const run = () => {
    try {
      cleanup()
    } catch {
      // Cleanup must not mask the command's own outcome.
    }
  }
  void work.then(run, run)
}

export interface DirEntry {
  readonly name: string
  readonly path: string
}

export interface SecretMaterial {
  readonly password?: string
  readonly passphrase?: string
}

/** SSH-level keepalive for sidebar PTYs that stay open for hours. ssh2's default count is 3. */
export const SSH_KEEPALIVE_INTERVAL_MS = 15_000

export function sshConnectOptions(host: HostConfig): ConnectConfig {
  return {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: 20_000,
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    hostHash: 'sha256',
  }
}

export interface PtyRequest {
  readonly command: string
  readonly term: string
  readonly cols: number
  readonly rows: number
  readonly signal?: AbortSignal
}

/** Byte stream of one remote PTY. `signal` is not a reliable way to stop the process. */
export interface PtyChannel {
  on(event: 'data', listener: (chunk: Buffer | string) => void): void
  on(event: 'close', listener: (code?: number | null, signal?: string | null) => void): void
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): void }
  write(data: string): boolean
  setWindow(rows: number, cols: number, height: number, width: number): void
  signal(name: string): void
  close(): void
  once?(event: 'drain', listener: () => void): void
  /** Stop reading from the socket while the screen consumer is behind. */
  pause?(): void
  /** Resume reading after `drain`. */
  resume?(): void
}

export interface OpenPty {
  readonly channel: PtyChannel
  /** The shared connection died. Channel `close` may never arrive. */
  onTransportClosed(listener: (error: Error) => void): () => void
}

export class SshFailure extends Error {
  constructor(message: string, readonly stage: string) {
    super(message)
    this.name = 'SshFailure'
  }
}

/**
 * A channel-open request that failed because the pooled connection was already
 * gone: the socket died while we waited for CHANNEL_OPEN_CONFIRMATION, so ssh2
 * reports it as "No response from server". The remote never ran the command, so
 * replaying it on a fresh connection is safe.
 */
export function isRetryableOpenFailure(error: unknown): boolean {
  if (!(error instanceof SshFailure) || error.stage !== 'exec') return false
  return /no response from server|not connected|connection lost/i.test(error.message)
}

interface SftpSession {
  readonly api: SftpLike
  end(): void
}

interface Live {
  readonly client: Client
  readonly hostId: string
  sftp?: Promise<SftpSession>
  /**
   * Release the connection slot and forget the cached entry, exactly once.
   * Closing a socket that is already gone emits no `close`, so a retry cannot
   * wait for the event to free its slot.
   */
  markDead(): void
}

const FINGERPRINT_PREFIX = 'SHA256:'

export function formatFingerprint(hashedKey: Buffer): string {
  return `${FINGERPRINT_PREFIX}${hashedKey.toString('base64')}`
}

export class SshPool {
  private readonly live = new Map<string, Promise<Live>>()
  private readonly waiters: Array<() => void> = []
  private active = 0

  constructor(private readonly maxConnections: number) {}

  async dispose(): Promise<void> {
    const pending = [...this.live.values()]
    this.live.clear()
    // A queued caller is waiting for a slot that `closeLive` will never hand
    // back on its own. Wake them first so unload cannot hang on `reserve`.
    const queued = this.waiters.splice(0)
    for (const next of queued) next()
    for (const item of pending) {
      try {
        const live = await item
        // Close the session's own slot before the socket, exactly as
        // `dropSession` does: a destroyed socket emits no `close`, so the
        // client handlers would never release it.
        live.markDead()
        await closeLive(live)
      } catch {
        // A failed connect released its slot in `acquire`.
      }
    }
  }

  invalidate(hostId: string): void {
    void this.dropSession(hostId)
  }

  /**
   * Close one cached session and wait until its connection slot is free.
   *
   * `reserve` blocks once `maxConnections` is reached, so a retry that opens a
   * new session before the old one releases would wait on itself forever.
   */
  async dropSession(hostId: string): Promise<void> {
    const current = this.live.get(hostId)
    this.live.delete(hostId)
    if (current === undefined) return
    try {
      const live = await current
      // Free the slot before closing: a socket that is already destroyed never
      // emits `close`, and the slot would stay occupied forever.
      live.markDead()
      await closeLive(live)
    } catch {
      // A failed connect released its slot in `acquire`.
    }
  }

  /** Whether a session is cached for this host id. Diagnostics and tests only. */
  hasSession(hostId: string): boolean {
    return this.live.has(hostId)
  }

  /**
   * Open one PTY channel on the host's pooled connection. The connection stays
   * up when the shell exits; `dispose` and `invalidate` close it.
   */
  async openPty(host: HostConfig, secret: SecretMaterial, request: PtyRequest): Promise<OpenPty> {
    if (request.signal?.aborted) throw new SshFailure('pty allocation aborted', 'pty')
    const live = await this.acquire(host, secret, true)
    if (request.signal?.aborted) throw new SshFailure('pty allocation aborted', 'pty')
    const channel = await execPty(live.client, request)
    if (request.signal?.aborted) {
      try {
        channel.close()
      } catch {
        // The allocation was cancelled before the sidebar received the channel.
      }
      throw new SshFailure('pty allocation aborted', 'pty')
    }
    return {
      channel,
      onTransportClosed(listener) {
        const onError = (error: Error) => listener(error instanceof Error ? error : new SshFailure(String(error), 'pty'))
        const onClose = () => listener(new SshFailure('SSH connection closed', 'pty'))
        live.client.on('error', onError)
        live.client.on('close', onClose)
        return () => {
          live.client.off('error', onError)
          live.client.off('close', onClose)
        }
      },
    }
  }

  async exec(host: HostConfig, secret: SecretMaterial, command: string, timeoutMs: number, signal?: AbortSignal, stdin?: string | Buffer, onOutput?: (chunk: CommandChunk) => void): Promise<ExecResult> {
    const commandHandle = await this.open(host, secret, command, timeoutMs, signal, stdin, onOutput)
    try {
      return await commandHandle.done
    } catch (error) {
      // The channel never opened, so the remote did not run anything and a
      // replay cannot repeat a side effect. Drop the dead session first, then
      // open again on a fresh connection — the next command would otherwise
      // keep hitting the same stale socket.
      if (signal?.aborted === true || !isRetryableOpenFailure(error)) throw error
      await this.dropSession(host.id)
      const retried = await this.open(host, secret, command, timeoutMs, signal, stdin, onOutput)
      return retried.done
    }
  }

  /** `timeoutMs` of 0 waits until the command exits, the signal aborts, or `close` kills its channel. */
  async open(host: HostConfig, secret: SecretMaterial, command: string, timeoutMs: number, signal?: AbortSignal, stdin?: string | Buffer, onOutput?: (chunk: CommandChunk) => void): Promise<RemoteCommand> {
    const live = await this.acquire(host, secret, true)
    const commandHandle = openChannel(live.client, command, timeoutMs, stdin, onOutput)
    if (signal !== undefined) {
      const abort = () => commandHandle.close()
      if (signal.aborted) commandHandle.close()
      else signal.addEventListener('abort', abort, { once: true })
      // The rejection stays on `done`, which the caller awaits; `finally` would
      // forward it into an unobserved promise and dsh would exit on it.
      settleThen(commandHandle.done, () => signal.removeEventListener('abort', abort))
    }
    return commandHandle
  }

  /** Connect far enough to read the host key. Does not persist trust. */
  async offerFingerprint(host: HostConfig, secret: SecretMaterial): Promise<{ fingerprint: string, trusted: boolean, banner: string }> {
    const stored = host.fingerprint.trim()
    let offered = ''
    let live: Client | undefined
    try {
      live = await connect(host, secret, (key: Buffer) => {
        offered = formatFingerprint(key)
        return stored.length > 0 && offered === stored
      })
      const banner = await openChannel(live, 'echo ok', 15_000).done
      return { fingerprint: stored, trusted: true, banner: banner.stdout.trim() }
    } catch (error) {
      if (offered.length > 0 && offered !== stored) {
        return { fingerprint: offered, trusted: false, banner: '' }
      }
      throw error
    } finally {
      // A rejected banner command leaves the socket open here, and a rejected
      // connect has nothing to close. `end()` is safe on both.
      live?.end()
    }
  }

  async sftpRead(host: HostConfig, secret: SecretMaterial, remotePath: string, maxBytes?: number): Promise<Buffer> {
    const session = await this.sftp(host, secret)
    if (maxBytes !== undefined) {
      const size = await statSize(session, remotePath)
      if (size > maxBytes) throw new SshFailure(`file is ${size} bytes, over the ${maxBytes} byte limit`, 'sftp-read')
    }
    return readAll(session, remotePath)
  }

  async sftpWrite(host: HostConfig, secret: SecretMaterial, remotePath: string, body: Buffer | string): Promise<void> {
    const session = await this.sftp(host, secret)
    await writeAll(session, remotePath, body)
  }

  async sftpRealpath(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string> {
    const session = await this.sftp(host, secret)
    return realpathOf(session, remotePath)
  }

  async sftpStat(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<{ isDirectory: boolean, size: number, mode?: number }> {
    const session = await this.sftp(host, secret)
    return statInfo(session, remotePath)
  }

  async sftpList(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<DirEntry[]> {
    const session = await this.sftp(host, secret)
    const rows = await readdir(session, remotePath)
    return rows
      .filter(row => row.attrs.isDirectory())
      .map(row => ({
        name: row.filename,
        path: remotePath === '/' ? `/${row.filename}` : `${remotePath.replace(/\/$/, '')}/${row.filename}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Create one directory. `recursive` is off by default on purpose: a picker
   * creates a child of a directory it just listed, so a missing parent means
   * the listing went stale and creating a deep tree would hide that.
   */
  async sftpMkdir(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<void> {
    const session = await this.sftp(host, secret)
    await makeDirectory(session, remotePath)
  }

  private async sftp(host: HostConfig, secret: SecretMaterial): Promise<SftpLike> {
    const live = await this.acquire(host, secret, true)
    live.sftp ??= openSftp(live.client).catch(error => {
      live.sftp = undefined
      throw error
    })
    const session = await live.sftp
    return session.api
  }

  async sftpUpload(host: HostConfig, secret: SecretMaterial, localPath: string, remotePath: string): Promise<void> {
    const body = await readFile(localPath)
    const dir = remotePath.slice(0, remotePath.lastIndexOf('/'))
    if (dir.length > 0) {
      await this.exec(host, secret, `mkdir -p ${shJoin([dir])} && chmod 700 ${shJoin([dir])}`, 20_000)
    }
    await this.sftpWrite(host, secret, remotePath, body)
    await this.exec(host, secret, `chmod 755 ${shJoin([remotePath])}`, 15_000)
  }

  private acquire(host: HostConfig, secret: SecretMaterial, requireTrust: boolean): Promise<Live> {
    return claimPending(this.live, host.id, async () => {
      await this.reserve()
      try {
        const client = await connect(host, secret, key => {
          const fingerprint = formatFingerprint(key)
          if (!requireTrust) return true
          return host.fingerprint.trim().length > 0 && host.fingerprint.trim() === fingerprint
        })
        const live: Live = {
          client,
          hostId: host.id,
          markDead: () => drop(),
        }
        let released = false
        const drop = () => {
          if (released) return
          released = true
          const current = this.live.get(host.id)
          void current?.then(value => {
            if (value === live) this.live.delete(host.id)
          }).catch(() => undefined)
          void live.sftp?.then(session => session.end()).catch(() => undefined)
          this.release()
        }
        client.on('close', drop)
        client.on('end', drop)
        return live
      } catch (error) {
        this.release()
        throw error
      }
    })
  }

  private reserve(): Promise<void> {
    if (this.active < this.maxConnections) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.waiters.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.active -= 1
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }
}

function connect(host: HostConfig, secret: SecretMaterial, accept: (key: Buffer) => boolean): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const fail = (error: unknown) => {
      client.end()
      reject(error instanceof Error ? error : new SshFailure(String(error), 'connect'))
    }
    client.once('ready', () => resolve(client))
    client.once('error', fail)
    // A live connection can emit `error` again later (a keepalive timeout, a
    // socket reset). The `once` above is already spent, and EventEmitter throws
    // when it emits `error` with no listener — which dsh reports as a fatal
    // uncaught exception and exits on. The pool's own handlers decide.
    client.on('error', () => undefined)
    const options: ConnectConfig = {
      ...sshConnectOptions(host),
      hostVerifier: (key: Buffer) => accept(key),
    }
    if (host.auth === 'password') {
      if (!secret.password) {
        fail(new SshFailure('password is not stored for this host', 'auth'))
        return
      }
      options.password = secret.password
    } else if (host.privateKeyPath.trim().length > 0) {
      void readFile(host.privateKeyPath).then(key => {
        options.privateKey = key
        if (secret.passphrase) options.passphrase = secret.passphrase
        client.connect(options)
      }).catch(fail)
      return
    }
    client.connect(options)
  })
}

interface ExecStream {
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'close', listener: (code?: number | null, signal?: string | null) => void): void
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void }
  close(): void
  signal?(name: string, callback?: () => void): void
  write(chunk: Buffer | string): boolean
  end(): void
}

/**
 * ssh2 emits `close` with only the exit code on a normal exit, so `signal` is
 * absent there, and a channel closed without an exit status leaves `code`
 * absent too. The harness rejects a tool value holding `undefined` because it
 * is not lossless JSON, so both fields become `null` at this boundary.
 */
export function exitFields(cause: 'exit' | 'timeout' | 'cancel' | 'truncate', code?: number | null, signal?: string | null): Pick<ExecResult, 'code' | 'signal'> {
  if (cause !== 'exit') return { code: null, signal: 'KILL' }
  return { code: code ?? null, signal: signal ?? null }
}

/**
 * OpenSSH 9.x answers a failed `session_open` — the usual cause is `MaxSessions` —
 * with reason 2 and the default description "open failed". The packet does not
 * carry the configured limit. "administratively prohibited" is a different
 * refusal and is left unchanged.
 */
const SESSION_TABLE_FULL = /channel open failure:\s*open failed/i

export function channelLimitMessage(error: unknown): SshFailure | undefined {
  if (!(error instanceof Error) || !SESSION_TABLE_FULL.test(error.message)) return undefined
  return new SshFailure(
    'this host refused another SSH session. File transfer and remote commands share this connection, so closing a sidebar terminal may not free a slot. Close one of those, or raise MaxSessions in the remote sshd_config.',
    'pty',
  )
}

function execPty(client: Client, request: PtyRequest): Promise<PtyChannel> {
  return new Promise((resolve, reject) => {
    client.exec(request.command, {
      pty: { term: request.term, cols: request.cols, rows: request.rows },
    }, (error, stream) => {
      if (error) {
        reject(channelLimitMessage(error) ?? new SshFailure(error.message, 'pty'))
        return
      }
      resolve(stream as unknown as PtyChannel)
    })
  })
}

function openChannel(client: Client, command: string, timeoutMs: number, stdin?: string | Buffer, onOutput?: (chunk: CommandChunk) => void): RemoteCommand {
  let settled = false
  let cause: 'exit' | 'timeout' | 'cancel' | 'truncate' = 'exit'
  let stream: ExecStream | undefined
  let resolveDone: (result: ExecResult) => void = () => undefined
  let rejectDone: (error: Error) => void = () => undefined
  const done = new Promise<ExecResult>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutTruncated = false
  let stderrTruncated = false
  const decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  }
  const decoderEnded = { stdout: false, stderr: false }
  const truncationNoted = { current: false }
  const emit = (which: 'stdout' | 'stderr', text: string) => {
    if (text.length === 0 || onOutput === undefined) return
    try {
      onOutput({ stream: which, text })
    } catch {
      // An observer must not tear the channel down.
    }
  }
  const flushDecoder = (which: 'stdout' | 'stderr') => {
    if (decoderEnded[which]) return
    decoderEnded[which] = true
    emit(which, decoders[which].end())
  }
  const markTruncation = (which: 'stdout' | 'stderr') => {
    flushDecoder(which)
    emit(which, truncationMarker(truncationNoted))
  }
  const finish = (code?: number | null, signal?: string | null) => {
    if (settled) return
    settled = true
    flushDecoder('stdout')
    flushDecoder('stderr')
    clearTimeout(timer)
    clearTimeout(fallback)
    resolveDone({
      ...exitFields(cause, code, signal),
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut: cause === 'timeout',
      stdoutTruncated,
      stderrTruncated,
    })
  }
  let fallback: ReturnType<typeof setTimeout> | undefined
  const stop = (next: 'timeout' | 'cancel' | 'truncate') => {
    if (settled || cause !== 'exit') return
    cause = next
    if (stream === undefined) {
      finish(null, null)
      return
    }
    try {
      stream.signal?.('KILL', () => undefined)
    } catch {
      // The channel may already be gone.
    }
    try {
      stream.close()
    } catch {
      // Closing a finished channel is the outcome we wanted.
    }
    fallback = setTimeout(() => finish(null, 'KILL'), 2000)
  }
  const timer = timeoutMs > 0 ? setTimeout(() => stop('timeout'), timeoutMs) : undefined
  try {
    client.exec(command, (error, opened) => {
      if (error) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          rejectDone(new SshFailure(error.message, 'exec'))
        }
        return
      }
      stream = opened as unknown as ExecStream
      const push = (target: Buffer[], chunk: Buffer, which: 'stdout' | 'stderr') => {
        const used = target.reduce((sum, part) => sum + part.length, 0)
        const room = OUTPUT_CAP - used
        if (room <= 0) {
          if (which === 'stdout') stdoutTruncated = true
          else stderrTruncated = true
          markTruncation(which)
          stop('truncate')
          return
        }
        const kept = Buffer.from(chunk.subarray(0, Math.min(chunk.length, room)))
        target.push(kept)
        emit(which, takeChannelText(decoders[which], kept))
        if (kept.length < chunk.length) {
          if (which === 'stdout') stdoutTruncated = true
          else stderrTruncated = true
          markTruncation(which)
          stop('truncate')
        }
      }
      stream.on('data', chunk => push(stdout, chunk, 'stdout'))
      stream.stderr.on('data', chunk => push(stderr, chunk, 'stderr'))
      stream.on('close', (code, signal) => finish(code, signal))
      if (stdin !== undefined && cause === 'exit') {
        stream.write(typeof stdin === 'string' ? Buffer.from(stdin) : stdin)
        stream.end()
      }
      if (cause !== 'exit') {
        try {
          stream.signal?.('KILL', () => undefined)
        } catch {
          // The channel may already be gone.
        }
        try {
          stream.close()
        } catch {
          // Closing a finished channel is the outcome we wanted.
        }
      }
    })
  } catch (error) {
    // `client.exec` throws synchronously once the socket is gone, so the error
    // never reaches the callback. Surface it as the same rejection instead of
    // throwing out of `openChannel` where no caller expects it.
    settled = true
    clearTimeout(timer)
    clearTimeout(fallback)
    rejectDone(error instanceof Error ? new SshFailure(error.message, 'exec') : new SshFailure(String(error), 'exec'))
  }
  return { done, close: () => stop('cancel') }
}

interface SftpLike {
  readFile(path: string, callback: (error: Error | undefined, data: Buffer) => void): void
  writeFile(path: string, data: Buffer | string, callback: (error: Error | undefined) => void): void
  realpath(path: string, callback: (error: Error | undefined, resolved: string) => void): void
  readdir(path: string, callback: (error: Error | undefined, list: ReadonlyArray<{ filename: string, attrs: { isDirectory(): boolean } }>) => void): void
  stat(path: string, callback: (error: Error | undefined, stats: { size: number, mode?: number, isDirectory(): boolean }) => void): void
  /** `attrs` is optional in ssh2: `mkdir(path, callback)` sends an empty ATTRS. */
  mkdir(path: string, callback: (error: Error | undefined) => void): void
  end(callback?: () => void): void
  /** The underlying SFTP implementation is an EventEmitter; only `error` matters here. */
  on(event: 'error', listener: (error: Error) => void): void
}

function openSftp(client: Client): Promise<SftpSession> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(new SshFailure(error.message, 'sftp'))
        return
      }
      const api = sftp as unknown as SftpLike
      // ssh2 removes the only `error` listener on this emitter the moment the
      // session reports `ready` (see `removeListeners` in vendored client.js),
      // but a protocol fault afterwards still emits `error`
      // (`doFatalSFTPError`). An EventEmitter throws on an unhandled `error`
      // event, and dsh treats that as a fatal uncaught exception and exits.
      // Keeping one listener here does not swallow the fault: ssh2 fails every
      // in-flight request with it, so the call that triggered it still rejects.
      api.on('error', () => undefined)
      resolve({
        api,
        end: () => {
          try {
            api.end()
          } catch {
            // The session channel is already closed.
          }
        },
      })
    })
  })
}

async function closeLive(live: Live): Promise<void> {
  try {
    const session = await live.sftp
    session?.end()
  } catch {
    // Opening SFTP failed; the client close still releases the session slot.
  }
  live.client.end()
}

/**
 * `mode` stays `undefined` when the server does not report it: a fabricated `0`
 * would be indistinguishable from a real `000` and would chmod the file to
 * nothing. A new file then keeps the remote umask.
 */
function statInfo(sftp: SftpLike, remotePath: string): Promise<{ isDirectory: boolean, size: number, mode?: number }> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) reject(new SshFailure(error.message, 'sftp-stat'))
      else resolve({ isDirectory: stats.isDirectory(), size: stats.size, mode: typeof stats.mode === 'number' ? stats.mode : undefined })
    })
  })
}

function statSize(sftp: SftpLike, remotePath: string): Promise<number> {
  return statInfo(sftp, remotePath).then(info => info.size)
}

function readAll(sftp: SftpLike, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(remotePath, (error, data) => {
      if (error) reject(new SshFailure(error.message, 'sftp-read'))
      else resolve(data)
    })
  })
}

function writeAll(sftp: SftpLike, remotePath: string, body: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, body, error => {
      if (error) reject(new SshFailure(error.message, 'sftp-write'))
      else resolve()
    })
  })
}

/**
 * One `MKDIR`. The reply is a status only, so the error text is the whole
 * diagnosis: ssh2 reports SFTP status 4 as "Failure" and OpenSSH's wording
 * ("File exists", "Permission denied") reaches the caller unchanged.
 */
function makeDirectory(sftp: SftpLike, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(remotePath, error => {
      if (error) reject(new SshFailure(error.message, 'sftp-mkdir'))
      else resolve()
    })
  })
}

function realpathOf(sftp: SftpLike, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (error, resolved) => {
      if (error) reject(new SshFailure(error.message, 'sftp-realpath'))
      else resolve(resolved)
    })
  })
}

function readdir(sftp: SftpLike, remotePath: string): Promise<ReadonlyArray<{ filename: string, attrs: { isDirectory(): boolean } }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) reject(new SshFailure(error.message, 'sftp-list'))
      else resolve(list)
    })
  })
}
