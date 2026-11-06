import assert from 'node:assert/strict'
import { existsSync, utimesSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RunnerStatus } from '../src/execute.ts'
import { attachRemotePtc, isRemotePtcRuntime, type PtcRunResult, type PtcRunSpec, type RemotePtcDeps } from '../src/ptc-remote.ts'
import { disposeSpillDirectory, installRemoteWorld, pruneSpillDirectory, remoteWorldContext, sharedSpillDirectory } from '../src/remote-world.ts'
import { mapRemoteToLocal } from '../src/router.ts'

const host = {
  id: 'h1', name: '', host: '127.0.0.1', port: 22, username: 'u', auth: 'key' as const,
  privateKeyPath: '', fingerprint: '', opsPolicy: 'ask' as const,
}

function runtime() {
  return {
    calls: 0,
    programFormat: 'function-body' as const,
    executionInstructions: 'base instructions',
    config: { launch: { kind: 'node-script', executable: process.execPath } },
    async run(_spec: PtcRunSpec): Promise<PtcRunResult> {
      this.calls += 1
      return { logs: ['local'] }
    },
  }
}

function deps(env: NodeJS.ProcessEnv): RemotePtcDeps {
  return {
    pool: {} as never,
    hostOf: id => id === 'h1' ? host : undefined,
    secretOf: async () => ({}),
    statusOf: async () => { throw new Error('should not probe a configured host without a world') },
    ensureWorker: async () => { throw new Error('should not upload without a world') },
    worldReady: () => false,
    fsReady: () => false,
    env,
  }
}

test('a local cwd reaches the original runtime and remote preflight fails closed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-remote-'))
  const env = { DSH_HOME: home }
  const placeholder = mapRemoteToLocal('h1', '/srv/app', env)!
  const value = runtime()
  const restore = attachRemotePtc({ get: name => name === 'ptcRuntime' ? value : undefined, on: () => () => undefined }, deps(env))
  try {
    assert.deepEqual(await value.run({ program: 'return 1', cwd: '/tmp/local', timeoutMs: 1000, bindings: [], sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/tmp/local' } }), { logs: ['local'] })
    const remote = await value.run({ program: 'return 1', cwd: placeholder, timeoutMs: 1000, bindings: [], sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: placeholder } })
    assert.equal(remote.error?.kind, 'exception')
    assert.match(remote.error?.message ?? '', /execution world is not installed/u)
    assert.match(value.executionInstructions, /remote workspace/u)
    assert.equal(value.calls, 1)
  } finally {
    restore()
    await rm(home, { recursive: true, force: true })
  }
  assert.equal(value.executionInstructions, 'base instructions')
})


test('a local session cannot use working_directory to run code on a remote host', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-remote-gate-'))
  const env = { DSH_HOME: home }
  const placeholder = mapRemoteToLocal('h1', '/srv/app', env)!
  const value = runtime()
  const restore = attachRemotePtc({ get: name => name === 'ptcRuntime' ? value : undefined, on: () => () => undefined }, deps(env))
  try {
    const result = await value.run({
      program: 'return 1',
      cwd: placeholder,
      timeoutMs: 1000,
      bindings: [],
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/tmp/local-project' },
    })
    assert.equal(result.error?.kind, 'exception')
    assert.match(result.error?.message ?? '', /Session was opened on that SSH host/u)
    assert.equal(value.calls, 0)
  } finally {
    restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('run_code refuses a policy root belonging to a different SSH host', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-remote-gate-'))
  const env = { DSH_HOME: home }
  const placeholder = mapRemoteToLocal('h1', '/srv/app', env)!
  const other = mapRemoteToLocal('h2', '/srv/app', env)!
  const value = runtime()
  const restore = attachRemotePtc({ get: name => name === 'ptcRuntime' ? value : undefined, on: () => () => undefined }, deps(env))
  try {
    const result = await value.run({ program: 'return 1', cwd: placeholder, timeoutMs: 1000, bindings: [], sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: other } })
    assert.equal(result.error?.kind, 'exception')
    assert.match(result.error?.message ?? '', /different SSH host/u)
    assert.equal(value.calls, 0)
  } finally {
    restore()
    await rm(home, { recursive: true, force: true })
  }
})


test('a cd-to-root cwd still pins the sandbox root to the session workspace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-remote-root-'))
  const env = { DSH_HOME: home }
  const workspace = mapRemoteToLocal('h1', '/srv/app', env)!
  const rootCwd = mapRemoteToLocal('h1', '/', env)!
  const captured: Array<{ remoteCwd: string, remoteRoot: string }> = []
  const value = runtime()
  value.run = async (spec: PtcRunSpec) => {
    const world = remoteWorldContext.getStore()
    if (world !== undefined) captured.push({ remoteCwd: world.remoteCwd, remoteRoot: world.remoteRoot })
    return { logs: [String(spec.cwd)] }
  }
  const base = deps(env)
  const custom: RemotePtcDeps = {
    ...base,
    worldReady: () => true,
    fsReady: () => true,
    pool: { sftpRealpath: async (_host: unknown, _secret: unknown, path: string) => path } as never,
    statusOf: async () => ({
      os: 'linux', sandbox: { available: true, reason: 'ok' }, sandboxTool: 'bwrap',
      ripgrep: 'system', ripgrepPath: '/usr/bin/rg', roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
      home: '/home/dev', node: { available: true, path: '/usr/bin/node', version: '22.20.0', major: 22 }, install: null,
    }),
    ensureWorker: async () => ({
      workerLocalPaths: ['/host/process.js'], workerRemotePath: '/home/dev/process.mjs',
shimRemotePath: '/home/dev/ptc-shim.mjs', digest: 'x',
    }),
  }
  const restore = attachRemotePtc({ get: name => name === 'ptcRuntime' ? value : undefined, on: () => () => undefined }, custom)
  try {
    const result = await value.run({ program: 'return 1', cwd: rootCwd, timeoutMs: 1000, bindings: [], sandboxPolicy: { mode: 'workspace-write', workspaceRoot: workspace } })
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(captured, [{ remoteCwd: '/', remoteRoot: '/srv/app' }])
  } finally {
    restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('isRemotePtcRuntime tracks the wrap on the instance in hand', () => {
  const value = runtime()
  assert.equal(isRemotePtcRuntime(value), false, 'an unwrapped runtime must not report as wrapped')
  assert.equal(isRemotePtcRuntime({}), false)
  assert.equal(isRemotePtcRuntime(undefined), false)
  assert.equal(isRemotePtcRuntime(null), false)

  const restore = attachRemotePtc({ get: name => name === 'ptcRuntime' ? value : undefined, on: () => () => undefined }, deps({}))
  assert.equal(isRemotePtcRuntime(value), true, 'a wrapped runtime must report as wrapped')
  assert.equal(restore.installed, true)

  restore()
  assert.equal(isRemotePtcRuntime(value), false, 'detach must clear the mark')
  assert.equal(restore.installed, false, 'installed must not outlive the wraps it describes')
})

test('a replacement runtime instance is not reported as wrapped', () => {
  // The guard in index.ts asks about the instance the service holds now. A new
  // instance the plugin never saw must read as unwrapped even though an earlier
  // wrap succeeded, which the sticky-flag version got wrong.
  const first = runtime()
  const restore = attachRemotePtc({ get: name => name === 'ptcRuntime' ? first : undefined, on: () => () => undefined }, deps({}))
  try {
    assert.equal(restore.installed, true)
    assert.equal(isRemotePtcRuntime(runtime()), false, 'a fresh instance must not inherit the earlier result')
  } finally {
    restore()
  }
})

/** A service whose current instance can be replaced, and whose wraps can be collected. */
function service(initial: unknown) {
  let current = initial
  let listener: ((name: string, value: unknown) => void) | undefined
  const ctx = {
    get: (name: string) => name === 'ptcRuntime' ? current : undefined,
    on: (name: string, fn: (event: string, value: unknown) => void) => {
      if (name === 'internal/service') listener = fn
      return () => undefined
    },
  }
  return {
    ctx,
    set(value: unknown) { current = value },
    emit(value: unknown) { listener?.('ptcRuntime', value) },
    current: () => current,
  }
}

function recordingDeps(env: NodeJS.ProcessEnv): { deps: RemotePtcDeps, warnings: string[] } {
  const warnings: string[] = []
  return { deps: { ...deps(env), logger: { warn: (message: string) => { warnings.push(message) } } }, warnings }
}

test('a frozen PTC runtime is refused without failing the plugin load', () => {
  const value = Object.freeze(runtime())
  const { deps: watched, warnings } = recordingDeps({})
  const restore = attachRemotePtc(service(value).ctx, watched)
  try {
    assert.equal(restore.installed, false, 'no wrap may be recorded for a frozen instance')
    assert.equal(isRemotePtcRuntime(value), false)
    assert.equal(warnings.length, 1, 'a refusal must be logged')
    assert.match(warnings[0]!, /wrap failed/u)
  } finally {
    restore()
  }
})

test('a getter-only run leaves no fail-open mark on an unwrapped runtime', () => {
  const value = runtime()
  const original = value.run
  Object.defineProperty(value, 'run', { configurable: true, enumerable: true, get: () => original })
  const { deps: watched, warnings } = recordingDeps({})
  const restore = attachRemotePtc(service(value).ctx, watched)
  try {
    // This is the fail-open regression: the old code set MARK before assigning
    // `run`, so a TypeError left an unwrapped instance claiming to be wrapped.
    assert.equal(isRemotePtcRuntime(value), false, 'MARK must never survive a partial wrap')
    assert.equal(restore.installed, false)
    assert.notEqual(Object.getOwnPropertyDescriptor(value, 'run')?.get, undefined, 'run must remain the original getter')
    assert.equal(value.executionInstructions, 'base instructions')
    assert.equal(warnings.length, 1)
  } finally {
    restore()
  }
})

test('a failure at the third wrap mutation rolls back run and the mark', async () => {
  const value = runtime()
  const original = value.run
  const hostile = new Proxy(value, {
    defineProperty(target, property, descriptor) {
      if (property === 'executionInstructions') throw new TypeError('defineProperty blocked')
      return Reflect.defineProperty(target, property, descriptor)
    },
  })
  const { deps: watched, warnings } = recordingDeps({})
  const restore = attachRemotePtc(service(hostile).ctx, watched)
  try {
    assert.equal(isRemotePtcRuntime(hostile), false, 'the mark must be rolled back')
    assert.equal(restore.installed, false)
    assert.equal(hostile.run, original, 'run must be restored after a late failure')
    assert.equal(hostile.executionInstructions, 'base instructions')
    assert.equal(warnings.length, 1)
    assert.deepEqual(await hostile.run({ program: 'return 1', cwd: '/tmp/local', timeoutMs: 1000, bindings: [], sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/tmp/local' } }), { logs: ['local'] })
  } finally {
    restore()
  }
})

test('a throwing executionInstructions getter is contained by the installed getter', () => {
  const value = runtime()
  Object.defineProperty(value, 'executionInstructions', {
    configurable: true,
    enumerable: false,
    get() { throw new Error('instructions unavailable') },
  })
  const restore = attachRemotePtc(service(value).ctx, deps({}))
  try {
    assert.equal(isRemotePtcRuntime(value), true, 'this shape is still wrappable')
    assert.doesNotThrow(() => value.executionInstructions)
    assert.match(value.executionInstructions, /remote workspace/u)
  } finally {
    restore()
  }
})

test('a failed wrap in the internal/service microtask is contained', async () => {
  const svc = service(undefined)
  const { deps: watched, warnings } = recordingDeps({})
  const detach = attachRemotePtc(svc.ctx, watched)
  const uncaught: unknown[] = []
  const onUncaught = (error: unknown) => { uncaught.push(error) }
  process.on('uncaughtException', onUncaught)
  try {
    svc.emit(Object.freeze(runtime()))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(uncaught, [], 'no exception may escape a microtask wrap')
    assert.equal(warnings.length, 1)
    assert.equal(detach.installed, false)
  } finally {
    process.off('uncaughtException', onUncaught)
    detach()
  }
})

test('a failed replacement cannot fail the guard open when an earlier wrap succeeded', async () => {
  const first = runtime()
  // A frozen object fails at the FIRST mutation, so MARK is never set. The real
  // fail-open shape is one that fails at the SECOND: the old code set MARK
  // before assigning `run`, leaving an unwrapped instance claiming a wrap.
  const second = runtime()
  const originalSecond = second.run
  Object.defineProperty(second, 'run', { configurable: true, enumerable: true, get: () => originalSecond })
  const svc = service(first)
  const { deps: watched } = recordingDeps({})
  const detach = attachRemotePtc(svc.ctx, watched)
  try {
    assert.equal(detach.installed, true, 'the first instance must be wrapped')
    svc.set(second)
    svc.emit(second)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(isRemotePtcRuntime(second), false, 'the failed instance must not carry the mark')
    // index.ts computes ptcReady() as `installed && isRemotePtcRuntime(current)`.
    assert.equal(detach.installed && isRemotePtcRuntime(svc.current()), false, 'a stale wrap must not let run_code fall through to the local runtime')
  } finally {
    detach()
  }
})

test('a missing-Node failure invalidates the cached probe so the next run re-probes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-probe-'))
  const env = { DSH_HOME: home }
  const placeholder = mapRemoteToLocal('h1', '/srv/app', env)!
  const value = runtime()
  const ready: RunnerStatus = {
    os: 'linux', sandbox: { available: true, reason: 'ok' }, sandboxTool: 'bwrap',
    ripgrep: 'system', ripgrepPath: '/usr/bin/rg', roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
    home: '/home/dev', node: { available: true, path: '/usr/bin/node', version: '22.20.0', major: 22 }, install: null,
  }
  const missing: RunnerStatus = { ...ready, node: { available: false, reason: 'missing' } }
  let probes = 0
  let cached: RunnerStatus | undefined
  const forgotten: string[] = []
  const custom: RemotePtcDeps = {
    ...deps(env),
    worldReady: () => true,
    fsReady: () => true,
    pool: { sftpRealpath: async (_host: unknown, _secret: unknown, path: string) => path } as never,
    statusOf: async () => {
      if (cached === undefined) {
        probes += 1
        // The second probe sees the externally installed Node.
        cached = probes === 1 ? missing : ready
      }
      return cached
    },
    ensureWorker: async () => ({
      workerLocalPaths: ['/host/process.js'], workerRemotePath: '/home/dev/process.mjs',
      shimRemotePath: '/home/dev/ptc-shim.mjs', digest: 'x',
    }),
    forgetProbe: id => { forgotten.push(id); cached = undefined },
  }
  const restore = attachRemotePtc(service(value).ctx, custom)
  const spec = {
    program: 'return 1', cwd: placeholder, timeoutMs: 1000, bindings: [],
    sandboxPolicy: { mode: 'workspace-write', workspaceRoot: placeholder },
  }
  try {
    const first = await value.run(spec)
    assert.equal(first.error?.kind, 'exception')
    assert.match(first.error?.message ?? '', /Install Node/u)
    assert.match(first.error?.message ?? '', /Test connection/u, 'the message must name a real recovery action')
    assert.deepEqual(forgotten, ['h1'], 'the stale probe must be invalidated')
    assert.equal(probes, 1)

    const second = await value.run(spec)
    assert.equal(second.error, undefined, JSON.stringify(second))
    assert.equal(probes, 2, 'the second attempt must re-probe')
    assert.equal(value.calls, 1, 'the re-probed run must reach the runtime')
  } finally {
    restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('a sandbox-unavailable result also invalidates the cached probe', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-probe-sandbox-'))
  const env = { DSH_HOME: home }
  const placeholder = mapRemoteToLocal('h1', '/srv/app', env)!
  const value = runtime()
  value.run = async () => ({ logs: [], error: { kind: 'sandbox-unavailable', message: 'remote sandbox probe failed' } })
  const forgotten: string[] = []
  const custom: RemotePtcDeps = {
    ...deps(env),
    worldReady: () => true,
    fsReady: () => true,
    pool: { sftpRealpath: async (_host: unknown, _secret: unknown, path: string) => path } as never,
    statusOf: async () => ({
      os: 'linux', sandbox: { available: true, reason: 'ok' }, sandboxTool: 'bwrap',
      ripgrep: 'system', ripgrepPath: '/usr/bin/rg', roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
      home: '/home/dev', node: { available: true, path: '/usr/bin/node', version: '22.20.0', major: 22 }, install: null,
    }),
    ensureWorker: async () => ({
      workerLocalPaths: ['/host/process.js'], workerRemotePath: '/home/dev/process.mjs',
      shimRemotePath: '/home/dev/ptc-shim.mjs', digest: 'x',
    }),
    forgetProbe: id => { forgotten.push(id) },
  }
  const restore = attachRemotePtc(service(value).ctx, custom)
  try {
    const result = await value.run({
      program: 'return 1', cwd: placeholder, timeoutMs: 1000, bindings: [],
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: placeholder },
    })
    assert.equal(result.error?.kind, 'sandbox-unavailable')
    assert.deepEqual(forgotten, ['h1'], 'a bwrap install is only discovered by a fresh probe')
  } finally {
    restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('a failed run on a host whose probe lacks ripgrep invalidates the cached probe', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-probe-rg-'))
  const env = { DSH_HOME: home }
  const placeholder = mapRemoteToLocal('h1', '/srv/app', env)!
  const value = runtime()
  value.run = async () => ({ logs: [], error: { kind: 'exception', message: 'rg: command not found' } })
  const forgotten: string[] = []
  const custom: RemotePtcDeps = {
    ...deps(env),
    worldReady: () => true,
    fsReady: () => true,
    pool: { sftpRealpath: async (_host: unknown, _secret: unknown, path: string) => path } as never,
    statusOf: async () => ({
      os: 'linux', sandbox: { available: true, reason: 'ok' }, sandboxTool: 'bwrap',
      ripgrep: 'missing', ripgrepPath: '', roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
      home: '/home/dev', node: { available: true, path: '/usr/bin/node', version: '22.20.0', major: 22 }, install: null,
    }),
    ensureWorker: async () => ({
      workerLocalPaths: ['/host/process.js'], workerRemotePath: '/home/dev/process.mjs',
      shimRemotePath: '/home/dev/ptc-shim.mjs', digest: 'x',
    }),
    forgetProbe: id => { forgotten.push(id) },
  }
  const restore = attachRemotePtc(service(value).ctx, custom)
  try {
    const result = await value.run({
      program: 'return 1', cwd: placeholder, timeoutMs: 1000, bindings: [],
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: placeholder },
    })
    assert.equal(result.error?.kind, 'exception')
    assert.deepEqual(forgotten, ['h1'], 'a ripgrep install is only discovered by a fresh probe')
  } finally {
    restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('a failed run on a host whose probe reports upload-failed ripgrep also re-probes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-probe-rg-upload-'))
  const env = { DSH_HOME: home }
  const placeholder = mapRemoteToLocal('h1', '/srv/app', env)!
  const value = runtime()
  value.run = async () => ({ logs: [], error: { kind: 'exception', message: 'rg: command not found' } })
  const forgotten: string[] = []
  const custom: RemotePtcDeps = {
    ...deps(env),
    worldReady: () => true,
    fsReady: () => true,
    pool: { sftpRealpath: async (_host: unknown, _secret: unknown, path: string) => path } as never,
    statusOf: async () => ({
      os: 'linux', sandbox: { available: true, reason: 'ok' }, sandboxTool: 'bwrap',
      ripgrep: 'upload-failed', ripgrepPath: '', roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
      home: '/home/dev', node: { available: true, path: '/usr/bin/node', version: '22.20.0', major: 22 }, install: null,
    }),
    ensureWorker: async () => ({
      workerLocalPaths: ['/host/process.js'], workerRemotePath: '/home/dev/process.mjs',
      shimRemotePath: '/home/dev/ptc-shim.mjs', digest: 'x',
    }),
    forgetProbe: id => { forgotten.push(id) },
  }
  const restore = attachRemotePtc(service(value).ctx, custom)
  try {
    const result = await value.run({
      program: 'return 1', cwd: placeholder, timeoutMs: 1000, bindings: [],
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: placeholder },
    })
    assert.equal(result.error?.kind, 'exception')
    assert.deepEqual(forgotten, ['h1'], 'a failed ripgrep upload is retried by a fresh probe')
  } finally {
    restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('the remote-world disposer removes an empty spill directory on unload', () => {
  const directory = sharedSpillDirectory()
  assert.equal(existsSync(directory), true)
  const subprocess = { spawn() {}, resolveExecutable() {} }
  const sandbox = { confine() {} }
  const remove = installRemoteWorld(
    { get: (name: string) => name === 'subprocess' ? subprocess : name === 'sandbox' ? sandbox : undefined },
    {
      transport: {} as never,
      hostOf: () => undefined,
      secretOf: async () => ({}),
      statusOf: async () => ({} as never),
      routeByCwd: () => ({ kind: 'local' } as const),
    },
  )
  assert.equal(typeof remove, 'function')
  remove!()
  assert.equal(existsSync(directory), false, 'an empty per-process temp dir must not survive unload')
  assert.doesNotThrow(() => disposeSpillDirectory(), 'cleanup is idempotent')
})

test('spill retention keeps only the newest artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-spill-prune-'))
  try {
    for (let i = 0; i < 10; i += 1) {
      const path = join(directory, `stream-${i}.log`)
      await writeFile(path, `data-${i}`)
      // Explicit distinct mtimes: writeFile can land in the same millisecond.
      const time = new Date(1_700_000_000_000 + i * 1_000)
      utimesSync(path, time, time)
    }
    pruneSpillDirectory(directory, undefined, { files: 3, bytes: 1_000_000 })
    assert.deepEqual((await readdir(directory)).sort(), ['stream-7.log', 'stream-8.log', 'stream-9.log'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('spill retention also bounds total bytes and never deletes the current file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-spill-bytes-'))
  try {
    for (let i = 0; i < 5; i += 1) {
      const path = join(directory, `stream-${i}.log`)
      await writeFile(path, 'x'.repeat(6))
      const time = new Date(1_700_000_000_000 + i * 1_000)
      utimesSync(path, time, time)
    }
    // Keep the newest file (index 4) even though it alone would exceed a tiny
    // byte budget; older files are pruned until the remainder fits.
    pruneSpillDirectory(directory, join(directory, 'stream-4.log'), { files: 100, bytes: 12 })
    assert.deepEqual((await readdir(directory)).sort(), ['stream-3.log', 'stream-4.log'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a spill directory holding recovery artifacts survives unload', async () => {
  const directory = sharedSpillDirectory()
  const artifact = join(directory, 'stream-1.log')
  await writeFile(artifact, 'full output')
  disposeSpillDirectory()
  try {
    assert.equal(existsSync(artifact), true, 'advertised spill files must remain readable')
    assert.equal(existsSync(directory), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
