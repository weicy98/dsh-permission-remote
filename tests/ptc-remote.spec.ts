import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { attachRemotePtc, type PtcRunResult, type PtcRunSpec, type RemotePtcDeps } from '../src/ptc-remote.ts'
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
    const remote = await value.run({ program: 'return 1', cwd: placeholder, timeoutMs: 1000, bindings: [], sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: '/srv/app' } })
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
