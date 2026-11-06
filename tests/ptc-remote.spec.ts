import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { attachRemotePtc, type PtcRunResult, type PtcRunSpec, type RemotePtcDeps } from '../src/ptc-remote.ts'
import { remoteWorldContext } from '../src/remote-world.ts'
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
