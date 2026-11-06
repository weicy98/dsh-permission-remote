/**
 * Remote execution-world adapters for the official PTC runtime and ordinary
 * official tools.
 *
 * The official `NodePtcRuntime` knows nothing about SSH. This module supplies
 * the three seams it consumes:
 *
 * - `fs.processPathFromHostPath`: maps the host's process.js path to the
 *   uploaded .mjs file;
 * - `sandbox.confine`: wraps the worker argv in the remote bwrap/seatbelt
 *   profile;
 * - `subprocess.spawn`: starts the remote shim and exposes the official
 *   control channel as fd 7.
 *
 * The same `spawn`/`confine` seams also route ordinary official subprocesses
 * (bash and fs-search) by their placeholder cwd / policy root. Local calls
 * always fall through to the original services.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, resolve as resolvePath } from 'node:path'
import { Duplex, PassThrough, type Readable, type Writable } from 'node:stream'
import { symbols } from '@deepseek-ai/cordis'
import {
  SandboxUnavailableError,
  type ConfinedArgv,
  type SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { HostConfig } from './config.ts'
import type { RunnerStatus } from './execute.ts'
import { bwrapProfileArgs, fileWritableRoots, seatbeltProfileArgs } from './profile.ts'
import { shJoin } from './shell-quote.ts'
import type { RemoteTransport, RemoteExecHandle } from './remote-transport.ts'
import type { ExecResult, SecretMaterial } from './ssh-pool.ts'

export interface RemoteWorld {
  readonly host: HostConfig
  readonly secret: SecretMaterial
  readonly status: RunnerStatus
  readonly remoteCwd: string
  readonly remoteRoot: string
  readonly remoteNodePath: string
  readonly remoteRipgrepPath: string
  readonly workerLocalPaths: readonly string[]
  readonly workerRemotePath: string
  readonly shimRemotePath: string
  readonly launchExecutable: string
  resolvedLocalExecutable?: string
}

export const remoteWorldContext = new AsyncLocalStorage<RemoteWorld | undefined>()

const PTC_AUTH_ACK = '__DSH_PTC_AUTH_OK__'
const PTC_AUTH_TIMEOUT_MS = 10_000

export interface RemoteWorldDeps {
  readonly transport: RemoteTransport
  readonly hostOf: (hostId: string) => HostConfig | undefined
  readonly secretOf: (host: HostConfig) => Promise<SecretMaterial>
  readonly statusOf: (host: HostConfig) => Promise<RunnerStatus>
  readonly routeByCwd: (cwd: string | undefined) => { kind: 'remote', hostId: string, remoteCwd: string, placeholderCwd: string } | { kind: 'local' }
}

interface MutableService {
  [key: string]: unknown
}

const WORLD_MARK = Symbol.for('dsh-permission-remote.remote-world')

function unwrap(service: unknown): MutableService | undefined {
  if (typeof service !== 'object' || service === null) return undefined
  const branded = service as { [symbols.original]?: MutableService }
  return branded[symbols.original] ?? service as MutableService
}

function ownMethod<T>(service: MutableService, name: string, fallback: T): T {
  const value = service[name]
  return typeof value === 'function' ? value as T : fallback
}

/** A small duplex bridge: local writes are queued until the SSH channel opens. */
class ControlBridge extends Duplex {
  private remote: Duplex | undefined
  private readonly pending: Array<{ chunk: Buffer | string, encoding?: BufferEncoding, callback?: (error?: Error | null) => void }> = []
  private paused = false

  override _read(): void {
    if (this.paused) {
      this.paused = false
      this.remote?.resume()
    }
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.remote === undefined) {
      this.pending.push({ chunk, encoding, callback })
      return
    }
    this.remote.write(chunk, encoding, callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      this.remote?.end()
      callback()
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    try {
      this.remote?.destroy()
    } catch {
      // Already gone.
    }
    callback(error)
  }

  attach(remote: Duplex): void {
    this.remote = remote
    remote.on('data', chunk => {
      if (!this.push(chunk)) {
        this.paused = true
        remote.pause()
      }
    })
    remote.on('end', () => this.push(null))
    remote.on('close', () => this.destroy())
    remote.on('error', error => this.destroy(error))
    const pending = this.pending.splice(0)
    for (const item of pending) remote.write(item.chunk, item.encoding ?? 'utf8', item.callback)
  }

  fail(error: Error): void {
    this.destroy(error)
  }
}

const EMPTY_READER = {
  readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }),
}

function emptyCollected(): SubprocessCollectedOutputs {
  return { stdout: EMPTY_READER, stderr: EMPTY_READER } as unknown as SubprocessCollectedOutputs
}

class RemotePtcHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined = undefined
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly control: ControlBridge
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  private readonly world: RemoteWorld
  private readonly spec: SubprocessSpawnSpec
  private readonly transport: RemoteTransport
  private exec: RemoteExecHandle | undefined
  private forward: Duplex | undefined
  private settled = false
  private terminated = false
  private resolveDone: (value: SubprocessOutcome) => void = () => undefined
  private rejectDone: (error: Error) => void = () => undefined
  private readonly token = randomBytes(16).toString('hex')
  private readonly socketPath: string
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly stderrDecoder = new TextDecoder()
  private stderrBuffer = ''
  private ready = false

  constructor(world: RemoteWorld, spec: SubprocessSpawnSpec, transport: RemoteTransport) {
    this.world = world
    this.spec = spec
    this.transport = transport
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.control = new ControlBridge()
    this.collected = emptyCollected()
    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })
    const tempRoot = world.status.roots.userTmp.length > 0
      ? world.status.roots.userTmp
      : world.status.roots.tmp.length > 0 ? world.status.roots.tmp : '/tmp'
    this.socketPath = posix.join(tempRoot, `dsh-ptc-${randomBytes(8).toString('hex')}`, 'run.sock')
    void this.start()
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
    }
  }

  private flushStderr(): void {
    const tail = this.stderrDecoder.decode()
    if (this.stderrBuffer.length > 0) {
      this.stderr.write(this.stderrBuffer)
      this.stderrBuffer = ''
    }
    if (tail.length > 0) this.stderr.write(tail)
  }

  private fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    this.clearHandshakeTimer()
    this.rejectHandshake?.(error)
    this.rejectHandshake = undefined
    this.stdout.end()
    this.flushStderr()
    this.stderr.end()
    this.control.fail(error)
    this.forward?.destroy()
    this.exec?.close()
    this.rejectDone(error)
  }

  private finish(result: ExecResult): void {
    if (this.settled) return
    this.settled = true
    this.clearHandshakeTimer()
    if (!this.ready) {
      this.rejectHandshake?.(new Error('PTC worker exited before the control-channel handshake'))
      this.rejectHandshake = undefined
    }
    this.stdout.end()
    this.flushStderr()
    this.stderr.end()
    this.control.destroy()
    this.forward?.destroy()
    this.resolveDone({
      exitCode: result.code,
      signal: result.signal as NodeJS.Signals | null,
    })
  }

  private async start(): Promise<void> {
    try {
      const argv = this.spec.argv.map((value, index) => index === 0 ? this.remoteExecutable(value) : value)
      const shimCommand = shJoin([
        this.world.remoteNodePath,
        this.world.shimRemotePath,
        this.socketPath,
        this.world.remoteCwd,
        '--',
        ...argv,
      ])
      this.exec = await this.transport.exec(this.world.host, this.world.secret, shimCommand, this.spec.signal)
      if (this.terminated || this.settled) {
        this.exec.close()
        return
      }
      this.handshakeTimer = setTimeout(() => this.fail(new Error('PTC shim did not print a control-channel handshake')), 10_000)
      this.exec.stdout.on('data', chunk => {
        if (!this.settled) this.stdout.write(chunk)
      })
      this.exec.stderr.on('data', chunk => this.consumeStderr(chunk))
      this.exec.write(`${this.token}\n`)
      this.exec.done.then(
        result => this.finish(result),
        error => this.fail(error instanceof Error ? error : new Error(String(error))),
      )
      const endpoint = await this.waitForHandshake()
      if (this.terminated || this.settled) {
        this.clearHandshakeTimer()
        return
      }
      // The timeout covers the shim handshake only. A long-running PTC
      // program legitimately keeps the control channel open for minutes.
      this.clearHandshakeTimer()
      let forward: Duplex | undefined
      let usedTcp = endpoint.unixPath === undefined
      if (endpoint.unixPath !== undefined) {
        try {
          forward = await this.transport.forwardOutStreamLocal(this.world.host, this.world.secret, endpoint.unixPath, this.spec.signal)
        } catch (error) {
          if (endpoint.tcpPort === undefined) throw error
          usedTcp = true
        }
      }
      if (forward === undefined && endpoint.tcpPort !== undefined) {
        forward = await this.transport.forwardOutTcp(this.world.host, this.world.secret, '127.0.0.1', endpoint.tcpPort, this.spec.signal)
        usedTcp = true
      }
      if (forward === undefined) throw new Error('PTC shim reported no usable forwarding endpoint')
      this.forward = forward
      if (this.terminated || this.settled) {
        forward.destroy()
        return
      }
      // TCP has no Unix socket permissions; require the shim token so a local
      // user who wins the accept race cannot take over the control channel.
      // Wait for the shim's acknowledgement before writing any control frame:
      // auth bytes and a first frame must never share one TCP read.
      if (usedTcp) {
        forward.write(`__DSH_PTC_AUTH__ ${this.token}\n`)
        await this.waitForAuthAck(forward)
        if (this.terminated || this.settled) {
          forward.destroy()
          return
        }
      }
      this.control.attach(forward)
      forward.resume()
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private remoteExecutable(value: string): string {
    if (value === this.world.resolvedLocalExecutable || value === this.world.launchExecutable || value === process.execPath) {
      return this.world.remoteNodePath
    }
    return value
  }

  private consumeStderr(chunk: Buffer): void {
    this.stderrBuffer += this.stderrDecoder.decode(chunk, { stream: true })
    let newline = this.stderrBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.stderrBuffer.slice(0, newline).replace(/\r$/u, '')
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1)
      const parts = line.trim().split(/\s+/u)
      if (!this.ready && parts[0] === '__DSH_PTC_READY__' && parts[1] !== undefined) {
        const unix = parts.slice(2).find(value => value.startsWith('unix:'))
        const tcp = parts.slice(2).find(value => value.startsWith('tcp:'))
        if (unix !== undefined || tcp !== undefined) {
          this.ready = true
          this.handshake = {
            token: parts[1],
            ...(unix === undefined ? {} : { unixPath: unix.slice(5) }),
            ...(tcp === undefined ? {} : { tcpPort: Number(tcp.slice(4).split(':').at(-1)) }),
          }
          this.resolveHandshake?.()
          this.resolveHandshake = undefined
        } else {
          this.stderr.write(`${line}\n`)
        }
      } else {
        this.stderr.write(`${line}\n`)
      }
      newline = this.stderrBuffer.indexOf('\n')
    }
  }

  private handshake: { token: string, unixPath?: string, tcpPort?: number } | undefined
  private resolveHandshake: (() => void) | undefined
  private rejectHandshake: ((error: Error) => void) | undefined

  private async waitForHandshake(): Promise<{ unixPath?: string, tcpPort?: number }> {
    if (this.handshake === undefined) {
      if (this.settled) throw new Error('PTC worker exited before the control-channel handshake')
      await new Promise<void>((resolve, reject) => {
        this.resolveHandshake = resolve
        this.rejectHandshake = reject
      })
    }
    if (this.handshake === undefined) throw new Error('PTC shim handshake disappeared')
    if (this.handshake.token !== this.token) throw new Error('PTC shim handshake token did not match')
    if (this.handshake.unixPath === undefined && this.handshake.tcpPort === undefined) {
      throw new Error('PTC shim handshake had no forwarding endpoint')
    }
    return {
      ...(this.handshake.unixPath === undefined ? {} : { unixPath: this.handshake.unixPath }),
      ...(this.handshake.tcpPort === undefined ? {} : { tcpPort: this.handshake.tcpPort }),
    }
  }

  /**
   * Wait for the shim to acknowledge the TCP auth line before the host starts
   * writing control frames. Without this barrier a TCP read can contain the
   * auth line and the first frame together; the shim cannot hand buffered
   * Node.js bytes to the child's duplicated fd 7.
   */
  private waitForAuthAck(forward: Duplex): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let buffer = ''
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        forward.off('data', onData)
        forward.off('error', onError)
        this.spec.signal?.removeEventListener('abort', onAbort)
        if (timer !== undefined) clearTimeout(timer)
      }
      const finish = (error?: Error) => {
        if (done) return
        done = true
        cleanup()
        if (error === undefined) {
          forward.pause()
          resolve()
        } else {
          reject(error)
        }
      }
      const onAbort = () => finish(new Error('PTC TCP authentication was aborted'))
      const onError = (error: Error) => finish(error)
      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString()
        const newline = buffer.indexOf('\n')
        if (newline === -1) {
          if (buffer.length > 4096) finish(new Error('PTC TCP authentication acknowledgement was too long'))
          return
        }
        const line = buffer.slice(0, newline).replace(/\r$/u, '')
        if (line !== PTC_AUTH_ACK) {
          finish(new Error('PTC shim rejected the TCP authentication token'))
          return
        }
        const rest = buffer.slice(newline + 1)
        if (rest.length > 0) forward.unshift(Buffer.from(rest))
        finish()
      }
      forward.on('data', onData)
      forward.once('error', onError)
      if (this.spec.signal?.aborted === true) {
        onAbort()
        return
      }
      this.spec.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish(new Error('PTC shim did not acknowledge the TCP authentication token')), PTC_AUTH_TIMEOUT_MS)
    })
  }

  terminate(): void {
    if (this.settled) return
    this.terminated = true
    if (this.exec !== undefined) {
      this.exec.close()
      this.forward?.destroy()
      return
    }
    // Cancellation can arrive while transport.exec() is still pending. Settle
    // the handle as killed instead of rejecting a `done` promise whose caller
    // may not have attached a handler yet.
    this.settled = true
    this.clearHandshakeTimer()
    const error = new Error('PTC worker terminated before the SSH channel was opened')
    this.rejectHandshake?.(error)
    this.rejectHandshake = undefined
    this.stdout.end()
    this.stderr.end()
    this.control.fail(error)
    this.resolveDone({ exitCode: null, signal: 'SIGKILL' })
  }

  waitForExit(): Promise<boolean> {
    return this.done.then(() => true, () => false)
  }
}


/**
 * The spill location shared by every collector in this process.
 *
 * One private directory per process, created lazily on the first stream that
 * actually overflows: a per-spawn directory would leave a new temp tree behind
 * for every large bash/search call. Files are named per collector and retained
 * as full-output recovery artifacts, matching `@deepseek-ai/dsh-subprocess-local`.
 */
let spillDirectory: string | undefined
let spillCounter = 0

function sharedSpillDirectory(): string {
  spillDirectory ??= mkdtempSync(join(tmpdir(), 'dsh-remote-spill-'))
  return spillDirectory
}

/**
 * A bounded, offset-readable collect stream.
 *
 * Offsets are RAW STREAM BYTES: `seenBytes` counts what arrived, never the
 * re-encoded length of decoded text, so `nextOffset` stays a valid cursor even
 * when the stream contains invalid UTF-8 (which decodes to U+FFFD and would
 * otherwise change the byte count).
 *
 * The retained tail is kept as bytes and cut in the byte domain, so the cap is
 * a real byte cap for multi-byte text and a surrogate pair is never split into
 * two lone halves of different lengths.
 */
class CollectedStream {
  private retained: Buffer = Buffer.alloc(0)
  private seenBytes = 0
  private readonly maxBytes: number
  private readonly spillMax: number | undefined
  private spillPath: string | undefined
  private spillBytes = 0
  /**
   * Set once the spill can no longer hold the COMPLETE stream (cap exceeded or
   * a write failed). A spill is never reopened: re-seeding a fresh file from
   * the already-truncated tail would advertise a partial stream as the full
   * one, which is worse than reporting no spill path at all.
   */
  private spillDisabled: boolean

  constructor(maxBytes: number, spill?: { maxBytes: number }) {
    this.maxBytes = Math.max(1, maxBytes)
    this.spillMax = spill === undefined ? undefined : Math.max(1, spill.maxBytes)
    // A spill cap at or below the inline cap can never hold the complete
    // stream: the first overflow already exceeds it.
    this.spillDisabled = this.spillMax === undefined || this.spillMax <= this.maxBytes
  }

  private discardSpill(): void {
    if (this.spillPath !== undefined) {
      try {
        rmSync(this.spillPath, { force: true })
      } catch {
        // Best effort.
      }
    }
    this.spillPath = undefined
    this.spillBytes = 0
    this.spillDisabled = true
  }

  /**
   * Open the spill file on first overflow. Every byte seen so far is still in
   * `retained` at this point, so the file starts with the complete stream.
   */
  private openSpill(): void {
    try {
      const path = join(sharedSpillDirectory(), `stream-${process.pid}-${++spillCounter}.log`)
      appendFileSync(path, this.retained)
      this.spillPath = path
      this.spillBytes = this.retained.length
    } catch {
      this.discardSpill()
    }
  }

  push(chunk: Buffer | string): void {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (bytes.length === 0) return
    const overflows = this.retained.length + bytes.length > this.maxBytes
    if (!this.spillDisabled && (overflows || this.spillPath !== undefined)) {
      if (this.spillPath === undefined) this.openSpill()
      if (this.spillPath !== undefined) {
        try {
          appendFileSync(this.spillPath, bytes)
          this.spillBytes += bytes.length
          if (this.spillMax !== undefined && this.spillBytes > this.spillMax) this.discardSpill()
        } catch {
          this.discardSpill()
        }
      }
    }
    this.seenBytes += bytes.length
    this.retained = this.retained.length === 0 ? bytes : Buffer.concat([this.retained, bytes])
    // Keep exactly the last `maxBytes` bytes. The cut may land inside a
    // multi-byte character; advancing past the orphan continuation bytes makes
    // the tail decode cleanly instead of starting with a replacement character.
    if (this.retained.length > this.maxBytes) {
      let start = this.retained.length - this.maxBytes
      while (start < this.retained.length && (this.retained[start]! & 0xc0) === 0x80) start += 1
      this.retained = this.retained.subarray(start)
    }
  }

  /** Drop the spill file: a failed stream has no readable result to recover. */
  dispose(): void {
    this.discardSpill()
  }

  readFrom(fromByte: number): { text: string, nextOffset: number, lossy: boolean, spillPath?: string } {
    const retainedStart = this.seenBytes - this.retained.length
    const lossy = fromByte < retainedStart
    const start = Math.max(0, Math.min(this.retained.length, fromByte - retainedStart))
    return {
      text: this.retained.subarray(start).toString('utf8'),
      nextOffset: this.seenBytes,
      lossy,
      // Advertise a spill path only when it holds the complete stream.
      ...(this.spillPath === undefined ? {} : { spillPath: this.spillPath }),
    }
  }
}

function collectMode(value: unknown): value is { maxBytes: number, spill?: { maxBytes: number } } {
  return typeof value === 'object' && value !== null && typeof (value as { maxBytes?: unknown }).maxBytes === 'number'
}

function collectReader(value: unknown): CollectedStream | undefined {
  return collectMode(value) ? new CollectedStream(value.maxBytes, value.spill) : undefined
}

function remoteProgram(world: RemoteWorld, value: string): string {
  const name = basename(value)
  if ((name === 'rg' || name === 'rg.exe') && world.remoteRipgrepPath.length > 0) return world.remoteRipgrepPath
  if (world.remoteNodePath.length > 0
    && (value === world.resolvedLocalExecutable || value === world.launchExecutable || value === process.execPath)) {
    return world.remoteNodePath
  }
  return value
}

function remoteProcessCommand(spec: SubprocessSpawnSpec, world: RemoteWorld): string {
  const argv = spec.argv.map((value, index) => index === 0 ? remoteProgram(world, value) : value)
  const env = spec.env ?? {}
  const values: string[] = []
  const removals: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) removals.push(name)
    else values.push(`${name}=${value}`)
  }
  const prefix = values.length > 0 || removals.length > 0
    ? shJoin(['env', ...removals.flatMap(name => ['-u', name]), ...values])
    : ''
  const command = shJoin(argv)
  return `cd ${shJoin([world.remoteCwd])} && ${prefix.length > 0 ? `${prefix} ` : ''}${command}`
}

function worldForRoute(route: { hostId: string, remoteCwd: string }, host: HostConfig, secret: SecretMaterial, status: RunnerStatus): RemoteWorld {
  return {
    host,
    secret,
    status,
    remoteCwd: route.remoteCwd,
    remoteRoot: route.remoteCwd,
    remoteNodePath: status.node?.available === true ? status.node.path : '',
    remoteRipgrepPath: status.ripgrepPath,
    workerLocalPaths: [],
    workerRemotePath: '',
    shimRemotePath: '',
    launchExecutable: '',
  }
}

/** One ordinary remote process: streaming or collected stdout/stderr, optional stdin. */
class RemoteProcessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly control: Duplex | undefined = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  private readonly route: { hostId: string, remoteCwd: string, placeholderCwd: string }
  private readonly spec: SubprocessSpawnSpec
  private readonly transport: RemoteTransport
  private readonly deps: RemoteWorldDeps
  private readonly outCollector: CollectedStream | undefined
  private readonly errCollector: CollectedStream | undefined
  private exec: RemoteExecHandle | undefined
  private readonly pendingInput: Buffer[] = []
  private inputEnded = false
  private settled = false
  private terminated = false
  private resolveDone: (value: SubprocessOutcome) => void = () => undefined
  private rejectDone: (error: Error) => void = () => undefined

  constructor(
    route: { hostId: string, remoteCwd: string, placeholderCwd: string },
    spec: SubprocessSpawnSpec,
    transport: RemoteTransport,
    deps: RemoteWorldDeps,
  ) {
    this.route = route
    this.spec = spec
    this.transport = transport
    this.deps = deps
    this.outCollector = collectReader(spec.stdio.stdout)
    this.errCollector = collectReader(spec.stdio.stderr)
    this.collected = {
      ...(this.outCollector === undefined ? {} : { stdout: { readFrom: offset => this.outCollector!.readFrom(offset) } }),
      ...(this.errCollector === undefined ? {} : { stderr: { readFrom: offset => this.errCollector!.readFrom(offset) } }),
    } as SubprocessCollectedOutputs
    this.stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    this.stderr = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    if (spec.stdio.stdin === 'pipe') {
      const input = new PassThrough()
      input.on('data', chunk => {
        if (this.exec === undefined) this.pendingInput.push(Buffer.from(chunk))
        else this.exec.write(chunk)
      })
      input.on('end', () => {
        this.inputEnded = true
        this.exec?.end()
      })
      this.stdin = input
    } else {
      this.stdin = undefined
    }
    this.done = new Promise<SubprocessOutcome>((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })
    void this.start()
  }

  private async start(): Promise<void> {
    try {
      const host = this.deps.hostOf(this.route.hostId)
      if (host === undefined) throw new Error(`no configured SSH host for ${this.route.hostId}`)
      const secret = await this.deps.secretOf(host)
      const status = await this.deps.statusOf(host)
      if (this.terminated) {
        this.settled = true
        this.resolveDone({ exitCode: null, signal: 'SIGKILL' })
        return
      }
      const world = worldForRoute(this.route, host, secret, status)
      const command = remoteProcessCommand(this.spec, world)
      const exec = await this.transport.exec(host, secret, command, this.spec.signal)
      this.exec = exec
      if (this.terminated) {
        exec.close()
        return
      }
      for (const chunk of this.pendingInput.splice(0)) exec.write(chunk)
      if (this.inputEnded) exec.end()
      if (this.stdout !== undefined) exec.stdout.on('data', chunk => this.stdout!.write(chunk))
      if (this.stderr !== undefined) exec.stderr.on('data', chunk => this.stderr!.write(chunk))
      if (this.outCollector !== undefined) exec.stdout.on('data', chunk => this.outCollector!.push(chunk))
      if (this.errCollector !== undefined) exec.stderr.on('data', chunk => this.errCollector!.push(chunk))
      if (this.spec.stdio.stdin !== 'pipe' && typeof this.spec.stdio.stdin === 'object' && 'data' in this.spec.stdio.stdin) {
        exec.write(this.spec.stdio.stdin.data)
        exec.end()
      } else if (this.spec.stdio.stdin === 'pipe') {
        // stdin was created in the constructor; its listeners queue locally.
      } else {
        exec.end()
      }
      exec.done.then(result => this.finish(result), error => this.fail(error))
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private finish(result: ExecResult): void {
    if (this.settled) return
    this.settled = true
    this.stdout?.end()
    this.stderr?.end()
    this.resolveDone({ exitCode: result.code, signal: result.signal as NodeJS.Signals | null })
  }

  private fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    // A failed run has no readable result, so its spill file is dead weight.
    this.outCollector?.dispose()
    this.errCollector?.dispose()
    this.stdout?.destroy(error)
    this.stderr?.destroy(error)
    this.rejectDone(error)
  }

  terminate(): void {
    if (this.settled) return
    this.terminated = true
    if (this.exec === undefined) {
      // No transport was opened yet. Resolve as a killed process instead of
      // rejecting `done`, which may not have a listener until the caller's
      // next microtask.
      this.settled = true
      this.stdout?.destroy()
      this.stderr?.destroy()
      this.resolveDone({ exitCode: null, signal: 'SIGKILL' })
      return
    }
    this.exec.close()
  }

  waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (signal === undefined) return this.done.then(() => true, () => false)
    if (signal.aborted) return Promise.resolve(false)
    return new Promise<boolean>(resolve => {
      const abort = () => resolve(false)
      signal.addEventListener('abort', abort, { once: true })
      this.done.then(() => resolve(true), () => resolve(false)).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}

/** Install remote-world patches on the deployment's sandbox/subprocess services. */
export function installRemoteWorld(ctx: { get(name: string): unknown }, deps: RemoteWorldDeps): (() => void) | undefined {
  const subprocess = unwrap(ctx.get('subprocess'))
  const sandbox = unwrap(ctx.get('sandbox'))
  if (subprocess === undefined || sandbox === undefined) return undefined
  if ((subprocess as { [WORLD_MARK]?: boolean })[WORLD_MARK] === true) return undefined

  const ownSpawn = Object.hasOwn(subprocess, 'spawn')
  const savedSpawn = subprocess.spawn
  const ownResolve = Object.hasOwn(subprocess, 'resolveExecutable')
  const savedResolve = subprocess.resolveExecutable
  const ownConfine = Object.hasOwn(sandbox, 'confine')
  const savedConfine = sandbox.confine
  const originalSpawn = ownMethod<(...args: unknown[]) => SubprocessHandle>(subprocess, 'spawn', savedSpawn as never)
  const originalResolve = ownMethod<(...args: unknown[]) => Promise<string>>(subprocess, 'resolveExecutable', savedResolve as never)
  const originalConfine = ownMethod<(...args: unknown[]) => Promise<ConfinedArgv>>(sandbox, 'confine', savedConfine as never)

  subprocess.spawn = ((spec: SubprocessSpawnSpec) => {
    const world = remoteWorldContext.getStore()
    if (world !== undefined && spec.stdio?.control === 'pipe') return new RemotePtcHandle(world, spec, deps.transport)
    const route = deps.routeByCwd(spec.cwd)
    if (route.kind !== 'remote') return originalSpawn.call(subprocess, spec)
    return new RemoteProcessHandle(route, spec, deps.transport, deps)
  }) as never

  subprocess.resolveExecutable = (async (command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) => {
    const result = await originalResolve.call(subprocess, command, env, signal)
    const world = remoteWorldContext.getStore()
    if (world !== undefined && (command === world.launchExecutable || command === process.execPath)) {
      world.resolvedLocalExecutable = result
    }
    return result
  }) as never

  sandbox.confine = (async (argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> => {
    const active = remoteWorldContext.getStore()
    if (active !== undefined && argv.includes(active.workerRemotePath)) {
      signal?.throwIfAborted()
      if (!active.status.sandbox.available || active.status.sandboxTool === 'none') {
        throw new SandboxUnavailableError(policy.mode, 'remote sandbox probe failed')
      }
      const mapped = argv.map((value, index) => index === 0 ? remoteExecutable(active, value) : value)
      if (active.status.sandboxTool === 'bwrap') {
        // PTC follows the bash-style workspace profile: a private /tmp rather
        // than the file-tool profile that bind-mounts the real temp dirs.
        const profile = bwrapProfileArgs(policy.mode, active.remoteRoot) ?? []
        return {
          argv: ['bwrap', ...profile, '--chdir', active.remoteCwd, '--', ...mapped],
          enforcement: 'full',
          denialSignatures: ['read-only file system'],
          runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }],
        }
      }
      const profile = seatbeltProfileArgs(policy.mode, policy.mode === 'workspace-write'
        // Same write grants the bash path derives from `fileWritableRoots`:
        // the workspace root plus the remote temp dirs. Granting only the
        // workspace here would deny a PTC program what bash already allows.
        ? fileWritableRoots(policy.mode, {
          workspaceRoot: active.remoteRoot,
          tmp: active.status.roots.tmp,
          userTmp: active.status.roots.userTmp,
        })
        : []) ?? []
      return {
        argv: ['sandbox-exec', ...profile, '--', ...mapped],
        enforcement: 'full',
        denialSignatures: ['operation not permitted'],
        runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }],
      }
    }
    const route = deps.routeByCwd(policy.workspaceRoot)
    if (route.kind !== 'remote') return originalConfine.call(sandbox, argv, policy, signal)
    signal?.throwIfAborted()
    const host = deps.hostOf(route.hostId)
    if (host === undefined) throw new SandboxUnavailableError(policy.mode, 'remote host not configured')
    const status = await deps.statusOf(host)
    if (!status.sandbox.available || status.sandboxTool === 'none') {
      throw new SandboxUnavailableError(policy.mode, 'remote sandbox probe failed')
    }
    const roots = {
      workspaceRoot: route.remoteCwd,
      tmp: status.roots.tmp,
      userTmp: status.roots.userTmp,
    }
    const mapped = argv.map((value, index) => index === 0 ? remoteProgramForStatus(status, value) : value)
    if (status.sandboxTool === 'bwrap') {
      // Ordinary shell/process execution follows the bash-style profile:
      // workspace-write gets a private /tmp rather than the file-tool profile's
      // real temp binds. File tools use the file profile through remote-write.
      const profile = bwrapProfileArgs(policy.mode, roots.workspaceRoot) ?? []
      return {
        argv: ['bwrap', ...profile, '--', ...mapped],
        enforcement: 'full',
        denialSignatures: ['read-only file system'],
        runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }],
      }
    }
    const profile = seatbeltProfileArgs(policy.mode, fileWritableRoots(policy.mode, roots)) ?? []
    return {
      argv: ['sandbox-exec', ...profile, '--', ...mapped],
      enforcement: 'full',
      denialSignatures: ['operation not permitted'],
      runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }],
    }
  }) as never

  ;(subprocess as { [WORLD_MARK]?: boolean })[WORLD_MARK] = true
  return () => {
    if (ownSpawn) subprocess.spawn = savedSpawn
    else delete subprocess.spawn
    if (ownResolve) subprocess.resolveExecutable = savedResolve
    else delete subprocess.resolveExecutable
    if (ownConfine) sandbox.confine = savedConfine
    else delete sandbox.confine
    delete (subprocess as { [WORLD_MARK]?: boolean })[WORLD_MARK]
  }
}

function remoteProgramForStatus(status: RunnerStatus, value: string): string {
  const name = basename(value)
  if ((name === 'rg' || name === 'rg.exe') && status.ripgrepPath.length > 0) return status.ripgrepPath
  return value
}

function remoteExecutable(world: RemoteWorld, value: string): string {
  if (value === world.resolvedLocalExecutable || value === world.launchExecutable || value === process.execPath) {
    return world.remoteNodePath
  }
  return value
}

/** Map the host process.js path to the uploaded .mjs while a PTC run is active. */
export function installWorkerPathMap(fsService: unknown): () => void {
  if (typeof fsService !== 'object' || fsService === null) return () => undefined
  const surface = unwrap(fsService)
  if (surface === undefined || typeof surface.processPathFromHostPath !== 'function') return () => undefined
  const own = Object.hasOwn(surface, 'processPathFromHostPath')
  const saved = surface.processPathFromHostPath as (hostPath: string) => string | undefined
  const original = saved.bind(surface)
  surface.processPathFromHostPath = (hostPath: string) => {
    const world = remoteWorldContext.getStore()
    if (world !== undefined) {
      const normalized = resolvePath(hostPath)
      if (world.workerLocalPaths.some(path => resolvePath(path) === normalized)) return world.workerRemotePath
    }
    return original(hostPath)
  }
  return () => {
    if (own) surface.processPathFromHostPath = saved
    else delete surface.processPathFromHostPath
  }
}

export function ptcProcessPath(hostPath: string): string | undefined {
  const world = remoteWorldContext.getStore()
  if (world === undefined) return undefined
  const normalized = resolvePath(hostPath)
  return world.workerLocalPaths.some(path => resolvePath(path) === normalized) ? world.workerRemotePath : undefined
}
