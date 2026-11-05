/**
 * Remote execution-world adapters for the official PTC runtime.
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
 * The adapters are scoped by AsyncLocalStorage and by the presence of the
 * current run's worker path. Local calls, bash and the search tools keep using
 * the original services untouched.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { posix, resolve as resolvePath } from 'node:path'
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
import { bwrapFileProfileArgs, fileWritableRoots, seatbeltProfileArgs } from './profile.ts'
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
  readonly workerLocalPaths: readonly string[]
  readonly workerRemotePath: string
  readonly shimRemotePath: string
  readonly launchExecutable: string
  resolvedLocalExecutable?: string
}

export const remoteWorldContext = new AsyncLocalStorage<RemoteWorld | undefined>()

export interface RemoteWorldDeps {
  readonly transport: RemoteTransport
  readonly hostOf: (hostId: string) => HostConfig | undefined
  readonly secretOf: (host: HostConfig) => Promise<SecretMaterial>
  readonly statusOf: (host: HostConfig) => Promise<RunnerStatus>
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
    this.socketPath = `${posix.dirname(world.workerRemotePath)}/run-${randomBytes(6).toString('hex')}.sock`
    void this.start()
  }

  private fail(error: Error): void {
    if (this.settled) return
    this.settled = true
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer)
    this.rejectHandshake?.(error)
    this.rejectHandshake = undefined
    this.stdout.end()
    this.stderr.end()
    this.control.fail(error)
    this.forward?.destroy()
    this.exec?.close()
    this.rejectDone(error)
  }

  private finish(result: ExecResult): void {
    if (this.settled) return
    this.settled = true
    if (this.handshakeTimer !== undefined) clearTimeout(this.handshakeTimer)
    if (!this.ready) {
      this.rejectHandshake?.(new Error('PTC worker exited before the control-channel handshake'))
      this.rejectHandshake = undefined
    }
    this.stdout.end()
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
      this.exec.stdout.on('data', chunk => {
        if (!this.settled) this.stdout.write(chunk)
      })
      this.exec.stderr.on('data', chunk => this.consumeStderr(chunk))
      this.exec.write(`${this.token}\n`)
      this.exec.done.then(
        result => this.finish(result),
        error => this.fail(error instanceof Error ? error : new Error(String(error))),
      )
      this.handshakeTimer = setTimeout(() => this.fail(new Error('PTC shim did not print a control-channel handshake')), 10_000)
      const endpoint = await this.waitForHandshake()
      let forward: Duplex | undefined
      if (endpoint.unixPath !== undefined) {
        try {
          forward = await this.transport.forwardOutStreamLocal(this.world.host, this.world.secret, endpoint.unixPath, this.spec.signal)
        } catch (error) {
          if (endpoint.tcpPort === undefined) throw error
        }
      }
      if (forward === undefined && endpoint.tcpPort !== undefined) {
        forward = await this.transport.forwardOutTcp(this.world.host, this.world.secret, '127.0.0.1', endpoint.tcpPort, this.spec.signal)
      }
      if (forward === undefined) throw new Error('PTC shim reported no usable forwarding endpoint')
      this.forward = forward
      if (this.settled) {
        forward.destroy()
        return
      }
      this.control.attach(forward)
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

  terminate(): void {
    if (this.settled) return
    this.exec?.close()
    this.forward?.destroy()
  }

  waitForExit(): Promise<boolean> {
    return this.done.then(() => true, () => false)
  }
}

/** Install the PTC-only patches on the deployment's sandbox/subprocess services. */
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
    if (world === undefined || spec.stdio?.control !== 'pipe') return originalSpawn.call(subprocess, spec)
    return new RemotePtcHandle(world, spec, deps.transport)
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
    const world = remoteWorldContext.getStore()
    if (world === undefined || !argv.includes(world.workerRemotePath)) {
      return originalConfine.call(sandbox, argv, policy, signal)
    }
    signal?.throwIfAborted()
    if (!world.status.sandbox.available || world.status.sandboxTool === 'none') {
      throw new SandboxUnavailableError(policy.mode, 'remote sandbox probe failed')
    }
    const roots = {
      workspaceRoot: world.remoteRoot,
      tmp: world.status.roots.tmp,
      userTmp: world.status.roots.userTmp,
    }
    const mapped = argv.map((value, index) => index === 0 ? remoteExecutable(world, value) : value)
    if (world.status.sandboxTool === 'bwrap') {
      const profile = bwrapFileProfileArgs(policy.mode, roots) ?? []
      return {
        argv: ['bwrap', ...profile, '--chdir', world.remoteCwd, '--', ...mapped],
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
