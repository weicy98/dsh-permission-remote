/**
 * Thin remote routing layer for the official Node PTC runtime.
 *
 * This file deliberately contains no program runner and no frame protocol. It
 * translates the session's placeholder cwd into a remote cwd, uploads the
 * official worker, and runs the original `NodePtcRuntime.run` inside an
 * AsyncLocalStorage world. `remote-world.ts` owns the confine/spawn seams.
 */
import { posix } from 'node:path'
import type { HostConfig } from './config.ts'
import type { RunnerStatus } from './execute.ts'
import { remoteWorldContext, type RemoteWorld } from './remote-world.ts'
import { routeByCwd, workspaceBinding } from './router.ts'
import type { SecretMaterial, SshPool } from './ssh-pool.ts'
import type { UploadedWorker } from './upstream-worker.ts'

const MARK = Symbol.for('dsh-permission-remote.ptc-remote-wrap')
const REMOTE_NOTE = ' When the working directory is a remote workspace, the program runs on that SSH host and relative paths resolve there. Its process.env starts empty, exactly like local PTC. Per-call and retained modes use the host\'s official runtime; retained state remains on that SSH host.'

export type PtcFailureKind =
  | 'exception'
  | 'timeout'
  | 'abort'
  | 'worker-exit'
  | 'invalid-output'
  | 'output-limit'
  | 'protocol'
  | 'sandbox-unavailable'

export interface PtcBinding {
  readonly global: string
  readonly functions: Record<string, (args: unknown) => Promise<unknown>>
  readonly errorClass?: { readonly name: string, readonly memberNameProperty: string }
}

export interface PtcRunSpec {
  readonly program: string
  readonly cwd: string
  readonly timeoutMs: number | null
  readonly bindings?: readonly PtcBinding[]
  readonly stateOwner?: unknown
  readonly sandboxPolicy?: {
    readonly mode?: string
    readonly workspaceRoot?: string
    readonly additionalWritableRoots?: readonly string[]
    readonly sessionId?: string
  }
  readonly signal?: AbortSignal
}

export interface PtcFailure {
  readonly kind: PtcFailureKind
  readonly message: string
}

export interface PtcRunResult {
  readonly logs: string[]
  readonly value?: unknown
  readonly error?: PtcFailure
  readonly sandbox?: { readonly mode: string, readonly denied: boolean, readonly enforcement?: 'full' | 'partial' }
}

export interface PtcRuntimeLike {
  readonly programFormat: 'function-body' | 'repl' | 'script'
  run(spec: PtcRunSpec): Promise<PtcRunResult>
  readonly executionInstructions?: string
  readonly config?: {
    readonly launch?: {
      readonly kind?: string
      readonly executable?: string
      readonly bootstrapPath?: string
    }
  }
  [MARK]?: boolean
}

export interface RemotePtcDeps {
  readonly pool: SshPool
  hostOf(hostId: string): HostConfig | undefined
  secretOf(host: HostConfig): Promise<SecretMaterial>
  statusOf(host: HostConfig): Promise<RunnerStatus>
  ensureWorker(host: HostConfig, secret: SecretMaterial, status: RunnerStatus, signal?: AbortSignal): Promise<UploadedWorker>
  worldReady(): boolean
  fsReady(): boolean
  disposed?(): boolean
  env?: NodeJS.ProcessEnv
}

interface CordisLike {
  get(name: string): unknown
  on(name: 'internal/service', listener: (name: string, value: unknown) => void, options?: boolean | { prepend?: boolean, global?: boolean }): () => unknown
}

function failure(kind: PtcFailureKind, message: string): PtcRunResult {
  return { logs: [], error: { kind, message } }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRuntime(value: unknown): value is PtcRuntimeLike {
  if (typeof value !== 'object' || value === null) return false
  try {
    const candidate = value as PtcRuntimeLike
    return typeof candidate.run === 'function'
      && (candidate.programFormat === 'function-body'
        || candidate.programFormat === 'repl'
        || candidate.programFormat === 'script')
  } catch {
    return false
  }
}

function readInstructions(value: PtcRuntimeLike, own: PropertyDescriptor | undefined, inherited: PropertyDescriptor | undefined): string {
  try {
    if (own?.get !== undefined) return String(own.get.call(value) ?? '')
    if (inherited?.get !== undefined) return String(inherited.get.call(value) ?? '')
    return String(value.executionInstructions ?? '')
  } catch {
    return ''
  }
}

function installWrap(value: unknown, deps: RemotePtcDeps): (() => void) | undefined {
  if (!isRuntime(value) || value[MARK] === true) return undefined
  const ownRun = Object.hasOwn(value, 'run')
  const originalRun = value.run
  const ownInstructions = Object.getOwnPropertyDescriptor(value, 'executionInstructions')
  const inherited = ownInstructions ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), 'executionInstructions')
  value[MARK] = true
  value.run = spec => dispatch(value, originalRun, spec, deps)
  Object.defineProperty(value, 'executionInstructions', {
    configurable: true,
    enumerable: false,
    get() {
      return `${readInstructions(value, ownInstructions, inherited)}${REMOTE_NOTE}`
    },
  })
  return () => {
    if (ownRun) value.run = originalRun
    else delete (value as { run?: PtcRuntimeLike['run'] }).run
    if (ownInstructions !== undefined) Object.defineProperty(value, 'executionInstructions', ownInstructions)
    else delete (value as { executionInstructions?: string }).executionInstructions
    delete value[MARK]
  }
}

async function canonical(pool: SshPool, host: HostConfig, secret: SecretMaterial, remotePath: string, signal?: AbortSignal): Promise<string> {
  try {
    return await pool.sftpRealpath(host, secret, remotePath)
  } catch (error) {
    if (signal?.aborted === true) throw abortError()
    throw new Error(`remote workspace path ${JSON.stringify(remotePath)} could not be resolved: ${messageOf(error)}`)
  }
}

function abortError(): Error {
  const error = new Error('run_code was aborted')
  error.name = 'AbortError'
  return error
}

async function dispatch(
  runtime: PtcRuntimeLike,
  originalRun: PtcRuntimeLike['run'],
  spec: PtcRunSpec,
  deps: RemotePtcDeps,
): Promise<PtcRunResult> {
  if (typeof spec.cwd !== 'string' || spec.cwd.length === 0) {
    return failure('exception', 'run_code has no working directory, so the remote workspace could not be identified')
  }
  const env = deps.env ?? process.env
  const route = routeByCwd(spec.cwd, env)
  const policyRoot = spec.sandboxPolicy?.workspaceRoot
  const policyBinding = typeof policyRoot === 'string' ? workspaceBinding(policyRoot, env) : null
  if (route.kind !== 'remote') {
    // A remote session whose live cwd became unusable must not silently fall
    // back to a local process. If the session's pinned workspace is remote,
    // refuse instead.
    if (policyBinding !== null) {
      return failure('exception', 'run_code cwd is not inside the remote workspace; refusing to run on this computer')
    }
    // Clear an enclosing remote context so a nested local run cannot inherit
    // the outer host/worker mapping.
    return remoteWorldContext.run(undefined, () => originalRun.call(runtime, spec))
  }
  if (typeof policyRoot !== 'string' || policyRoot.length === 0) {
    return failure('exception', 'run_code did not include the session workspace root; refusing to run remotely without a pinned sandbox root')
  }
  if (policyBinding === null) {
    return failure('exception', 'run_code is only available when the Session was opened on that SSH host; this cwd is a remote placeholder but the session workspace is local')
  }
  if (policyBinding.hostId !== route.hostId) {
    return failure('exception', 'run_code session is opened on a different SSH host than its cwd')
  }
  if (deps.disposed?.() === true) return failure('abort', 'the SSH workspace plugin was unloaded, so the remote run_code was not started')

  const launch = runtime.config?.launch
  if (launch === undefined || (launch.kind !== undefined && launch.kind !== 'node-script')) {
    return failure('exception', 'Remote run_code requires the official Node PTC runtime with a node-script launch; the configured PTC runtime cannot be uploaded to the SSH host')
  }
  if (launch.bootstrapPath !== undefined) {
    return failure('exception', 'Remote run_code does not support an explicit PTC bootstrapPath. Remove launch.bootstrapPath so the plugin can map the host process.js to the uploaded worker')
  }
  if ((spec.sandboxPolicy?.additionalWritableRoots?.length ?? 0) > 0) {
    return failure('exception', 'Remote run_code does not support additional writable roots yet; use the workspace root or run locally')
  }
  if (spec.sandboxPolicy?.mode === undefined) {
    return failure('exception', 'run_code did not include a sandbox mode')
  }
  if (!deps.worldReady()) {
    return failure('exception', 'the remote PTC execution world is not installed: subprocess/sandbox services are unavailable')
  }
  if (!deps.fsReady()) {
    return failure('exception', 'the remote filesystem patch is not installed, so the PTC worker cannot be mapped to the SSH host')
  }

  const startedAt = Date.now()
  const budget = spec.timeoutMs
  const remaining = (): number | null => budget === null ? null : budget - (Date.now() - startedAt)
  const host = deps.hostOf(route.hostId)
  if (host === undefined) return failure('exception', `SSH host ${route.hostId} is not configured`)
  let secret: SecretMaterial
  let status: RunnerStatus
  try {
    secret = await deps.secretOf(host)
    status = await deps.statusOf(host)
  } catch (error) {
    return failure('exception', `the remote host could not be probed: ${messageOf(error)}`)
  }
  if (status.node?.available !== true) {
    const reason = status.node?.reason ?? 'missing'
    const version = status.node?.version === undefined ? '' : ` (found ${status.node.version})`
    return failure('exception', `remote run_code requires Node.js 22 or newer on ${host.host}; ${reason}${version}. Install Node on the remote host and probe again.`)
  }
  if (status.home.length === 0) {
    return failure('exception', 'the remote host did not report an absolute $HOME, so the PTC worker cannot be placed there')
  }
  if (budget !== null && remaining() !== null && remaining()! <= 0) {
    return failure('timeout', 'run_code timed out before the remote program started')
  }

  let uploaded: UploadedWorker
  try {
    uploaded = await deps.ensureWorker(host, secret, status, spec.signal)
  } catch (error) {
    if (spec.signal?.aborted === true) return failure('abort', 'run_code was aborted')
    return failure('worker-exit', `the PTC worker could not be uploaded to ${host.host}: ${messageOf(error)}`)
  }
  if (budget !== null && remaining() !== null && remaining()! <= 0) {
    return failure('timeout', 'run_code timed out while preparing the remote program')
  }
  let remoteCwd: string
  let remoteRoot: string
  try {
    remoteCwd = await canonical(deps.pool, host, secret, route.remoteCwd, spec.signal)
    remoteRoot = await canonical(deps.pool, host, secret, policyBinding.remotePath, spec.signal)
  } catch (error) {
    if (spec.signal?.aborted === true) return failure('abort', 'run_code was aborted')
    return failure('exception', messageOf(error))
  }
  const world: RemoteWorld = {
    host,
    secret,
    status,
    remoteCwd,
    remoteRoot,
    remoteNodePath: status.node.available === true ? status.node.path : '',
    remoteRipgrepPath: status.ripgrepPath,
    workerLocalPaths: uploaded.workerLocalPaths,
    workerRemotePath: uploaded.workerRemotePath,
    shimRemotePath: uploaded.shimRemotePath,
    launchExecutable: launch.executable ?? process.execPath,
  }
  const timeoutMs = budget === null ? null : Math.max(1, budget - (Date.now() - startedAt))
  return remoteWorldContext.run(world, () => originalRun.call(runtime, { ...spec, cwd: remoteCwd, timeoutMs }))
}

/** Wrap every official PTC runtime instance currently loaded or loaded later. */
export function attachRemotePtc(ctx: CordisLike, deps: RemotePtcDeps): () => void {
  const restores = new Map<object, () => void>()
  let stopped = false
  const wrap = (value: unknown): void => {
    if (stopped || typeof value !== 'object' || value === null) return
    const restore = installWrap(value, deps)
    if (restore === undefined) return
    restores.get(value)?.()
    restores.set(value, restore)
  }
  const current = ctx.get('ptcRuntime')
  if (current !== undefined && current !== null) wrap(current)
  const stop = ctx.on('internal/service', (name, value) => {
    if (name !== 'ptcRuntime' || value === undefined || value === null) return
    // NodePtcRuntime emits internal/service from super() before its own
    // programFormat/config fields are assigned. Defer past that stack.
    queueMicrotask(() => wrap(value))
  }, { global: true })
  return () => {
    stopped = true
    stop()
    for (const restore of restores.values()) restore()
    restores.clear()
  }
}
