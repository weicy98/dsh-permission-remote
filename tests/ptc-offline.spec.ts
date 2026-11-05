import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { NodePtcRuntime } from '@deepseek-ai/dsh-ptc-runtime-node'
import { attachRemotePtc, type PtcRunResult, type RemotePtcDeps } from '../src/ptc-remote.ts'
import { installRemoteWorld } from '../src/remote-world.ts'
import { LocalTransport } from './helpers/local-ptc.ts'
import { mapRemoteToLocal } from '../src/router.ts'
import type { RunnerStatus } from '../src/execute.ts'

const require = createRequire(import.meta.url)
const WORKER_PACKAGE = dirname(require.resolve('@deepseek-ai/dsh-ptc-runtime-node/package.json'))
const HOST_PROCESS_JS = join(WORKER_PACKAGE, 'lib', 'process.js')
const SHIM = fileURLToPath(new URL('../src/ptc-shim.mjs', import.meta.url))

interface Harness {
  readonly runtime: NodePtcRuntime
  readonly placeholder: string
  readonly remoteRoot: string
  readonly dispose: () => Promise<void>
  readonly status: RunnerStatus
}

async function harness(
  mode: 'danger-full-access' | 'workspace-write' = 'danger-full-access',
  executionMode: 'per-call' | 'persistent-in-memory' | 'vm-script' = 'per-call',
  scriptPersistence = false,
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-home-'))
  const remoteRoot = await mkdtemp(join(tmpdir(), 'dsh-ptc-root-'))
  const workerRemote = join(remoteRoot, 'process.mjs')
  await copyFile(HOST_PROCESS_JS, workerRemote)
  const env = { DSH_HOME: home }
  const placeholder = mapRemoteToLocal('h1', remoteRoot, env)!
  const status: RunnerStatus = {
    os: 'linux',
    sandbox: { available: mode !== 'danger-full-access', reason: mode === 'danger-full-access' ? 'missing' : 'ok' },
    sandboxTool: mode === 'danger-full-access' ? 'none' : 'bwrap',
    ripgrep: 'system',
    ripgrepPath: '/usr/bin/rg',
    roots: { workspaceRoot: remoteRoot, tmp: tmpdir(), userTmp: tmpdir() },
    home,
    node: { available: true, path: process.execPath, version: process.version.slice(1), major: Number(process.version.slice(1).split('.')[0]) },
    install: null,
  }
  const fs = {
    processPathFromHostPath: (hostPath: string) => hostPath === HOST_PROCESS_JS ? workerRemote : hostPath,
  }
  const subprocess = {
    async resolveExecutable(command: string) { return command },
    spawn() { throw new Error('remote-world did not patch subprocess.spawn') },
  }
  const sandbox = {
    async confine(argv: readonly string[]) {
      return { argv, enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }
    },
  }
  const ctx = new Context()
  ctx.provide('fs', fs)
  ctx.provide('subprocess', subprocess)
  ctx.provide('sandbox', sandbox)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: remoteRoot }),
  })
  await ctx.plugin(NodePtcRuntime, {
    executionMode,
    scriptPersistence,
    timeoutMs: 120_000,
    maxTimeoutMs: 600_000,
    maxOutputBytes: 1_000_000,
    maxOldGenerationSizeMb: 256,
    maxMessageBytes: 1_000_000,
    maxPendingCalls: 8,
    graceMs: 1000,
    launch: { kind: 'node-script', executable: process.execPath },
  })
  const runtime = ctx.get('ptcRuntime') as NodePtcRuntime
  const transport = new LocalTransport()
  const restoreWorld = installRemoteWorld(ctx as unknown as { get(name: string): unknown }, {
    transport,
    hostOf: id => id === 'h1' ? {
      id: 'h1', name: '', host: '127.0.0.1', port: 22, username: 'u', auth: 'key',
      privateKeyPath: '', fingerprint: '', opsPolicy: 'ask',
    } : undefined,
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === placeholder ? { kind: 'remote', hostId: 'h1', remoteCwd: remoteRoot, placeholderCwd: placeholder } : { kind: 'local' },
  })
  assert.ok(restoreWorld !== undefined)
  const deps: RemotePtcDeps = {
    pool: { sftpRealpath: async (_host: unknown, _secret: unknown, remotePath: string) => remotePath } as never,
    hostOf: id => id === 'h1' ? {
      id: 'h1', name: '', host: '127.0.0.1', port: 22, username: 'u', auth: 'key',
      privateKeyPath: '', fingerprint: '', opsPolicy: 'ask',
    } : undefined,
    secretOf: async () => ({}),
    statusOf: async () => status,
    ensureWorker: async () => ({
      workerLocalPaths: [HOST_PROCESS_JS],
      workerRemotePath: workerRemote,
      persistentWorkerRemotePath: join(remoteRoot, 'persistent-process.mjs'),
      shimRemotePath: SHIM,
      digest: 'test',
    }),
    worldReady: () => true,
    fsReady: () => true,
    env,
  }
  const detach = attachRemotePtc({
    get: name => name === 'ptcRuntime' ? runtime : undefined,
    on: () => () => undefined,
  }, deps)
  return {
    runtime,
    placeholder,
    remoteRoot,
    status,
    dispose: async () => {
      detach()
      restoreWorld()
      await rm(home, { recursive: true, force: true })
      await rm(remoteRoot, { recursive: true, force: true })
    },
  }
}

test('the official Node runtime executes return and logs through the shim', async () => {
  const h = await harness()
  try {
    const spec = h.runtime.resolve({
      program: 'console.log("hello remote"); return 1 + 1',
      cwd: h.placeholder,
      timeoutMs: 10_000,
      bindings: [],
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: h.placeholder },
    })
    const result = await h.runtime.run(spec)
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(result.value, 2)
    assert.deepEqual(result.logs, ['hello remote'])
  } finally {
    await h.dispose()
  }
})


test('a long-running PTC program survives the handshake timeout window', async () => {
  const h = await harness('danger-full-access')
  try {
    const result = await h.runtime.run(h.runtime.resolve({
      program: 'await new Promise(resolve => setTimeout(resolve, 11_000)); return "alive"',
      cwd: h.placeholder,
      timeoutMs: 30_000,
      bindings: [],
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: h.placeholder },
    }))
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.equal(result.value, 'alive')
  } finally {
    await h.dispose()
  }
})

test('the official runtime runs tools.* through the host binding bridge', async () => {
  const h = await harness()
  try {
    const spec = h.runtime.resolve({
      program: 'const n = await tools.echo({ value: 41 }); return { n }',
      cwd: h.placeholder,
      timeoutMs: 10_000,
      bindings: [{
        global: 'tools',
        functions: { echo: async (args) => ({ value: Number((args as { value?: number }).value ?? 0) + 1 }) },
        errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
      }],
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: h.placeholder },
    })
    const result = await h.runtime.run(spec)
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(result.value, { n: { value: 42 } })
  } finally {
    await h.dispose()
  }
})

test('the remote cwd is the session cwd and process.env is empty', async () => {
  const h = await harness()
  try {
    const spec = h.runtime.resolve({
      program: 'return { cwd: process.cwd(), keys: Object.keys(process.env), hasHome: "HOME" in process.env }',
      cwd: h.placeholder,
      timeoutMs: 10_000,
      bindings: [],
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: h.placeholder },
    })
    const result = await h.runtime.run(spec)
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(result.value, { cwd: h.remoteRoot, keys: [], hasHome: false })
  } finally {
    await h.dispose()
  }
})

test('workspace-write is enforced by the remote bwrap profile', async () => {
  const h = await harness('workspace-write')
  try {
    const spec = h.runtime.resolve({
      program: 'const fs = await import("node:fs"); fs.writeFileSync("proof.txt", "remote"); return { cwd: process.cwd(), text: fs.readFileSync("proof.txt", "utf8") }',
      cwd: h.placeholder,
      timeoutMs: 20_000,
      bindings: [],
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: h.placeholder },
    })
    const result = await h.runtime.run(spec)
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(result.value, { cwd: h.remoteRoot, text: 'remote' })
    assert.equal(await readFile(join(h.remoteRoot, 'proof.txt'), 'utf8'), 'remote')
  } finally {
    await h.dispose()
  }
})

test('timeout and abort terminate the remote shim process group', async () => {
  const h = await harness()
  try {
    const timeout = h.runtime.resolve({
      program: 'await new Promise(resolve => setTimeout(resolve, 10_000)); return 1',
      cwd: h.placeholder,
      timeoutMs: 150,
      bindings: [],
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: h.placeholder },
    })
    const timed = await h.runtime.run(timeout)
    assert.equal(timed.error?.kind, 'timeout', JSON.stringify(timed))

    const controller = new AbortController()
    const aborted = h.runtime.resolve({
      program: 'await new Promise(resolve => setTimeout(resolve, 10_000)); return 1',
      cwd: h.placeholder,
      timeoutMs: 20_000,
      bindings: [],
      signal: controller.signal,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: h.placeholder },
    })
    setTimeout(() => controller.abort('test cancel'), 150)
    const cancelled = await h.runtime.run(aborted)
    assert.equal(cancelled.error?.kind, 'abort', JSON.stringify(cancelled))
  } finally {
    await h.dispose()
  }
})


test('persistent-in-memory retains state for one state owner', async () => {
  const h = await harness('danger-full-access', 'persistent-in-memory')
  const owner = {}
  try {
    const first = await h.runtime.run(h.runtime.resolve({
      program: 'var retained = 41\nretained',
      cwd: h.placeholder,
      timeoutMs: 20_000,
      bindings: [],
      stateOwner: owner,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: h.placeholder },
    }))
    assert.equal(first.error, undefined, JSON.stringify(first))
    assert.equal(first.value, 41)
    const second = await h.runtime.run(h.runtime.resolve({
      program: 'retained + 1',
      cwd: h.placeholder,
      timeoutMs: 20_000,
      bindings: [],
      stateOwner: owner,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: h.placeholder },
    }))
    assert.equal(second.error, undefined, JSON.stringify(second))
    assert.equal(second.value, 42)
  } finally {
    await h.runtime.release(owner)
    await h.dispose()
  }
})


test('vm-script with scriptPersistence retains state for one state owner', async () => {
  const h = await harness('danger-full-access', 'vm-script', true)
  const owner = {}
  try {
    const first = await h.runtime.run(h.runtime.resolve({
      program: 'var retained = 7\nretained',
      cwd: h.placeholder,
      timeoutMs: 20_000,
      bindings: [],
      stateOwner: owner,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: h.placeholder },
    }))
    assert.equal(first.error, undefined, JSON.stringify(first))
    assert.equal(first.value, 7)
    const second = await h.runtime.run(h.runtime.resolve({
      program: 'retained * 6',
      cwd: h.placeholder,
      timeoutMs: 20_000,
      bindings: [],
      stateOwner: owner,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: h.placeholder },
    }))
    assert.equal(second.error, undefined, JSON.stringify(second))
    assert.equal(second.value, 42)
  } finally {
    await h.runtime.release(owner)
    await h.dispose()
  }
})
