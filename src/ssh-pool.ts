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

/**
 * How long one channel-open may wait for the server's confirmation.
 *
 * A silently dead link (VPN switch, suspended laptop, expired NAT mapping) sends
 * no FIN and no RST: the socket stays ESTABLISHED, `client.exec` never calls
 * back, and the only other signal is SSH keepalive at
 * `KEEPALIVE_DETECTION_MS` (30 s with the shipped keepalive settings) — a
 * noticeable pause for a tool call that otherwise looks hung. Answering
 * CHANNEL_OPEN_CONFIRMATION is one round trip plus the server's own scheduling,
 * so ten seconds means the connection is gone rather than slow. Firing here
 * drops the connection so the next attempt dials a fresh one instead of reusing
 * a dead socket.
 */
export const CHANNEL_OPEN_TIMEOUT_MS = 10_000

/**
 * The window {@link openWatchdog} actually uses.
 *
 * Tests cannot wait ten seconds per case, so they shorten it here. Production
 * code never assigns to it: the constant above is the shipped value.
 */
let channelOpenWindowMs = CHANNEL_OPEN_TIMEOUT_MS

/** Shorten the channel-open window for one test, returning the previous value. */
export function setChannelOpenWindowForTest(ms: number): () => void {
  const previous = channelOpenWindowMs
  channelOpenWindowMs = ms > 0 ? ms : CHANNEL_OPEN_TIMEOUT_MS
  return () => { channelOpenWindowMs = previous }
}

/**
 * How long a caller may wait for a connection slot when it supplied no deadline.
 *
 * A slot is released only when its connection closes, and a pooled connection
 * stays open until the plugin unloads. With the default `maxConnections` of 4, a
 * fifth host would otherwise wait forever: the queue had no timer at all, so
 * `timeoutMs` on the tool call was ignored and the tool call never returned.
 * This is a backstop for callers that ask for no deadline of their own; a caller
 * that does supply one is bounded by that instead.
 */
export const DEFAULT_SLOT_WAIT_TIMEOUT_MS = 60_000

/**
 * The backstop {@link SshPool} actually applies to a caller that supplied no
 * deadline. Tests shorten it; production code never assigns to it.
 */
let slotWaitBackstopMs = DEFAULT_SLOT_WAIT_TIMEOUT_MS

/** Shorten the slot-wait backstop for one test, returning the previous value. */
export function setSlotWaitForTest(ms: number): () => void {
  const previous = slotWaitBackstopMs
  slotWaitBackstopMs = ms > 0 ? ms : DEFAULT_SLOT_WAIT_TIMEOUT_MS
  return () => { slotWaitBackstopMs = previous }
}

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

/**
 * Time one channel open and report whether the server ever confirmed it.
 *
 * The window starts immediately; `settle()` cancels it once the server answers.
 * If it elapses first, the callback runs with how long it waited and the caller
 * treats the connection as dead.
 *
 * This is the only signal a silently dead link gives: the socket stays
 * ESTABLISHED and ssh2's callback is simply never invoked, so without this the
 * failure surfaces only when the command's own timeout fires — one dead link
 * turned into a full timeout for every command, with no reconnect between them.
 *
 * The window is deliberately NOT shortened to a caller's own timeout. A healthy
 * server that takes 80 ms to confirm would be called dead by a 50 ms command,
 * and the verdict drops the shared connection every other channel on the host
 * depends on.
 */
function openWatchdog(callback: (waitedMs: number) => void): { settle(): void } {
  const started = Date.now()
  const timer = setTimeout(() => {
    callback(Date.now() - started)
  }, channelOpenWindowMs)
  // The window is a per-call guard, not a reason to keep the process alive.
  timer.unref?.()
  return {
    settle: () => clearTimeout(timer),
  }
}

/**
 * Milliseconds left of one absolute budget.
 *
 * `deadline` undefined means the caller set none; `fallbackMs` is then passed
 * through unchanged, and `0` stays `0` ("no deadline"). An elapsed budget
 * returns the smallest positive delay instead of a negative one, so a stage
 * that is already out of time still schedules its timer and settles at once
 * rather than firing immediately with a confusing 1 ms reading.
 */
export function remainingBudget(deadline: number | undefined, fallbackMs: number): number {
  if (deadline === undefined) return fallbackMs
  return Math.max(1, deadline - Date.now())
}

/**
 * How long one SFTP request may wait for the server's reply.
 *
 * The channel is cached per connection, so the channel-open watchdog covers
 * only the first use of a host. A link that dies afterwards leaves every later
 * request hanging until SSH keepalive gives up (`KEEPALIVE_DETECTION_MS`, 30 s),
 * which is what made `read`, the file tree and the directory picker look frozen
 * while the connection was already gone.
 *
 * A metadata request is one round trip. Ten seconds is generous for that and
 * still an order of magnitude better than keepalive; a transfer's own bytes are
 * bounded separately by the transfer deadline, so this must not be applied to
 * them.
 */
export const SFTP_REQUEST_TIMEOUT_MS = 10_000

/**
 * The window {@link boundedSftpRequest} actually uses. Tests shorten it so a
 * case covering every cached-channel operation does not spend a minute of
 * wall-clock waiting for the ceiling it is asserting.
 */
let sftpRequestWindowMs = SFTP_REQUEST_TIMEOUT_MS

/** Shorten the per-request window for one test, returning the previous value. */
export function setSftpRequestWindowForTest(ms: number): () => void {
  const previous = sftpRequestWindowMs
  sftpRequestWindowMs = ms > 0 ? ms : SFTP_REQUEST_TIMEOUT_MS
  return () => { sftpRequestWindowMs = previous }
}

/**
 * Bound one SFTP request, reporting a dead link rather than a slow server.
 *
 * The underlying request cannot be cancelled (SFTP v3 has no cancellation), so
 * the caller returns while the reply is simply dropped. The connection is left
 * alone here: only the channel-open watchdog decides that a link is dead, and
 * this request timing out is one caller's budget, not proof about the host.
 */
function boundedSftpRequest<T>(work: Promise<T>, stage: string, timeoutMs = sftpRequestWindowMs): Promise<T> {
  // `0` means "no ceiling here": the caller bounded this work some other way
  // (its own abort signal, or a transfer deadline).
  if (!(timeoutMs > 0)) {
    work.catch(() => undefined)
    return work
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SshFailure(
        `the SFTP request did not answer within ${timeoutMs} ms; the connection may be dead`,
        stage,
      ))
    }, Math.min(timeoutMs, 2 ** 31 - 1))
    timer.unref?.()
  })
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
    // The losing request keeps running; observe its rejection so a late failure
    // cannot become an unhandled rejection.
    work.catch(() => undefined)
  })
}

/** How a host is named in a pool error: its configured name, or its address. */
function hostLabel(host: HostConfig): string {
  const name = host.name.trim()
  return name.length > 0 ? name : host.host
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

/**
 * SSH-level keepalive for connections that stay open for hours.
 *
 * ssh2 does not report a dead link at `interval × countMax`: it pings on every
 * interval and only gives up when the count of unanswered pings EXCEEDS
 * `keepaliveCountMax`, so the window is `interval × (keepaliveCountMax + 1)`.
 *
 * The shipped values are 10 s and 2, which gives 10 × 3 = 30 s. Both numbers
 * matter: shortening the interval reaches 30 s without dropping to a count of
 * 1, which would let a single lost keepalive reply (a brief blip, a busy
 * server) tear down a healthy connection. The cost is one ~50-byte ping per
 * 10 s, about 422 KiB/day per connection.
 *
 * Kept in one place because a comment that computes this by hand has already
 * been wrong twice: `countMax = 2` at 15 s is 45 s, not 30 s.
 */
export const SSH_KEEPALIVE_INTERVAL_MS = 10_000

/** Unanswered keepalives before ssh2 drops the connection (its default is 3). */
export const SSH_KEEPALIVE_COUNT_MAX = 2

/**
 * How long ssh2 tolerates a silent peer: `interval × (countMax + 1)`.
 *
 * Derived rather than written out, so a change to either constant cannot leave
 * a stale number in the docs or in an error message.
 */
export const KEEPALIVE_DETECTION_MS = SSH_KEEPALIVE_INTERVAL_MS * (SSH_KEEPALIVE_COUNT_MAX + 1)

export function sshConnectOptions(host: HostConfig): ConnectConfig {
  return {
    host: host.host,
    port: host.port,
    username: host.username,
    readyTimeout: 20_000,
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
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
    /**
     * The connection this attempt used is believed dead, so a retry on a fresh
     * one is worth attempting.
     *
     * "Unconfirmed" is the precise claim, not "never received": a silently dead
     * link makes `client.exec` never call back, but the server may have accepted
     * the channel-open packet before the link died. A replay is therefore only
     * safe for a command that can run twice — the same trade the pre-existing
     * "No response from server" retry made. Callers must not read this flag as
     * proof that the remote did nothing.
     *
     * It is deliberately separate from the message text:
     * `isRetryableOpenFailure` used to match English wording, and a localised or
     * rephrased message would have silently stopped replaying.
     */
    readonly connectionDead?: boolean,
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
 * reports it as "No response from server", or the open watchdog gave up on a
 * link that never answered. The remote never ran the command, so replaying it
 * on a fresh connection is safe.
 *
 * `connectionDead` is checked first: it is set by the code that detected the
 * dead link, so a localised or rephrased message cannot turn a replayable
 * failure into a hard one.
 */
export function isRetryableOpenFailure(error: unknown): boolean {
  if (!(error instanceof SshFailure) || error.stage !== 'exec') return false
  if (error.connectionDead === true) return true
  return /no response from server|not connected|connection lost/i.test(error.message)
}

/**
 * Describe a failed replay as what it is: a dead link plus an unusable retry.
 *
 * The retry's own error is usually a plain connect failure ("did not become
 * ready within N ms"), which on its own reads like the FIRST attempt was slow.
 * The caller already knows the first attempt was judged dead, so the combined
 * message has to carry both facts, and it must stay marked `connectionDead` so
 * a caller can classify it as a network fault rather than a command timeout.
 */
function replayFailure(first: unknown, retry: unknown): SshFailure {
  const firstText = first instanceof Error ? first.message : String(first)
  const retryText = retry instanceof Error ? retry.message : String(retry)
  // The first attempt was already judged dead (that is why we replayed), so the
  // combined failure is always a dead-link failure.
  return new SshFailure(
    `the SSH connection was judged dead (${firstText}); reconnecting and replaying also failed (${retryText})`,
    'connect',
    undefined,
    undefined,
    true,
  )
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
 * before the opening settles, `controller` aborts so `openLive` stops the
 * handshake and releases its slot immediately: without it an abandoned opening
 * kept a slot for ssh2's whole `readyTimeout` (20 s), and every other host
 * waited in the queue for a connection nobody wanted.
 */
interface OpeningState {
  waiters: number
  settled: boolean
  /** Aborts this opening once its last caller has left. */
  controller: AbortController
  /**
   * Set once this opening has taken a concurrency slot.
   *
   * A caller's deadline bounds this whole wait (queue *and* handshake) — see
   * {@link SshPool.boundQueueWait}. The flag only decides which of the two
   * failure messages applies, since "no slot" and "no handshake" need
   * different advice.
   */
  reserved: boolean
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
    const channel = await execPty(live.client, request, () => {
      live.markDead()
      void closeLive(live)
    }, request.signal)
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
    // One absolute deadline for the whole call: queue, handshake, channel open
    // and the replay below all draw from the same budget. Charging any stage a
    // fresh `timeoutMs` is what let a 300 ms command return after 453 ms.
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined
    const commandHandle = await this.open(host, secret, command, timeoutMs, signal, stdin, onOutput, deadline)
    try {
      return await commandHandle.done
    } catch (error) {
      // The channel never opened, so the remote may never have run anything:
      // ssh2 fails the open request without the server accepting it. Drop the
      // dead session first, then open again on a fresh connection — the next
      // command would otherwise keep hitting the same stale socket.
      //
      // A replay cannot be proven safe for every command. `connectionDead` says
      // the request was not confirmed, not that the server never saw it: a
      // server may have accepted the packet before the link died. Replaying is
      // only sound for a command the operator can run twice, and that is the
      // same trade the pre-existing "No response from server" retry made.
      if (signal?.aborted === true || !isRetryableOpenFailure(error)) throw error
      if (deadline !== undefined && Date.now() >= deadline) throw error
      // `dropSession` takes real time on a stuck socket, so re-derive the
      // budget after it instead of charging the retry the pre-drop remainder.
      await this.dropSession(host.id)
      if (deadline !== undefined && Date.now() >= deadline) throw error
      try {
        const retried = await this.open(host, secret, command, timeoutMs, signal, stdin, onOutput, deadline)
        return await retried.done
      } catch (retryError) {
        // A retry that never got a connection would otherwise surface as
        // "did not become ready within 18000 ms", which reads like a handshake
        // that was slow from the start. It was not: the first connection was
        // already judged dead and this one never came up. Say so, and keep the
        // dead-link marker so callers can tell a network fault from a timeout.
        throw replayFailure(error, retryError)
      }
    }
  }

  /**
   * `timeoutMs` of 0 waits until the command exits, the signal aborts, or
   * `close` kills its channel.
   *
   * `deadline` is an absolute epoch-millisecond budget shared with the caller's
   * other stages (`exec`'s replay). Every stage below draws from it: the queue
   * wait, ssh2's handshake, the channel-open watchdog and the command timer.
   * Without it each stage restarted a full `timeoutMs`, so the parts summed to
   * more than the caller asked for.
   */
  async open(
    host: HostConfig,
    secret: SecretMaterial,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
    stdin?: string | Buffer,
    onOutput?: (chunk: CommandChunk) => void,
    deadline?: number,
  ): Promise<RemoteCommand> {
    // The caller's own deadline also bounds the queue wait: a command that can
    // only run for `timeoutMs` must not spend longer than that behind a full
    // pool. `0` means no deadline of its own, so the pool's backstop applies.
    const live = await this.acquire(host, secret, true, signal, timeoutMs, deadline)
    // Everything the caller already spent (queue, handshake) comes off the
    // command's own budget before the channel is opened.
    const commandTimeoutMs = remainingBudget(deadline, timeoutMs)
    // A link that never answers the channel-open is dead, not slow: drop the
    // pooled connection so `exec` replays this command on a fresh one instead of
    // leaving every later command to burn its own timeout on the same socket.
    const commandHandle = openChannel(
      live.client,
      command,
      commandTimeoutMs,
      stdin,
      onOutput,
      () => {
        live.markDead()
        void closeLive(live)
      },
    )
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
      const watchdog = openWatchdog(waitedMs => {
        if (settled || stream !== undefined) return
        settled = true
        if (closeTimer !== undefined) clearTimeout(closeTimer)
        stdout.end()
        stderr.end()
        live.markDead()
        void closeLive(live)
        rejectDone(new SshFailure(
          `the SSH connection did not answer the channel-open request within ${waitedMs} ms; the link is probably dead`,
          'exec',
          undefined,
          undefined,
          true,
        ))
      })
      live.client.exec(command, (error, opened) => {
        watchdog.settle()
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
    // A whole-file read is the `read` tool's main path, and the SFTP channel is
    // cached, so nothing else bounds it once the link dies: it would wait for
    // keepalive (60 s) and report nothing useful.
    //
    // A caller's `signal` is not a deadline — the `read` tool passes one that
    // only fires on cancel — so the request bound applies either way.
    if (maxBytes !== undefined) {
      const size = await boundedSftpRequest(statSize(session, remotePath), 'sftp-read')
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
    return boundedSftpRequest(readAll(session, remotePath), 'sftp-read')
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
    const session = await openSftp(live.client, undefined, () => {
      live.markDead()
      void closeLive(live)
    }, signal)
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
    await boundedSftpRequest(writeAll(session, remotePath, body), 'sftp-write')
  }

  async sftpRename(host: HostConfig, secret: SecretMaterial, fromPath: string, toPath: string): Promise<void> {
    const session = await this.sftp(host, secret)
    await boundedSftpRequest(renameRemote(session, fromPath, toPath), 'sftp-rename')
  }

  async sftpRealpath(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string> {
    const session = await this.sftp(host, secret)
    return boundedSftpRequest(realpathOf(session, remotePath), 'sftp-realpath')
  }

  async sftpStat(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<{ isDirectory: boolean, size: number, mode?: number, type?: SftpAttrs['type'] }> {
    const session = await this.sftp(host, secret)
    return boundedSftpRequest(statInfo(session, remotePath), 'sftp-stat')
  }

  async sftpList(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<DirEntry[]> {
    const session = await this.sftp(host, secret)
    const rows = await boundedSftpRequest(readdir(session, remotePath), 'sftp-list')
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
    await boundedSftpRequest(makeDirectory(session, remotePath), 'sftp-mkdir')
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
      opening = openSftp(
        live.client,
        () => { if (live.sftp === opening) live.sftp = undefined },
        // A dead link is not a protocol fault: the whole connection is gone, so
        // dropping only the SFTP channel would leave the next call to wait on
        // the same dead socket again.
        () => {
          if (live.sftp === opening) live.sftp = undefined
          live.markDead()
          void closeLive(live)
        },
        signal,
      ).catch(error => {
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
    return boundedSftpRequest(readLinkOf(session, remotePath), 'sftp-readlink')
  }

  /**
   * Whether `remotePath` can be opened as a directory. The names are not read:
   * a mode-less `stat` only needs the open to succeed.
   */
  async sftpProbeDir(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<void> {
    const session = await this.sftp(host, secret)
    await boundedSftpRequest(probeOpenDir(session, remotePath), 'sftp-list')
  }

  /** Files and directories. The settings picker uses {@link sftpList}, which drops files. */
  async sftpReadDir(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<RemoteDirEntry[]> {
    const session = await this.sftp(host, secret)
    const rows = await boundedSftpRequest(readdir(session, remotePath), 'sftp-list')
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
    return boundedSftpRequest(readOpenRange(session, remotePath, offset, length), 'sftp-read')
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
  private acquire(host: HostConfig, secret: SecretMaterial, requireTrust: boolean, signal?: AbortSignal, queueWaitMs?: number, deadline?: number): Promise<Live> {
    if (this.disposed) return Promise.reject(new SshFailure('SSH pool is disposed', 'connect'))
    let state = this.openings.get(host.id)
    // An aborted opening is dead on arrival: `leave()` aborts it when its last
    // caller gives up, but the entry is only removed once the opening settles
    // (`forgetOpening` needs `settled`). A caller arriving in that window would
    // otherwise join a cancelled connect and fail for no reason of its own.
    //
    // The cached promise has to go too: `claimPending` keys it by host id, so
    // leaving it would hand the next caller that same rejected flight.
    if (state !== undefined && state.controller.signal.aborted) {
      state = undefined
      this.live.delete(host.id)
    }
    if (state === undefined) {
      state = { waiters: 0, settled: false, controller: new AbortController(), reserved: false }
      this.openings.set(host.id, state)
    }
    const joined = state
    joined.waiters += 1
    // One departure per caller, whichever comes first: the shared opening
    // settling, this caller aborting, or its queue deadline firing. The count
    // is what tells `openLive` whether anybody still wants the connection, so
    // a caller that gave up must leave it here — decrementing only when the
    // shared promise settles would keep a waiting count alive after the tool
    // call already returned, and the slot, once freed, would dial for nobody.
    let left = false
    const leave = (): void => {
      if (left) return
      left = true
      joined.waiters -= 1
      if (joined.waiters > 0) return
      // Nobody is waiting any more, so an in-flight handshake must end now. It
      // would otherwise hold its slot for ssh2's full `readyTimeout` and starve
      // every other host in a small pool.
      if (!joined.controller.signal.aborted) joined.controller.abort()
      this.forgetOpening(host.id, joined)
    }
    const opening = claimPending(this.live, host.id, () => this.openLive(host, secret, requireTrust, joined))
    void opening.then(
      () => { joined.settled = true; this.forgetOpening(host.id, joined) },
      () => { joined.settled = true; this.forgetOpening(host.id, joined) },
    )
    const shared = detachOnAbort(opening, signal).finally(leave)
    return this.boundQueueWait(shared, joined, host, queueWaitMs, leave, deadline)
  }

  /**
   * Stop waiting for a usable connection once this caller's budget elapses.
   *
   * The bound covers the whole wait, not only the queue: a slot taken on a dead
   * network still has to complete a handshake, and ssh2's own `readyTimeout` is
   * a fixed 20 s that knows nothing about the tool call. Bounding only the queue
   * left a 3 s command returning after 30 s.
   *
   * The queue has no other deadline: a slot returns only when its connection
   * closes, and a pooled connection outlives every command, so a caller behind a
   * full pool would wait until the plugin unloads. That is the hang the model saw
   * as "the remote takes forever to connect". A caller that set no deadline of
   * its own is bounded by {@link slotWaitBackstopMs}.
   *
   * Only this caller detaches. The shared opening keeps its queue position for
   * the other callers on the host, and when the last one leaves the opening is
   * cancelled and the slot released instead of dialing for nobody
   * (`openLive` re-checks the waiter count and aborts its own connect).
   */
  private boundQueueWait(
    work: Promise<Live>,
    state: OpeningState,
    host: HostConfig,
    limit: number | undefined,
    leave: () => void,
    deadline?: number,
  ): Promise<Live> {
    const fallback = limit !== undefined && limit > 0 ? limit : slotWaitBackstopMs
    if (!(fallback > 0)) return work
    const bound = deadline === undefined ? fallback : remainingBudget(deadline, fallback)
    return new Promise<Live>((resolve, reject) => {
      let settled = false
      const finish = (settle: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        settle()
      }
      const timer = setTimeout(() => {
        if (settled) return
        work.catch(() => undefined)
        leave()
        // Which stage ran out decides the message: still queued is a slot
        // problem, past the queue is a slow or dead handshake. Both are the
        // caller's own deadline, so both must end the call. Neither tears the
        // shared connection down: a call that gave up is not evidence that the
        // link is dead.
        finish(() => reject(state.reserved
          ? new SshFailure(
            `the SSH connection to ${hostLabel(host)} did not become ready within ${bound} ms`,
            'connect',
          )
          : new SshFailure(
            `no free SSH connection slot for ${hostLabel(host)} within ${bound} ms: `
            + `${this.maxConnections} connection${this.maxConnections === 1 ? '' : 's'} are held by this host or other hosts and a slot returns only when its connection closes. `
            + 'Close a sidebar terminal, or raise maxConnections in the plugin config',
            'slots',
          )))
      }, Math.min(bound, 2 ** 31 - 1))
      // The wait is bounded per caller, not meant to keep the process alive.
      timer.unref?.()
      work.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      )
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
      // The slot is held now, so a caller's queue deadline must stop applying:
      // from here the connect is bounded by ssh2's `readyTimeout`, and a short
      // command's own timeout must not decide whether a slow link may dial.
      state.reserved = true
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
        }, state.controller.signal)
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

function connect(host: HostConfig, secret: SecretMaterial, accept: (key: Buffer) => boolean, signal?: AbortSignal): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const detach = (): void => { signal?.removeEventListener('abort', onAbort) }
    const fail = (error: unknown) => {
      detach()
      client.end()
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new SshFailure(String(error), 'connect'))
    }
    // Every caller for this host gave up. Stopping the handshake here is what
    // returns the slot immediately; waiting for ssh2's `readyTimeout` (20 s)
    // would keep it reserved for a connection nobody is waiting on.
    const onAbort = (): void => {
      fail(abortError())
    }
    if (signal?.aborted === true) {
      fail(abortError())
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    client.once('ready', () => {
      // Nagle's algorithm plus the peer's delayed ACK turns every unanswered
      // SFTP request into a ~40 ms stall: measured here on a loopback host,
      // one serial 64 KiB READ took 45 ms (1.4 MiB/s) with batching on and
      // 1.5 ms (43 MiB/s) with it off. ssh2 never calls `setNoDelay` itself,
      // and it must happen after the socket exists but before the first
      // request, so the handshake is the only place for it.
      detach()
      if (settled) {
        // The last caller left while the handshake was finishing; nobody owns
        // this connection.
        client.end()
        return
      }
      settled = true
      client.setNoDelay(true)
      resolve(client)
    })
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
        if (settled) return
        client.connect(options)
      }).catch(fail)
      return
    }
    if (settled) return
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

function execPty(client: Client, request: PtyRequest, onDeadLink?: () => void, signal?: AbortSignal): Promise<PtyChannel> {
  return new Promise((resolve, reject) => {
    let settled = false
    let watchdog: { settle(): void } | undefined
    const detach = (): void => { signal?.removeEventListener('abort', onAbort) }
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      watchdog?.settle()
      detach()
      return true
    }
    // Cancelling before the server confirms must not leave the caller waiting
    // for the watchdog window: a closed terminal tab should return at once.
    const onAbort = (): void => {
      if (!settle()) return
      reject(new SshFailure('pty allocation aborted', 'pty'))
    }
    if (signal?.aborted === true) {
      reject(new SshFailure('pty allocation aborted', 'pty'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // A sidebar terminal against a dead link otherwise opens as a tab that
    // never prints anything: the PTY channel-open is just as silent as an exec.
    watchdog = openWatchdog(waitedMs => {
      if (!settle()) return
      onDeadLink?.()
      reject(new SshFailure(
        `the SSH connection did not answer the PTY channel request within ${waitedMs} ms; the link is probably dead`,
        'pty',
        undefined,
        undefined,
        true,
      ))
    })
    client.exec(request.command, {
      pty: { term: request.term, cols: request.cols, rows: request.rows },
    }, (error, stream) => {
      if (!settle()) {
        // A late confirmation after a cancel or a dead-link verdict: the tab is
        // gone, so the channel must not be handed to anyone.
        try {
          ;(stream as unknown as PtyChannel | undefined)?.close()
        } catch {
          // The late channel is already gone.
        }
        return
      }
      if (error) {
        reject(channelLimitMessage(error) ?? new SshFailure(error.message, 'pty'))
        return
      }
      resolve(stream as unknown as PtyChannel)
    })
  })
}

/**
 * One command on one channel.
 *
 * `timeoutMs` is the command's own budget and nothing more: it is already net
 * of whatever the caller spent queueing and connecting. The dead-link verdict
 * is the separate {@link openWatchdog} window, because a short command timeout
 * is not evidence about the connection.
 */
function openChannel(
  client: Client,
  command: string,
  timeoutMs: number,
  stdin?: string | Buffer,
  onOutput?: (chunk: CommandChunk) => void,
  onDeadLink?: () => void,
): RemoteCommand {
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
    watchdog.settle()
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
      // The caller's own deadline fired before the server confirmed the
      // channel. That is the caller running out of time, not evidence that the
      // link is dead: the {@link openWatchdog} window is what detects a dead
      // link, and it is deliberately longer than a short per-call timeout.
      // Tearing the shared connection down here would kill every other channel
      // on this host for a command that merely had a tight deadline (S15).
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
  // A dead link never invokes the exec callback, so the command timer is the
  // only thing that would fire: every command on that connection burns its full
  // timeout, and none of them notices the connection is gone. This window makes
  // the first command report a dead link instead.
  //
  // This window is the ONLY dead-link verdict on this path. It must not be
  // shortened to a caller's own timeout: a healthy server answering the
  // channel-open in 80 ms would be called dead by a 50 ms command, and
  // `onDeadLink` drops the connection every other channel on the host shares.
  const watchdog = openWatchdog(waitedMs => {
    if (settled || stream !== undefined) return
    settled = true
    cause = 'timeout'
    clearTimeout(timer)
    clearTimeout(fallback)
    flushDecoder('stdout')
    flushDecoder('stderr')
    onDeadLink?.()
    rejectDone(new SshFailure(
      `the SSH connection did not answer the channel-open request within ${waitedMs} ms; the link is probably dead`,
      'exec',
      undefined,
      undefined,
      true,
    ))
  })
  try {
    client.exec(command, (error, opened) => {
      if (error) {
        watchdog.settle()
        if (!settled) {
          settled = true
          clearTimeout(timer)
          rejectDone(new SshFailure(error.message, 'exec'))
        }
        return
      }
      watchdog.settle()
      // The watchdog may already have rejected this call and dropped the
      // connection. The server can still answer afterwards, and writing stdin
      // or running the command now would execute a tool call that was already
      // reported as failed — and that `exec` may have already replayed.
      if (settled) {
        try {
          ;(opened as unknown as ExecStream).close()
        } catch {
          // The late channel is already gone.
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
    watchdog.settle()
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
  /** One-packet read budget from ssh2 (`_maxReadLen`), when this session has it. */
  _maxReadLen?: number
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

function openSftp(client: Client, onFatal?: () => void, onDeadLink?: () => void, signal?: AbortSignal): Promise<SftpSession> {
  return new Promise((resolve, reject) => {
    // Opening the SFTP subsystem is a channel open like any other, so a dead
    // link answers it exactly the same way: never. Without this window the
    // first file-tool call on a dead connection waits for the keepalive to give
    // up, then reports "No response from server" a minute later.
    let settled = false
    const watchdog = openWatchdog(waitedMs => {
      if (settled) return
      settled = true
      detach()
      onDeadLink?.()
      reject(new SshFailure(
        `the SSH connection did not answer the SFTP channel request within ${waitedMs} ms; the link is probably dead`,
        'sftp',
        undefined,
        undefined,
        true,
      ))
    })
    // A cancelled open must return without waiting for the watchdog window.
    const onAbort = (): void => {
      if (settled) return
      settled = true
      watchdog.settle()
      detach()
      reject(new SshFailure('sftp channel open aborted', 'sftp'))
    }
    const detach = (): void => { signal?.removeEventListener('abort', onAbort) }
    if (signal?.aborted === true) {
      watchdog.settle()
      reject(new SshFailure('sftp channel open aborted', 'sftp'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    client.sftp((error, sftp) => {
      watchdog.settle()
      detach()
      if (settled) {
        // A late channel after a cancel or a dead-link verdict is not wanted.
        try {
          ;(sftp as unknown as { end?: () => void } | undefined)?.end?.()
        } catch {
          // Already gone.
        }
        return
      }
      settled = true
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

/**
 * Four call sites reach this through `void closeLive(live)` from a dead-link
 * handler, where nothing observes a rejection. The function must therefore
 * never reject: dsh treats an unhandled rejection as fatal and exits, which
 * would take every other host in the pool down with the one dead link.
 */
async function closeLive(live: Live): Promise<void> {
  try {
    const session = await live.sftp
    session?.end()
  } catch {
    // Opening SFTP failed; the client close still releases the session slot.
  }
  try {
    live.client.end()
  } catch {
    // The socket was already destroyed, or the transport threw while
    // unwinding. The slot was released by `markDead` in every caller.
  }
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
 * How many bytes of reads may sit unanswered. A single 64 KiB window at a
 * time measured 1.4 MiB/s on a LAN host while the same link reached 40+ MiB/s
 * once a window was queued, so the window is what the throughput depends on.
 * 1 MiB matches {@link WRITE_BUDGET}: a cross-host copy then holds about 2 MiB
 * of buffers no matter which leg is the slower one.
 */
const READ_BUDGET = 1024 * 1024
/** Hard cap on concurrent READ requests, independent of their size. */
const MAX_INFLIGHT_READS = 16

/**
 * One read request. A server that advertises `_maxReadLen` (OpenSSH: 261120,
 * i.e. 256 KiB minus overhead) accepts a request that big, and asking for it
 * instead of 64 KiB quarters the number of round trips. Anything at or below
 * 64 KiB, or a missing advertisement, keeps the conservative window.
 */
function readChunkBytes(sftp: SftpLike): number {
  const packet = sftp._maxReadLen
  if (typeof packet !== 'number' || !Number.isSafeInteger(packet) || packet <= READ_CHUNK) return READ_CHUNK
  return Math.min(packet, 256 * 1024)
}

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

/**
 * Read a file as one ordered stream of chunks, with a window of reads in flight.
 *
 * One read at a time makes the peer round trip the bottleneck: a 32 MiB file
 * took 23 s over a LAN link (1.4 MiB/s) because every 64 KiB waited for its
 * own reply. Issuing a bounded window of reads keeps the link busy, which is
 * the same trade ssh2's own `fastGet` makes. Slots are consumed strictly in
 * order, so the stream stays sequential byte for byte.
 *
 * A short read is the one case where the queued slots were issued at offsets
 * that no longer line up, because slots are spaced by the requested length.
 * Rare before EOF (a server that caps replies below `_maxReadLen`): the queued
 * reads are dropped and the window re-anchors on the byte actually reached.
 */
export async function* readOpenChunks(sftp: SftpLike, remotePath: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
  // The SFTP channel is cached and a stream can be long, so no single ceiling
  // can cover the whole file. What must still be bounded is ONE request going
  // unanswered: on a dead link that is the difference between reporting in ten
  // seconds and waiting for keepalive (60 s) with nothing to show.
  //
  // This applies whether or not the caller passed a signal. A signal is a
  // cancellation channel, not a deadline: the `read` tool passes its own
  // `exec.signal`, which only fires when the operator cancels, so treating
  // "has a signal" as "is bounded" would leave the common case unbounded.
  // Per-request bounds compose safely with a slow-but-working transfer, because
  // each request is answered long before ten seconds even at 1 MiB/s.
  const bound = <T>(work: Promise<T>, stage: string): Promise<T> => boundedSftpRequest(work, stage)
  const opening = bound(openRead(sftp, remotePath), 'sftp-read')
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
  const chunkBytes = readChunkBytes(sftp)
  // Bounded by bytes as well as by a request count: a server that advertises
  // 256 KiB replies still holds about `READ_BUDGET` of buffers, not 16 × 256 KiB.
  const window = Math.max(1, Math.min(MAX_INFLIGHT_READS, Math.floor(READ_BUDGET / chunkBytes)))
  const queued: Array<Promise<Buffer>> = []
  // Offset the next queue slot asks for. It advances by the *requested*
  // length, so every slot holds a full chunk unless a read comes back short.
  let issueAt = 0
  // Bytes handed to the consumer so far: where a re-anchored window starts.
  let position = 0
  /**
   * Hold one queued read so a failure is never unobserved.
   *
   * The consumer awaits only the head of the queue, so a non-head read that
   * rejects has no handler until the loop reaches it — and if that position is
   * dropped instead, only `finally` would see it. Node reports an unhandled
   * rejection the moment one is emitted on an unobserved promise, and dsh turns
   * that into a fatal exit (`src/execute.ts`), so the handler has to be
   * attached at issue time, not when the value is finally read.
   *
   * The observed promise is returned with its rejection preserved, so the head
   * still rejects for the loop.
   */
  const track = (work: Promise<Buffer>): Promise<Buffer> => {
    work.catch(() => undefined)
    return work
  }
  const issue = (): void => {
    queued.push(track(raceAbort(bound(readAt(sftp, handle, issueAt, chunkBytes), 'sftp-read'), signal)))
    issueAt += chunkBytes
  }
  const refill = (): void => {
    while (queued.length < window) issue()
  }
  try {
    refill()
    while (true) {
      if (signal?.aborted) throw new SshFailure('sftp read aborted', 'sftp-read')
      const chunk = await queued.shift()!
      if (chunk.length === 0) return
      position += chunk.length
      if (chunk.length < chunkBytes) {
        // The queued slots were spaced by the full chunk that never arrived, so
        // their offsets no longer line up with the bytes. Drop them (observing
        // each so its eventual failure is not an unhandled rejection) and
        // re-anchor the window on the byte actually reached.
        for (const dropped of queued.splice(0)) dropped.catch(() => undefined)
        issueAt = position
      }
      yield chunk
      refill()
    }
  } finally {
    // Nothing observes a queued read after the consumer stops. The handle
    // close below fails them at the protocol layer, and this keeps that
    // failure from surfacing as an unhandled rejection.
    for (const dropped of queued.splice(0)) dropped.catch(() => undefined)
    await settleWithin(bound(closeHandle(sftp, handle), 'sftp-read'))
  }
}
