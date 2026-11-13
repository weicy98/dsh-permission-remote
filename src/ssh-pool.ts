import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { open, readFile, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { PassThrough, type Duplex } from 'node:stream'
import { Client, type ConnectConfig } from './ssh2-client.ts'
import type { HostConfig } from './config.ts'
import { claimPending } from './pool-claim.ts'
import { shJoin } from './shell-quote.ts'

const OUTPUT_CAP = 1024 * 1024
const FORWARD_OPEN_TIMEOUT_MS = 10_000

function abortError(): Error {
  const error = new Error('SSH operation aborted')
  error.name = 'AbortError'
  return error
}

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

/** A live exec channel with raw stdout/stderr streams for the PTC transport. */
export interface PtcExecHandle {
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly done: Promise<ExecResult>
  write(data: Buffer | string): void
  end(): void
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

/**
 * How long cleanup waits for an SFTP callback that ignores the abort signal.
 *
 * A hung `open`, `write`, or `close` callback cannot be cancelled at the
 * protocol layer; the transfer deadline makes the caller return, but cleanup
 * must not inherit that unbounded wait. Five seconds is enough for a live
 * channel to report a close and short enough that a dead one still fails the
 * tool call promptly.
 */
export const CLEANUP_SETTLE_TIMEOUT_MS = 5_000

/**
 * How long cleanup first gives a transfer to answer its own abort.
 *
 * A writer notices the signal between chunks, so a transfer that is not stuck
 * settles well inside this window. Waiting the full cleanup bound and only
 * then tearing the channel down would add five seconds to every ordinary
 * timeout, which the model experiences as a hung tool call.
 */
export const COOPERATIVE_SETTLE_MS = 250

/** Wait for `work` at most `timeoutMs`, swallowing its result/error. Returns whether it settled. */
export function settleWithin(work: Promise<unknown>, timeoutMs = CLEANUP_SETTLE_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.then(() => true, () => true),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Like {@link settleWithin}, but reports whether `work` resolved (not rejected). */
async function settleConfirmed(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work.then(value => value !== false, () => false),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Adopt `work` but stop waiting for it when `signal` aborts.
 *
 * The shared work is not cancelled: other callers may still be waiting on it.
 * Only this caller detaches, which is what a transfer deadline or a cancelled
 * tool call must do — it must not fail the host's connection for everyone else.
 */
function detachOnAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) {
    work.catch(() => undefined)
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => {
      work.catch(() => undefined)
      finish(() => reject(abortError()))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    work.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

export interface DirEntry {
  readonly name: string
  readonly path: string
}

/** One directory entry, including files. `sftpList` stays directories only. */
export interface RemoteDirEntry {
  readonly name: string
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size: number
  readonly mtime: number
}

/** `stat` follows the last symlink. `lstat` does not. `undefined` means the path is absent. */
export interface SftpAttrs {
  readonly type: 'file' | 'directory' | 'symlink' | 'other'
  readonly size: number
  readonly mtime: number
  readonly mode?: number
}

/**
 * One transfer's own SFTP channel.
 *
 * A transfer must not share `Live.sftp`: aborting it has to destroy its channel
 * without disturbing a concurrent `ssh_read`, file tree listing, or PTC file
 * operation on the same host.
 *
 * `close()` is idempotent. After `session.end()` it waits up to
 * `CLEANUP_SETTLE_TIMEOUT_MS` for the server's channel close — that event is
 * the only proof that every OPEN/WRITE already sent has been processed. `rm`
 * runs on a *different* exec channel, so deleting the temporary file before
 * the server confirms the close lets an in-flight `OPEN` recreate it afterwards
 * with nobody left to clean up. `settled()` reports whether that confirmation
 * arrived; a cleanup whose channel never confirmed must report the possible
 * leak instead of silently leaving the file behind.
 */
export interface SftpLease {
  readonly api: SftpLike
  close(): Promise<void>
  /** Optional for third-party/mock leases; absent means "unknown". */
  readonly settled?: () => boolean
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

/**
 * SFTP status codes (draft-ietf-secsh-filexfer-02 §7). ssh2 copies the server's
 * numeric status onto `error.code`, so a classification can read the code
 * instead of guessing from the message: the wording is chosen by the server and
 * is localised by some of them, but the code is not.
 */
export const SFTP_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const

/**
 * An SSH or SFTP operation failed.
 *
 * `status` carries the protocol's numeric SFTP code when the server sent one.
 * Callers must prefer it over the message: OpenSSH localises its error strings,
 * and every SFTP server picks its own wording for a bare status.
 */
export class SshFailure extends Error {
  constructor(
    message: string,
    readonly stage: string,
    /** Numeric SFTP status, when the failure came from a STATUS response. */
    readonly status?: number,
    /**
     * Set when the read stopped at a byte cap rather than failing.
     *
     * A caller that maps errors must be able to tell "too large" from "I/O
     * failed" without matching the message text: the wording is ours today but
     * a translation or a rephrase would silently downgrade the code.
     */
    readonly limitExceeded?: boolean,
  ) {
    super(message)
    this.name = 'SshFailure'
  }
}

/** The numeric SFTP status carried by an ssh2 error, when it has one. */
export function sftpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'number' ? code : undefined
}

/** Build a failure from an ssh2 error, keeping its SFTP status. */
function failureOf(error: Error, stage: string): SshFailure {
  return new SshFailure(error.message, stage, sftpStatusOf(error))
}

/**
 * Numeric SFTP status, from `SshFailure.status` or from the `code` ssh2 sets
 * on the raw STATUS error. `attrsOf` classifies the raw error before it is
 * wrapped, so the code has to be visible there too.
 */
function sftpFailureStatus(error: unknown): number | undefined {
  if (error instanceof SshFailure && typeof error.status === 'number') return error.status
  return sftpStatusOf(error)
}

/** The path is not there. The code is authoritative; the message is the fallback. */
export function isSftpMissing(error: unknown): boolean {
  const status = sftpFailureStatus(error)
  if (status === SFTP_STATUS.NO_SUCH_FILE) return true
  // A status of FAILURE is what a server without a specific code sends; the
  // message still distinguishes "no such file" for those.
  if (status !== undefined && status !== SFTP_STATUS.FAILURE) return false
  return error instanceof Error && /no such file|cannot find|not found|does not exist/i.test(error.message)
}

/** Whether a read refused to continue because the file exceeded its byte cap. */
export function isByteLimitExceeded(error: unknown): boolean {
  return error instanceof SshFailure && error.limitExceeded === true
}

/** The server refused the operation on permissions. Code first, message second. */
export function isSftpPermissionDenied(error: unknown): boolean {
  const status = sftpFailureStatus(error)
  if (status === SFTP_STATUS.PERMISSION_DENIED) return true
  if (status !== undefined && status !== SFTP_STATUS.FAILURE) return false
  return error instanceof Error && /permission denied/i.test(error.message)
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
  /** Resolves when the channel is done emitting; `end()` alone does not await the handshake. */
  readonly closed: Promise<void>
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

/**
 * One in-flight connection open for a host, shared by every concurrent caller.
 *
 * `waiters` counts callers that have not detached yet. When it reaches zero
 * before the opening settles, `controller` aborts so `openLive` releases the
 * reserved slot instead of connecting for a caller that already gave up.
 */
interface OpeningState {
  waiters: number
  settled: boolean
}

const FINGERPRINT_PREFIX = 'SHA256:'

/**
 * An OpenSSH-style fingerprint: `SHA256:` plus the standard base64 digest with
 * padding removed. ssh2 hands us the digest as a hex string when `hostHash` is
 * set, so decode it first; a Buffer is accepted too.
 */
export function formatFingerprint(hashedKey: Buffer | string): string {
  const digest = typeof hashedKey === 'string' ? Buffer.from(hashedKey, 'hex') : hashedKey
  return `${FINGERPRINT_PREFIX}${digest.toString('base64').replace(/=+$/, '')}`
}

/**
 * The old hex spelling this plugin used to store. Kept only so a host trusted
 * before the format change still verifies; a re-trust stores the new spelling.
 */
export function legacyFingerprint(hashedKey: Buffer | string): string {
  const hex = typeof hashedKey === 'string' ? hashedKey : hashedKey.toString('hex')
  return `${FINGERPRINT_PREFIX}${hex}`
}

/** Whether a stored fingerprint matches the offered key in either spelling. */
export function fingerprintMatches(stored: string, hashedKey: Buffer | string): boolean {
  const value = stored.trim()
  if (value.length === 0) return false
  return value === formatFingerprint(hashedKey) || value === legacyFingerprint(hashedKey)
}

/** Expand a leading `~` against this (the harness) user's home; other paths stay as typed. */
function expandTildePath(input: string): string {
  const text = input.trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return input
}

export class SshPool {
  private readonly live = new Map<string, Promise<Live>>()
  private readonly openings = new Map<string, OpeningState>()
  private readonly waiters: Array<() => void> = []
  private readonly forwards = new Set<Duplex>()
  private active = 0
  private disposed = false

  constructor(readonly maxConnections: number) {}

  async dispose(): Promise<void> {
    this.disposed = true
    for (const channel of this.forwards) {
      try {
        channel.destroy()
      } catch {
        // Already gone.
      }
    }
    this.forwards.clear()
    const pending = [...this.live.values()]
    this.live.clear()
    this.openings.clear()
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
    // `disposed` stays set for good: after plugin unload no caller may open a
    // fresh connection through this pool. Only an explicit test helper can
    // re-arm it, so a production unload is final.
  }

  /**
   * Re-arm a disposed pool for the next phase of a test/harness.
   *
   * `dispose()` deliberately leaves the pool permanently disposed; tests that
   * reuse one pool across phases must opt back in explicitly instead of making
   * production unload reversible by default.
   */
  resetForTest(): void {
    this.disposed = false
    this.active = 0
    this.waiters.length = 0
    this.live.clear()
    this.openings.clear()
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

  /** Whether a session (or an in-flight opening) is cached for this host id. */
  hasSession(hostId: string): boolean {
    return this.live.has(hostId)
  }

  /**
   * Connection slots not currently reserved.
   *
   * A slot is held from `reserve()` until the connection's `close`/`end`, so
   * an operation that needs two *new* connections must check this before it
   * takes the first one: the first connection cannot close while the operation
   * is streaming, and the second `reserve()` would queue forever.
   */
  freeSlots(): number {
    if (!Number.isFinite(this.maxConnections)) return 0
    return Math.max(0, this.maxConnections - this.active)
  }

  /**
   * Open one PTY channel on the host's pooled connection. The connection stays
   * up when the shell exits; `dispose` and `invalidate` close it.
   */
  async openPty(host: HostConfig, secret: SecretMaterial, request: PtyRequest): Promise<OpenPty> {
    if (request.signal?.aborted) throw new SshFailure('pty allocation aborted', 'pty')
    const live = await this.acquire(host, secret, true, request.signal)
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
    const live = await this.acquire(host, secret, true, signal)
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

  /**
   * Open one raw exec channel with live stdout/stderr streams. This is the
   * transport used by the PTC shim; unlike {@link open}, it does not buffer
   * output and it keeps the child descriptor open for the control channel.
   */
  async openPtcExec(host: HostConfig, secret: SecretMaterial, command: string, signal?: AbortSignal): Promise<PtcExecHandle> {
    const live = await this.acquire(host, secret, true, signal)
    if (signal?.aborted === true) throw abortError()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const queued: Buffer[] = []
    let ending = false
    let stream: ExecStream | undefined
    let settled = false
    let resolveDone: (result: ExecResult) => void = () => undefined
    let rejectDone: (error: Error) => void = () => undefined
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    const done = new Promise<ExecResult>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    const finish = (code?: number | null, signalValue?: string | null) => {
      if (settled) return
      settled = true
      if (closeTimer !== undefined) {
        clearTimeout(closeTimer)
        closeTimer = undefined
      }
      stdout.end()
      stderr.end()
      resolveDone({
        ...exitFields('exit', code, signalValue),
        stdout: '',
        stderr: '',
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      })
    }
    const close = () => {
      if (settled) return
      if (stream === undefined) {
        finish(null, 'KILL')
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
      // A dead SSH transport may never deliver the channel close event. Do
      // not leave timeout/cancel callers waiting forever.
      if (closeTimer === undefined) {
        closeTimer = setTimeout(() => finish(null, 'KILL'), 1000)
      }
    }
    try {
      live.client.exec(command, (error, opened) => {
        if (error) {
          if (!settled) {
            settled = true
            stdout.end()
            stderr.end()
            rejectDone(new SshFailure(error.message, 'exec'))
          }
          return
        }
        stream = opened as unknown as ExecStream
        if (settled) {
          try {
            stream.close()
          } catch {
            // The channel was already closed while the open was in flight.
          }
          return
        }
        stream.on('data', chunk => {
          if (!settled) stdout.write(chunk)
        })
        stream.stderr.on('data', chunk => {
          if (!settled) stderr.write(chunk)
        })
        stream.on('close', (code, signalValue) => finish(code, signalValue))
        for (const chunk of queued) stream.write(chunk)
        queued.length = 0
        if (ending) stream.end()
        if (signal?.aborted === true) close()
      })
    } catch (error) {
      if (!settled) {
        settled = true
        stdout.end()
        stderr.end()
        rejectDone(error instanceof Error ? error : new SshFailure(String(error), 'exec'))
      }
    }
    if (signal !== undefined) {
      const abort = () => close()
      signal.addEventListener('abort', abort, { once: true })
      settleThen(done, () => signal.removeEventListener('abort', abort))
    }
    return {
      stdout,
      stderr,
      done,
      write: (data: Buffer | string) => {
        if (settled) return
        if (stream === undefined) {
          queued.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
          return
        }
        try {
          stream.write(data)
        } catch {
          // The close path reports the transport failure.
        }
      },
      end: () => {
        if (settled) return
        ending = true
        if (stream === undefined) return
        try {
          stream.end()
        } catch {
          // Already closed.
        }
      },
      close,
    }
  }

  /**
   * One long-lived exec whose stdin is a series of probe lines. The caller
   * owns the lifetime. This is the model terminal's foreground probe: a new
   * `exec` per poll would spend a session slot every 50ms.
   */
  async openEval(host: HostConfig, secret: SecretMaterial, command: string, signal?: AbortSignal): Promise<{ stdout: PassThrough, write(data: string): void, close(): void }> {
    const opened = await this.openPtcExec(host, secret, command, signal)
    // `openEval` exposes only stdout. Without a reader, the stderr PassThrough
    // buffers every diagnostic for the lifetime of this long-lived probe
    // shell; the caller never sees it, so switch it into flowing/discard mode.
    opened.stderr.on('error', () => undefined)
    opened.stderr.resume()
    // The caller only sees the byte stream. `done` rejects when the exec
    // channel never opens; leaving that rejection unobserved takes dsh down.
    void opened.done.catch(() => undefined)
    return {
      stdout: opened.stdout,
      write: data => opened.write(data),
      close: () => opened.close(),
    }
  }

  /** Open one direct-streamlocal channel for the PTC control socket. */
  async forwardOutStreamLocal(host: HostConfig, secret: SecretMaterial, socketPath: string, signal?: AbortSignal): Promise<Duplex> {
    const live = await this.acquire(host, secret, true, signal)
    if (signal?.aborted === true) throw abortError()
    const client = live.client as unknown as {
      openssh_forwardOutStreamLocal(path: string, callback: (error: Error | undefined, channel: Duplex | undefined) => void): void
    }
    return await new Promise<Duplex>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => finish(abortError())
      const finish = (error?: Error, channel?: Duplex): void => {
        if (settled) {
          channel?.destroy()
          return
        }
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error !== undefined) {
          channel?.destroy()
          reject(error)
          return
        }
        this.forwards.add(channel!)
        channel!.once('close', () => this.forwards.delete(channel!))
        resolve(channel!)
      }
      timer = setTimeout(() => finish(new SshFailure('streamlocal forward timed out', 'forward-streamlocal')), FORWARD_OPEN_TIMEOUT_MS)
      if (signal !== undefined) {
        if (signal.aborted) {
          finish(abortError())
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        client.openssh_forwardOutStreamLocal(socketPath, (error, channel) => {
          if (error !== undefined || channel === undefined) {
            finish(new SshFailure(error?.message ?? 'streamlocal forward returned no channel', 'forward-streamlocal'))
            return
          }
          if (signal?.aborted === true) {
            finish(abortError(), channel)
            return
          }
          finish(undefined, channel)
        })
      } catch (error) {
        finish(error instanceof Error ? error : new SshFailure(String(error), 'forward-streamlocal'))
      }
    })
  }

  /** Open one direct-tcpip channel for the PTC control socket fallback. */
  async forwardOutTcp(host: HostConfig, secret: SecretMaterial, hostname: string, port: number, signal?: AbortSignal): Promise<Duplex> {
    const live = await this.acquire(host, secret, true, signal)
    if (signal?.aborted === true) throw abortError()
    const client = live.client as unknown as {
      forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number, callback: (error: Error | undefined, channel: Duplex | undefined) => void): void
    }
    return await new Promise<Duplex>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = () => finish(abortError())
      const finish = (error?: Error, channel?: Duplex): void => {
        if (settled) {
          channel?.destroy()
          return
        }
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error !== undefined) {
          channel?.destroy()
          reject(error)
          return
        }
        this.forwards.add(channel!)
        channel!.once('close', () => this.forwards.delete(channel!))
        resolve(channel!)
      }
      timer = setTimeout(() => finish(new SshFailure('tcp forward timed out', 'forward-tcp')), FORWARD_OPEN_TIMEOUT_MS)
      if (signal !== undefined) {
        if (signal.aborted) {
          finish(abortError())
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      try {
        client.forwardOut('127.0.0.1', 0, hostname, port, (error, channel) => {
          if (error !== undefined || channel === undefined) {
            finish(new SshFailure(error?.message ?? 'tcp forward returned no channel', 'forward-tcp'))
            return
          }
          if (signal?.aborted === true) {
            finish(abortError(), channel)
            return
          }
          finish(undefined, channel)
        })
      } catch (error) {
        finish(error instanceof Error ? error : new SshFailure(String(error), 'forward-tcp'))
      }
    })
  }

  /** Connect far enough to read the host key. Does not persist trust. */
  async offerFingerprint(host: HostConfig, secret: SecretMaterial): Promise<{ fingerprint: string, trusted: boolean, banner: string }> {
    const stored = host.fingerprint.trim()
    let offered = ''
    let live: Client | undefined
    try {
      live = await connect(host, secret, (key: Buffer) => {
        offered = formatFingerprint(key)
        return fingerprintMatches(stored, key)
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

  async sftpRead(host: HostConfig, secret: SecretMaterial, remotePath: string, maxBytes?: number, signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) throw new SshFailure('sftp read aborted', 'sftp-read')
    const session = await this.sftp(host, secret, signal)
    if (maxBytes !== undefined) {
      const size = await statSize(session, remotePath)
      if (size > maxBytes) throw new SshFailure(`file is ${size} bytes, over the ${maxBytes} byte limit`, 'sftp-read', undefined, true)
      // Enforce the cap on the bytes actually read too: the size above is only
      // the pre-read stat, and a file that grows afterwards must not be pulled
      // whole into memory.
      return readAllCapped(session, remotePath, maxBytes, signal)
    }
    // A caller that supplied a signal expects the read to be cancellable even
    // without a byte cap. Use the chunked path with no practical cap rather
    // than the eager readFile helper, which cannot observe an abort.
    if (signal !== undefined) return readAllCapped(session, remotePath, Number.MAX_SAFE_INTEGER, signal)
    return readAll(session, remotePath)
  }

  /**
   * Open a transfer-scoped SFTP channel on the host's shared SSH connection.
   *
   * Unlike {@link sftp}, the channel is not cached and is not shared with any
   * other caller. Closing it on failure therefore cannot disturb a concurrent
   * `ssh_read`, file tree listing, or PTC file operation.
   */
  async openSftpLease(host: HostConfig, secret: SecretMaterial, signal?: AbortSignal): Promise<SftpLease> {
    const live = await this.acquire(host, secret, true, signal)
    if (signal?.aborted === true) throw abortError()
    const session = await openSftp(live.client)
    let closing: Promise<void> | undefined
    let settled = false
    return {
      api: session.api,
      settled: () => settled,
      close: () => {
        closing ??= (async () => {
          session.end()
          // `end()` queues CHANNEL_CLOSE behind every OPEN/WRITE this transfer
          // sent, but the server handles them in its own sftp-server child. A
          // 250ms cooperative bound is shorter than a WAN round trip: the
          // channel close event is the barrier that proves the queue drained,
          // so wait the full cleanup budget for it. A healthy channel answers
          // in milliseconds; only a dead one costs the whole budget.
          settled = await settleWithin(session.closed, CLEANUP_SETTLE_TIMEOUT_MS)
        })()
        return closing
      },
    }
  }

  /**
   * Stream one local file to an existing remote path.
   *
   * `maxBytes` of `0` means the operator chose no ceiling: the copy still
   * moves one chunk at a time, and a full disk fails the write instead of
   * growing the process without bound.
   */
  async sftpSendLocal(
    host: HostConfig,
    secret: SecretMaterial,
    localPath: string,
    remotePath: string,
    options: { maxBytes?: number, signal?: AbortSignal } = {},
  ): Promise<number> {
    const session = await this.sftp(host, secret, options.signal)
    return streamLocalToSftp(session, localPath, remotePath, options.maxBytes ?? 0, options.signal)
  }

  /** {@link sftpSendLocal} on a transfer lease, so a failure cannot touch other SFTP work. */
  async sftpSendLocalOn(
    lease: SftpLease,
    localPath: string,
    remotePath: string,
    options: { maxBytes?: number, signal?: AbortSignal } = {},
  ): Promise<number> {
    return streamLocalToSftp(lease.api, localPath, remotePath, options.maxBytes ?? 0, options.signal)
  }

  /**
   * Stream a chunk source onto an existing remote path.
   *
   * The source is read lazily, so a caller can hand over another host's SFTP
   * chunks without buffering the file. `maxBytes` of `0` still writes one
   * bounded window at a time.
   */
  async sftpSendChunks(
    host: HostConfig,
    secret: SecretMaterial,
    remotePath: string,
    source: AsyncIterable<Buffer>,
    options: StreamChunksOptions = {},
  ): Promise<number> {
    const session = await this.sftp(host, secret, options.signal)
    return streamChunksToSftp(session, remotePath, source, options)
  }

  /** {@link sftpSendChunks} on a transfer lease. */
  async sftpSendChunksOn(
    lease: SftpLease,
    remotePath: string,
    source: AsyncIterable<Buffer>,
    options: StreamChunksOptions = {},
  ): Promise<number> {
    return streamChunksToSftp(lease.api, remotePath, source, options)
  }

  async sftpWrite(host: HostConfig, secret: SecretMaterial, remotePath: string, body: Buffer | string): Promise<void> {
    const session = await this.sftp(host, secret)
    await writeAll(session, remotePath, body)
  }

  async sftpRename(host: HostConfig, secret: SecretMaterial, fromPath: string, toPath: string): Promise<void> {
    const session = await this.sftp(host, secret)
    await renameRemote(session, fromPath, toPath)
  }

  async sftpRealpath(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string> {
    const session = await this.sftp(host, secret)
    return realpathOf(session, remotePath)
  }

  async sftpStat(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<{ isDirectory: boolean, size: number, mode?: number, type?: SftpAttrs['type'] }> {
    const session = await this.sftp(host, secret)
    return statInfo(session, remotePath)
  }

  async sftpList(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<DirEntry[]> {
    const session = await this.sftp(host, secret)
    const rows = await readdir(session, remotePath)
    return rows
      .filter(row => row.filename.length > 0 && row.filename !== '.' && row.filename !== '..'
        && !row.filename.includes('/') && !row.filename.includes('\\')
        && attrsFrom(row.attrs, row.longname).type === 'directory')
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

  private async sftp(host: HostConfig, secret: SecretMaterial, signal?: AbortSignal): Promise<SftpLike> {
    const live = await this.acquire(host, secret, true, signal)
    if (live.sftp === undefined) {
      // A protocol fault destroys the SFTP channel but leaves the SSH connection
      // up (`doFatalSFTPError`). Clearing the cached session on that error makes
      // the next call open a fresh channel instead of reusing a destroyed one
      // until something else drops the whole connection. The identity check
      // keeps a late error from an older session clearing a newer one.
      let opening!: Promise<SftpSession>
      opening = openSftp(live.client, () => { if (live.sftp === opening) live.sftp = undefined }).catch(error => {
        if (live.sftp === opening) live.sftp = undefined
        throw error
      })
      live.sftp = opening
    }
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

  /**
   * Place a data file. The parent directory is private. The file itself keeps
   * the remote umask: `sftpUpload` marks a binary executable, and a document
   * must not become one.
   */
  async sftpPutFile(
    host: HostConfig,
    secret: SecretMaterial,
    localPath: string,
    remotePath: string,
    allowedRoot?: string,
    limits?: { maxBytes?: number, signal?: AbortSignal },
  ): Promise<void> {
    const dir = remotePath.slice(0, remotePath.lastIndexOf('/'))
    const signal = limits?.signal
    if (dir.length > 0) {
      await this.exec(host, secret, `mkdir -p ${shJoin([dir])} && chmod 700 ${shJoin([dir])}`, 20_000, signal)
      if (signal?.aborted === true) throw abortError()
      if (allowedRoot !== undefined) {
        const realDir = await this.sftpRealpath(host, secret, dir)
        if (!remotePathWithin(allowedRoot, realDir)) {
          throw new Error(`upload directory ${dir} escapes ${allowedRoot}`)
        }
      }
    }
    // A replacement should keep the old file's mode; a new file keeps the
    // remote umask. Read this before the rename replaces the directory entry.
    const previous = await this.sftpAttrs(host, secret, remotePath, false).catch(() => undefined)
    // Stream beside the target and rename over it. A dropped connection or a
    // full disk leaves the old target intact instead of truncating it with the
    // SFTP `w` open. The caller has already checked the final component is not
    // a symlink; the rename replaces the directory entry, never its target.
    const temporary = `${remotePath}.tmp-${process.pid}-${randomUUID()}`
    // A transfer-scoped channel: a hung open/write here can be closed without
    // touching the host's other SFTP work.
    const lease = await this.openSftpLease(host, secret, signal)
    const publish = (async () => {
      await streamLocalToSftp(lease.api, localPath, temporary, limits?.maxBytes ?? 0, signal)
      try {
        await renameRemote(lease.api, temporary, remotePath)
      } catch {
        // Standard SFTP rename is allowed to refuse an existing target. The
        // remote `mv -f` is the POSIX-overwrite fallback and keeps the write
        // atomic because the temporary file is in the same directory.
        const moved = await this.exec(host, secret, `mv -f ${shJoin([temporary, remotePath])}`, 20_000, signal)
        if (moved.code !== 0) throw new Error(moved.stderr || 'remote upload rename failed')
      }
      if (previous?.mode !== undefined) {
        // Drop the file-type bits. `0o100640` must chmod `640`, and `0` stays `0`.
        const mode = (previous.mode & 0o7777).toString(8)
        await this.exec(host, secret, `chmod ${mode} ${shJoin([remotePath])}`, 15_000).catch(() => undefined)
      }
    })()
    try {
      await finishOrCleanup(publish, signal, async () => {
        // Only runs after `beforeCleanup` confirms the channel is closed.
        await this.exec(host, secret, `rm -f ${shJoin([temporary])}`, 15_000).catch(() => undefined)
      }, async () => {
        // Wait for the server to confirm this transfer's channel close before
        // the `rm` on the separate exec channel. Return false when it never
        // confirmed: finishOrCleanup then skips the racy `rm` and the catch
        // below reports the possible temp path.
        await lease.close()
        return lease.settled?.() !== false
      })
    } catch (error) {
      const failure = signal?.aborted === true ? abortError() : error
      // `finishOrCleanup` has a bounded channel barrier; if the server never
      // confirmed the close, the temp file may have been recreated after the
      // `rm`. Keep the failure type and name the path for manual cleanup.
      if (lease.settled?.() === false && failure instanceof Error) {
        try {
          failure.message = `${failure.message}; the SFTP channel did not confirm its close, so a temporary file may remain: ${temporary}`
        } catch {
          // Frozen errors keep their message.
        }
      }
      throw failure
    } finally {
      void lease.close()
    }
  }

  /**
   * Write one private file from memory.
   *
   * The parent directory is `0700`. The file is written beside the target,
   * `chmod 600`'d, then renamed over it. `sftpPutFile` cannot do this: it
   * reads a local path, keeps the remote umask for a new file, and restores
   * the previous mode of an existing one. A rename that refuses an existing
   * target falls back to `mv -f`, which keeps the temporary file's mode.
   */
  async publishPrivateFile(host: HostConfig, secret: SecretMaterial, remotePath: string, body: Buffer): Promise<void> {
    const dir = remotePath.slice(0, remotePath.lastIndexOf('/'))
    if (dir.length > 0) {
      await this.exec(host, secret, `mkdir -p ${shJoin([dir])} && chmod 700 ${shJoin([dir])}`, 20_000)
    }
    const temporary = `${remotePath}.tmp-${process.pid}-${randomUUID()}`
    try {
      await this.sftpWrite(host, secret, temporary, body)
      await this.exec(host, secret, `chmod 600 ${shJoin([temporary])}`, 15_000)
      try {
        await this.sftpRename(host, secret, temporary, remotePath)
      } catch {
        const moved = await this.exec(host, secret, `mv -f ${shJoin([temporary, remotePath])}`, 20_000)
        if (moved.code !== 0) throw new Error(moved.stderr || 'remote publish rename failed')
      }
    } catch (error) {
      await this.exec(host, secret, `rm -f ${shJoin([temporary])}`, 15_000).catch(() => undefined)
      throw error
    }
  }

  async sftpAttrs(host: HostConfig, secret: SecretMaterial, remotePath: string, follow: boolean, signal?: AbortSignal): Promise<SftpAttrs | undefined> {
    const session = await this.sftp(host, secret, signal)
    const info = await attrsOf(session, remotePath, follow)
    if (info === undefined || info.mode !== undefined || info.type !== 'other') return info
    // A mode-less server cannot distinguish a FIFO/device from a regular file
    // through SFTP attributes. Ask the login shell for the remaining known
    // types; if the shell cannot answer, keep `other` and fail closed.
    return { ...info, type: await this.classifyRemoteType(host, secret, remotePath, follow) }
  }

  private async classifyRemoteType(host: HostConfig, secret: SecretMaterial, remotePath: string, follow: boolean): Promise<SftpAttrs['type']> {
    const path = shJoin([remotePath])
    const command = follow
      ? `if [ -d ${path} ]; then echo directory; elif [ -f ${path} ]; then echo file; else echo other; fi`
      : `if [ -L ${path} ]; then echo symlink; elif [ -d ${path} ]; then echo directory; elif [ -f ${path} ]; then echo file; else echo other; fi`
    try {
      const result = await this.exec(host, secret, command, 15_000)
      const kind = result.stdout.trim()
      if (result.code === 0 && (kind === 'file' || kind === 'directory' || kind === 'symlink' || kind === 'other')) return kind
    } catch {
      // Fall through to the fail-closed answer.
    }
    return 'other'
  }

  /** The symlink target. A non-link rejects; the caller decides which errors mean that. */
  async sftpReadLink(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string> {
    const session = await this.sftp(host, secret)
    return readLinkOf(session, remotePath)
  }

  /**
   * Whether `remotePath` can be opened as a directory. The names are not read:
   * a mode-less `stat` only needs the open to succeed.
   */
  async sftpProbeDir(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<void> {
    const session = await this.sftp(host, secret)
    await probeOpenDir(session, remotePath)
  }

  /** Files and directories. The settings picker uses {@link sftpList}, which drops files. */
  async sftpReadDir(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<RemoteDirEntry[]> {
    const session = await this.sftp(host, secret)
    const rows = await readdir(session, remotePath)
    const entries: RemoteDirEntry[] = []
    for (const row of rows) {
      if (row.filename === '.' || row.filename === '..' || row.filename.includes('/') || row.filename.includes('\\')) continue
      const attrs = attrsFrom(row.attrs, row.longname)
      entries.push({ name: row.filename, type: attrs.type, size: attrs.size, mtime: attrs.mtime })
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    return entries
  }

  /** One byte window. A short reply is read again until the window is full or a read returns nothing. */
  async sftpReadAt(host: HostConfig, secret: SecretMaterial, remotePath: string, offset: number, length: number): Promise<Buffer> {
    const session = await this.sftp(host, secret)
    return readOpenRange(session, remotePath, offset, length)
  }

  /** Chunks from one open handle. Stopping the generator closes the handle. */
  async *sftpReadChunks(host: HostConfig, secret: SecretMaterial, remotePath: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (signal?.aborted) throw new SshFailure('sftp read aborted', 'sftp-read')
    const session = await this.sftp(host, secret, signal)
    yield* readOpenChunks(session, remotePath, signal)
  }

  /** {@link sftpReadChunks} on a transfer lease. */
  async *sftpReadChunksOn(lease: SftpLease, remotePath: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (signal?.aborted) throw new SshFailure('sftp read aborted', 'sftp-read')
    yield* readOpenChunks(lease.api, remotePath, signal)
  }

  /**
   * One caller's view of the host's connection.
   *
   * The connection itself is shared: `claimPending` hands every concurrent
   * caller the same opening. A caller's `signal` therefore may not cancel it —
   * that would reject every other caller waiting on the same host, and a
   * transfer's deadline would surface as a failure of an unrelated read or
   * terminal. Cancellation detaches this caller only. When the last waiting
   * caller detaches before the connection is up, the opening is aborted so no
   * unused connection is created and no slot is held for it.
   */
  private acquire(host: HostConfig, secret: SecretMaterial, requireTrust: boolean, signal?: AbortSignal): Promise<Live> {
    if (this.disposed) return Promise.reject(new SshFailure('SSH pool is disposed', 'connect'))
    let state = this.openings.get(host.id)
    if (state === undefined) {
      state = { waiters: 0, settled: false }
      this.openings.set(host.id, state)
    }
    const joined = state
    joined.waiters += 1
    const opening = claimPending(this.live, host.id, () => this.openLive(host, secret, requireTrust, joined))
    void opening.then(
      () => { joined.settled = true; this.forgetOpening(host.id, joined) },
      () => { joined.settled = true; this.forgetOpening(host.id, joined) },
    )
    return detachOnAbort(opening, signal).finally(() => {
      joined.waiters -= 1
      if (joined.waiters <= 0) this.forgetOpening(host.id, joined)
    })
  }

  private forgetOpening(hostId: string, state: OpeningState): void {
    if (state.settled && state.waiters <= 0 && this.openings.get(hostId) === state) this.openings.delete(hostId)
  }

  /**
   * Establish the connection every caller for this host shares.
   *
   * It never receives a caller's signal. It checks the shared waiter count after
   * reserving a slot and after connecting, so an opening whose last caller gave
   * up releases the slot instead of caching a connection nobody asked for.
   */
  private openLive(host: HostConfig, secret: SecretMaterial, requireTrust: boolean, state: OpeningState): Promise<Live> {
    return (async () => {
      await this.reserve()
      if (this.disposed) {
        this.release()
        throw new SshFailure('SSH pool is disposed', 'connect')
      }
      if (state.waiters <= 0) {
        this.release()
        throw abortError()
      }
      try {
        const client = await connect(host, secret, key => {
          if (!requireTrust) return true
          return fingerprintMatches(host.fingerprint, key)
        })
        if (state.waiters <= 0) {
          client.end()
          throw abortError()
        }
        if (this.disposed) {
          client.end()
          throw new SshFailure('SSH pool is disposed', 'connect')
        }
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
    })()
  }

  /**
   * Take one connection slot, waiting for a free one.
   *
   * This is part of the host's shared opening, so it takes no caller signal:
   * cancelling it would reject the opening that every concurrent caller on the
   * same host is waiting on. A caller whose deadline fires while it is queued
   * detaches; if it was the last one, `openLive` cancels the opening and
   * releases the slot before connecting.
   */
  private reserve(): Promise<void> {
    if (this.disposed) return Promise.reject(new SshFailure('SSH pool is disposed', 'connect'))
    if (this.active < this.maxConnections) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise(resolve => {
      const grant = () => {
        this.active += 1
        resolve()
      }
      this.waiters.push(grant)
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
      void readFile(expandTildePath(host.privateKeyPath)).then(key => {
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
  // Node's timer clock is a signed 32-bit millisecond count: a larger delay
  // overflows and fires after 1 ms. Callers cap their own values, but clamp
  // here too so no caller can turn a big timeout into an instant failure.
  const timer = timeoutMs > 0 ? setTimeout(() => stop('timeout'), Math.min(timeoutMs, 2 ** 31 - 1)) : undefined
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

interface SftpStats {
  size: number
  mode?: number
  mtime?: number
  isDirectory(): boolean
  isFile?: () => boolean
  isSymbolicLink?: () => boolean
}

interface SftpLike {
  readFile(path: string, callback: (error: Error | undefined, data: Buffer) => void): void
  writeFile(path: string, data: Buffer | string, callback: (error: Error | undefined) => void): void
  realpath(path: string, callback: (error: Error | undefined, resolved: string) => void): void
  readdir(path: string, callback: (error: Error | undefined, list: ReadonlyArray<{ filename: string, longname?: string, attrs: SftpStats }>) => void): void
  stat(path: string, callback: (error: Error | undefined, stats: SftpStats) => void): void
  lstat(path: string, callback: (error: Error | undefined, stats: SftpStats) => void): void
  readlink(path: string, callback: (error: Error | undefined, target?: string) => void): void
  opendir(path: string, callback: (error: Error | undefined, handle?: Buffer) => void): void
  open(path: string, flags: string, callback: (error: Error | undefined, handle: Buffer) => void): void
  read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error: Error | undefined, bytesRead: number, buffer: Buffer, position: number) => void): void
  /**
   * ssh2 calls `callback(undefined, endOffset)` with the buffer index
   * `offset + length` once the request is accepted, not with a byte count.
   * A short write reports an `endOffset` strictly inside the request.
   */
  write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error: Error | undefined, endOffset: number) => void): void
  /** One-packet write budget from ssh2 (`_maxWriteLen`), when this session has it. */
  _maxWriteLen?: number
  close(handle: Buffer, callback: (error: Error | undefined) => void): void
  rename(oldPath: string, newPath: string, callback: (error: Error | undefined) => void): void
  /** OpenSSH's atomic POSIX rename extension, when the server offers it. */
  ext_openssh_rename?(oldPath: string, newPath: string, callback: (error: Error | undefined) => void): void
  /** `attrs` is optional in ssh2: `mkdir(path, callback)` sends an empty ATTRS. */
  mkdir(path: string, callback: (error: Error | undefined) => void): void
  end(callback?: () => void): void
  /** The underlying SFTP implementation is an EventEmitter; `error` and channel end matter here. */
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'end' | 'close', listener: () => void): void
}

function openSftp(client: Client, onFatal?: () => void): Promise<SftpSession> {
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
      // It also reports the fatal error so the pool can drop the dead session.
      api.on('error', () => { onFatal?.() })
      let resolveClosed: () => void = () => undefined
      const closed = new Promise<void>(resolve => { resolveClosed = resolve })
      api.on('end', resolveClosed)
      api.on('close', resolveClosed)
      resolve({
        api,
        closed,
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
function statInfo(sftp: SftpLike, remotePath: string): Promise<{ isDirectory: boolean, size: number, mode?: number, type?: SftpAttrs['type'] }> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) reject(failureOf(error, 'sftp-stat'))
      else resolve({
        isDirectory: stats.isDirectory(),
        size: stats.size,
        mode: typeof stats.mode === 'number' ? stats.mode : undefined,
        // Do not turn an absent permission field into `'other'`: callers must
        // know that the server did not answer the type question.
        type: typeof stats.mode === 'number' ? listingType(stats) : undefined,
      })
    })
  })
}

function statSize(sftp: SftpLike, remotePath: string): Promise<number> {
  return statInfo(sftp, remotePath).then(info => info.size)
}

function readAll(sftp: SftpLike, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(remotePath, (error, data) => {
      if (error) reject(failureOf(error, 'sftp-read'))
      else resolve(data)
    })
  })
}

/** Read a file, aborting as soon as more than `maxBytes` have arrived. */
async function readAllCapped(sftp: SftpLike, remotePath: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  let total = 0
  const parts: Buffer[] = []
  for await (const chunk of readOpenChunks(sftp, remotePath, signal)) {
    total += chunk.length
    if (total > maxBytes) throw new SshFailure(`file is over the ${maxBytes} byte limit`, 'sftp-read', undefined, true)
    parts.push(chunk)
  }
  return parts.length === 0 ? Buffer.alloc(0) : Buffer.concat(parts, total)
}

function writeAll(sftp: SftpLike, remotePath: string, body: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, body, error => {
      if (error) reject(failureOf(error, 'sftp-write'))
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
      if (error) reject(failureOf(error, 'sftp-mkdir'))
      else resolve()
    })
  })
}

function realpathOf(sftp: SftpLike, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (error, resolved) => {
      if (error) reject(failureOf(error, 'sftp-realpath'))
      else resolve(resolved)
    })
  })
}

/** `OPENDIR` plus `CLOSE`. A later `READDIR` would pull every name in a large directory. */
export async function probeOpenDir(sftp: SftpLike, remotePath: string): Promise<void> {
  const handle = await new Promise<Buffer>((resolve, reject) => {
    sftp.opendir(remotePath, (error, opened) => {
      if (error || opened === undefined) reject(error === undefined ? new SshFailure('sftp opendir failed', 'sftp-list') : failureOf(error, 'sftp-list'))
      else resolve(opened)
    })
  })
  await new Promise<void>(resolve => {
    sftp.close(handle, () => resolve())
  })
}

function readdir(sftp: SftpLike, remotePath: string): Promise<ReadonlyArray<{ filename: string, longname?: string, attrs: SftpStats }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) reject(failureOf(error, 'sftp-list'))
      else resolve(list)
    })
  })
}

const READ_CHUNK = 64 * 1024

/**
 * `ls -l` style longname. The first character is the type only when the next
 * letters look like permission bits. A longname that is just the filename
 * must not turn `data.txt` into a directory.
 */
const LONGNAME_KIND = /^([dlbcps-])[r-][w-][xsStT-]/

/** Entry type. A real mode wins. Without permissions, `longname` supplies d, -, or l. */
export function listingType(
  stats: { mode?: number, isDirectory(): boolean, isFile?: () => boolean, isSymbolicLink?: () => boolean },
  longname?: string,
): SftpAttrs['type'] {
  const link = typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()
  const file = typeof stats.isFile === 'function' && stats.isFile()
  const fromMode = link ? 'symlink' : stats.isDirectory() ? 'directory' : file ? 'file' : 'other'
  if (typeof stats.mode === 'number') return fromMode
  const mark = LONGNAME_KIND.exec(longname ?? '')?.[1]
  if (mark === 'd') return 'directory'
  if (mark === 'l') return 'symlink'
  if (mark === '-') return 'file'
  return fromMode
}

function attrsFrom(stats: SftpStats, longname?: string): SftpAttrs {
  return {
    type: listingType(stats, longname),
    size: stats.size,
    mtime: typeof stats.mtime === 'number' ? stats.mtime : 0,
    ...typeof stats.mode === 'number' ? { mode: stats.mode } : {},
  }
}

function readLinkOf(sftp: SftpLike, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.readlink(remotePath, (error, target) => {
      if (error) reject(failureOf(error, 'sftp-readlink'))
      else if (target === undefined) reject(new SshFailure('Response missing link info', 'sftp-readlink'))
      else resolve(target)
    })
  })
}

/** Whether a remote path is `root` or below it. */
function remotePathWithin(root: string, candidate: string): boolean {
  const rel = posix.relative(posix.normalize(root), posix.normalize(candidate))
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel))
}

/** Rename with the POSIX-overwrite extension first, then the standard request. */
async function renameRemote(sftp: SftpLike, fromPath: string, toPath: string): Promise<void> {
  const call = (method: 'ext' | 'standard'): Promise<void> => new Promise((resolve, reject) => {
    const done = (error: Error | undefined): void => {
      if (error) reject(failureOf(error, 'sftp-rename'))
      else resolve()
    }
    if (method === 'ext' && sftp.ext_openssh_rename !== undefined) sftp.ext_openssh_rename(fromPath, toPath, done)
    else sftp.rename(fromPath, toPath, done)
  })
  if (sftp.ext_openssh_rename === undefined) {
    await call('standard')
    return
  }
  try {
    await call('ext')
  } catch {
    // Some servers advertise the extension but reject it; standard rename is
    // still safe for a new temporary target and fails rather than truncating.
    await call('standard')
  }
}

async function attrsOf(sftp: SftpLike, remotePath: string, follow: boolean): Promise<SftpAttrs | undefined> {
  let stats: SftpStats
  try {
    stats = await new Promise<SftpStats>((resolve, reject) => {
      const finish = (error: Error | undefined, value?: SftpStats): void => {
        if (error) reject(error)
        else if (value === undefined) reject(new SshFailure('stat returned no attributes', follow ? 'sftp-stat' : 'sftp-lstat'))
        else resolve(value)
      }
      if (follow) sftp.stat(remotePath, finish)
      else sftp.lstat(remotePath, finish)
    })
  } catch (error) {
    if (isSftpMissing(error)) return undefined
    throw failureOf(error instanceof Error ? error : new Error(String(error)), follow ? 'sftp-stat' : 'sftp-lstat')
  }
  const info = attrsFrom(stats)
  if (info.mode !== undefined || info.type !== 'other') return info
  // Some SFTP servers omit SSH_FILEXFER_ATTR_PERMISSIONS. Distinguish the
  // types this code actually needs instead of reporting every path as
  // `other`: readlink proves a symlink, an OPENDIR probe proves a directory,
  // and an ordinary file is the remaining non-link, non-directory case.
  if (!follow) {
    try {
      await readLinkOf(sftp, remotePath)
      return { ...info, type: 'symlink' }
    } catch (error) {
      if (isSftpMissing(error) || isSftpPermissionDenied(error)) return info
      // A non-link readlink error is the expected "not a symlink" answer.
    }
  }
  try {
    await probeOpenDir(sftp, remotePath)
    return { ...info, type: 'directory' }
  } catch (error) {
    if (isSftpMissing(error) || isSftpPermissionDenied(error)) return info
    // Unknown type: leave it for the public `sftpAttrs` wrapper to classify
    // with the login shell. Never guess `file` here, or a FIFO can reach
    // `sftpRead` and block forever.
    return info
  }
}

function openRead(sftp: SftpLike, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, 'r', (error, handle) => {
      if (error || handle === undefined) reject(error === undefined ? new SshFailure('sftp open failed', 'sftp-read') : failureOf(error, 'sftp-read'))
      else resolve(handle)
    })
  })
}

function readAt(sftp: SftpLike, handle: Buffer, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  return new Promise((resolve, reject) => {
    sftp.read(handle, buf, 0, length, position, (error, bytesRead) => {
      if (error) reject(failureOf(error, 'sftp-read'))
      else resolve(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead))
    })
  })
}

function closeHandle(sftp: SftpLike, handle: Buffer): Promise<void> {
  return new Promise(resolve => {
    sftp.close(handle, () => resolve())
  })
}

/**
 * Read `[offset, offset + length)`. Length 0 does not open the file.
 * SFTP may return fewer bytes than requested before EOF. Only a zero-length
 * read ends the window; a short reply is continued from the next offset.
 */
export async function readOpenRange(sftp: SftpLike, remotePath: string, offset: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new SshFailure('read range is not a non-negative safe integer', 'sftp-read')
  }
  if (length === 0) return Buffer.alloc(0)
  const handle = await openRead(sftp, remotePath)
  try {
    const parts: Buffer[] = []
    let got = 0
    while (got < length) {
      const chunk = await readAt(sftp, handle, offset + got, length - got)
      if (chunk.length === 0) break
      parts.push(chunk)
      got += chunk.length
    }
    if (parts.length === 0) return Buffer.alloc(0)
    const only = parts[0]
    if (parts.length === 1 && only !== undefined) return only
    return Buffer.concat(parts, got)
  } finally {
    await closeHandle(sftp, handle)
  }
}

const WRITE_CHUNK = READ_CHUNK
/** How many bytes may sit in unanswered SFTP writes. The transfer deadline still applies. */
const WRITE_BUDGET = 1024 * 1024
/** Hard cap on the number of concurrent SFTP write requests, independent of their size. */
const MAX_INFLIGHT_WRITES = 32

/** One packet when ssh2 advertises it, otherwise a 64 KiB window that fits a non-OpenSSH packet split. */
function writeChunkBytes(sftp: SftpLike): number {
  const packet = sftp._maxWriteLen
  if (typeof packet !== 'number' || !Number.isSafeInteger(packet) || packet < 8 * 1024) return WRITE_CHUNK
  return Math.min(packet, 256 * 1024)
}

function openWrite(sftp: SftpLike, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, 'w', (error, handle) => {
      if (error || handle === undefined) reject(error === undefined ? new SshFailure('sftp open failed', 'sftp-write') : failureOf(error, 'sftp-write'))
      else resolve(handle)
    })
  })
}

/**
 * Write `data` at `position`.
 *
 * The callback's second value is an end index in `data` (`offset + length`
 * when ssh2 finishes the request). A smaller index is a short write and is
 * continued from that index. A missing index means the request finished
 * without one. An index that does not advance is a fault: treating it as
 * success would drop bytes, and retrying it would spin.
 */
function writeAt(sftp: SftpLike, handle: Buffer, data: Buffer, position: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const step = (offset: number): void => {
      const length = data.length - offset
      sftp.write(handle, data, offset, length, position + offset, (error, endOffset) => {
        if (error) {
          reject(failureOf(error, 'sftp-write'))
          return
        }
        if (typeof endOffset !== 'number') {
          resolve()
          return
        }
        if (endOffset <= offset) {
          reject(new SshFailure('sftp write made no progress', 'sftp-write'))
          return
        }
        if (endOffset >= offset + length) resolve()
        else step(endOffset)
      })
    }
    step(0)
  })
}

/**
 * Run `work` until it finishes or `signal` aborts.
 *
 * On failure, `beforeCleanup` tears down the channel that owns the transfer's
 * OPEN/WRITE and waits for the server to confirm its close. It runs *always*,
 * not only when `work` proves stuck: an abort can settle the work promptly
 * while the server-side sftp-server is still processing an OPEN that was
 * already on the wire. `cleanup()` (the `rm`) runs on a different exec channel
 * and must never precede that confirmation. Both steps have their own
 * `CLEANUP_SETTLE_TIMEOUT_MS` bound, so a dead channel cannot hang the tool
 * call forever; a hung `work` only gets the short cooperative window first.
 */
export async function finishOrCleanup<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  cleanup: () => Promise<void>,
  beforeCleanup?: () => void | boolean | Promise<void | boolean>,
): Promise<T> {
  try {
    return await raceAbort(work, signal)
  } catch (error) {
    const deadline = Date.now() + CLEANUP_SETTLE_TIMEOUT_MS
    const remaining = (): number => Math.max(250, deadline - Date.now())
    // Give a signal-aware transfer its short window to answer the abort before
    // the channel is ended. A callback still stuck after it is not awaited:
    // `session.end()` makes the server reject the pending requests.
    await settleWithin(work, COOPERATIVE_SETTLE_MS)
    if (beforeCleanup !== undefined) {
      const confirmed = await settleConfirmed(Promise.resolve().then(beforeCleanup), remaining())
      // Without the server's channel-close confirmation an `rm` can race a
      // late OPEN. Skip it and let the caller report the possible temp path.
      if (!confirmed) throw error
    }
    await settleWithin(cleanup(), remaining())
    throw error
  }
}

/**
 * Settle with `work`, or with an abort when `signal` fires first.
 *
 * The loser is observed so a write that finishes after the deadline does not
 * become an unhandled rejection. Cleanup belongs in {@link finishOrCleanup}:
 * this only decides which error the caller sees.
 */
function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) {
    work.catch(() => undefined)
    return Promise.reject(abortError())
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      settle()
    }
    const onAbort = (): void => {
      work.catch(() => undefined)
      finish(() => reject(abortError()))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    work.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

export interface StreamChunksOptions {
  /** Byte ceiling; `0` means the operator chose no ceiling. */
  maxBytes?: number
  signal?: AbortSignal
  /**
   * Subject of the ceiling message. A local upload reads "local file"; a
   * copy between hosts names the source side instead.
   */
  overflowLabel?: string
}

/**
 * Write an async chunk sequence onto a remote path.
 *
 * Several chunks are in flight, bounded by {@link WRITE_BUDGET} bytes and
 * {@link MAX_INFLIGHT_WRITES} requests. `maxBytes` of `0` does not stop the
 * copy; the transfer deadline still does. A source that grows past a positive
 * ceiling is rejected on the bytes actually written.
 *
 * The source owns the buffers it yields: it must not reuse a buffer for a
 * later chunk, because several writes are in flight at once. Stopping before
 * the source ends closes it through `return()`, so a generator holding an open
 * handle (SFTP or local) releases it even when the target side fails first.
 */
export async function streamChunksToSftp(
  sftp: SftpLike,
  remotePath: string,
  source: AsyncIterable<Buffer>,
  options: StreamChunksOptions = {},
): Promise<number> {
  const maxBytes = options.maxBytes ?? 0
  const signal = options.signal
  const label = options.overflowLabel ?? 'local file'
  if (signal?.aborted) throw abortError()
  const inflight: Promise<void>[] = []
  let inflightBytes = 0
  let failure: unknown
  const track = (job: Promise<void>, bytes: number): void => {
    inflightBytes += bytes
    const tracked = job.then(() => undefined, (error: unknown) => {
      if (failure === undefined) failure = error
    }).finally(() => {
      inflightBytes -= bytes
      const index = inflight.indexOf(tracked)
      if (index >= 0) inflight.splice(index, 1)
    })
    inflight.push(tracked)
  }
  const drainFailure = async (): Promise<never> => {
    const pending = inflight.splice(0)
    // A sibling write may have failed while another callback never returns;
    // never inherit that unbounded wait on the failure path.
    await settleWithin(Promise.all(pending))
    throw failure
  }
  const consume = async (all: boolean, nextBytes = 0): Promise<void> => {
    // A write can reject and remove itself from `inflight` before the loop
    // below notices; check the recorded failure even when the set is empty.
    if (failure !== undefined) await drainFailure()
    while (inflight.length > 0 && (all || inflight.length >= MAX_INFLIGHT_WRITES || inflightBytes + nextBytes > WRITE_BUDGET)) {
      await Promise.race(inflight)
      if (failure !== undefined) await drainFailure()
      if (!all && inflight.length < MAX_INFLIGHT_WRITES && inflightBytes + nextBytes <= WRITE_BUDGET) return
    }
    if (failure !== undefined) await drainFailure()
  }
  const iterator = source[Symbol.asyncIterator]()
  let remote: Buffer | undefined
  let finished = false
  let position = 0
  try {
    const opening = openWrite(sftp, remotePath)
    try {
      remote = await raceAbort(opening, signal)
    } catch (error) {
      // An abort can win while `open` is still in flight. Wait briefly for the
      // late handle so it can be closed. The barrier against a late `OPEN`
      // recreating the temp file is the caller's lease close, which waits for
      // the server's channel close on the full cleanup budget before `rm`.
      if (signal?.aborted === true) {
        await settleWithin(opening.then(value => closeHandle(sftp, value)), COOPERATIVE_SETTLE_MS)
      }
      throw error
    }
    while (true) {
      if (failure !== undefined) await drainFailure()
      if (signal?.aborted) {
        await settleWithin(Promise.all(inflight.splice(0)))
        throw abortError()
      }
      const step = await raceAbort(iterator.next(), signal)
      if (step.done === true) {
        finished = true
        break
      }
      const data = step.value
      if (data.length === 0) {
        if (failure !== undefined) await drainFailure()
        continue
      }
      // Wait for room before this chunk joins the in-flight set. Counting
      // chunks instead of bytes made a cross-host copy on a small-packet
      // target hold 2 MiB while a local upload held 256 KiB.
      await consume(false, data.length)
      position += data.length
      if (maxBytes > 0 && position > maxBytes) {
        await consume(true)
        throw new SshFailure(`${label} is over the ${maxBytes} byte transfer ceiling`, 'sftp-write', undefined, true)
      }
      track(raceAbort(writeAt(sftp, remote, data, position - data.length), signal), data.length)
    }
    await consume(true)
    return position
  } finally {
    // A hung `close` callback must not hide the transfer result or turn an
    // aborted transfer into an unbounded cleanup. The signal race returns
    // immediately on abort; the bound covers a dead channel with no signal.
    if (remote !== undefined) await settleWithin(raceAbort(closeHandle(sftp, remote), signal), COOPERATIVE_SETTLE_MS)
    // Reaching the end already closed the source. Anything else — a ceiling,
    // an abort, a failed write — has to close it from here.
    if (!finished && typeof iterator.return === 'function') {
      await settleWithin(raceAbort(Promise.resolve().then(() => iterator.return!()), signal), COOPERATIVE_SETTLE_MS)
    }
  }
}

/** Chunks from one open local file. The generator owns each buffer it yields. */
async function* localChunks(local: FileHandle, chunkBytes: number, signal: AbortSignal | undefined): AsyncGenerator<Buffer> {
  const chunk = Buffer.alloc(chunkBytes)
  while (true) {
    if (signal?.aborted) throw abortError()
    const { bytesRead } = await local.read(chunk, 0, chunk.length, null)
    if (bytesRead === 0) return
    // The reusable read buffer cannot go out: several writes are in flight.
    yield Buffer.from(chunk.subarray(0, bytesRead))
  }
}

/**
 * Copy a local file onto a remote path.
 *
 * The file is opened without following a symlink and without blocking on a
 * FIFO swapped in after the caller's `lstat`; the fstat then refuses anything
 * that is no longer a regular file. The write itself is
 * {@link streamChunksToSftp}.
 */
export async function streamLocalToSftp(
  sftp: SftpLike,
  localPath: string,
  remotePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<number> {
  if (signal?.aborted) throw abortError()
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW
  const nonBlock = fsConstants.O_NONBLOCK ?? 0
  const local = await open(localPath, fsConstants.O_RDONLY | nonBlock | noFollow)
  try {
    const info = await local.stat()
    if (!info.isFile()) throw new Error(`local path is not a regular file: ${localPath}`)
    if (signal?.aborted) throw abortError()
    return await streamChunksToSftp(sftp, remotePath, localChunks(local, writeChunkBytes(sftp), signal), { maxBytes, signal })
  } finally {
    await settleWithin(raceAbort(local.close().catch(() => undefined), signal))
  }
}

/** Sequential windows from one handle. A short read ends the file. */
export async function* readOpenChunks(sftp: SftpLike, remotePath: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const opening = openRead(sftp, remotePath)
  let handle: Buffer
  try {
    handle = await raceAbort(opening, signal)
  } catch (error) {
    // An abort can win while `open` is still in flight. Wait briefly for the
    // late handle and close it, so an aborted download does not leak it.
    if (signal?.aborted === true) {
      await settleWithin(opening.then(value => closeHandle(sftp, value)), COOPERATIVE_SETTLE_MS)
    }
    throw error
  }
  try {
    let position = 0
    while (true) {
      if (signal?.aborted) throw new SshFailure('sftp read aborted', 'sftp-read')
      const chunk = await raceAbort(readAt(sftp, handle, position, READ_CHUNK), signal)
      if (chunk.length === 0) return
      position += chunk.length
      yield chunk
    }
  } finally {
    await settleWithin(closeHandle(sftp, handle))
  }
}
