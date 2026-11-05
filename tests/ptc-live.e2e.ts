/**
 * Live SSH end-to-end test for the upstream-worker PTC path.
 *
 * Not part of `npm test`:
 *   DSH_PTC_LIVE=1 DSH_PTC_HOST=... DSH_PTC_USER=... DSH_PTC_PASSWORD=... \
 *   DSH_PTC_REMOTE_DIR=/srv/app npm run e2e:ptc
 *
 * Set DSH_INSTALL_ROOT to the installed @deepseek-ai/dsh package when the test
 * runner cannot infer it; otherwise the dev dependency is used as the worker
 * source and the manifest must still match it.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { NodePtcRuntime } from '@deepseek-ai/dsh-ptc-runtime-node'
import type { HostConfig } from '../src/config.ts'
import { probeHost, type RunnerStatus } from '../src/execute.ts'
import { attachRemotePtc, type RemotePtcDeps } from '../src/ptc-remote.ts'
import { installRemoteWorld } from '../src/remote-world.ts'
import { SshPoolTransport } from '../src/remote-transport.ts'
import { mapRemoteToLocal } from '../src/router.ts'
import { SshPool, type SecretMaterial } from '../src/ssh-pool.ts'
import { ensureWorker } from '../src/upstream-worker.ts'

const live = process.env.DSH_PTC_LIVE === '1'
const password = process.env.DSH_PTC_PASSWORD ?? ''
const remoteRoot = process.env.DSH_PTC_REMOTE_DIR ?? ''
const host: HostConfig = {
  id: process.env.DSH_PTC_HOST_ID ?? 'live',
  name: 'live',
  host: process.env.DSH_PTC_HOST ?? '127.0.0.1',
  port: Number(process.env.DSH_PTC_PORT ?? 22),
  username: process.env.DSH_PTC_USER ?? '',
  auth: 'password',
  privateKeyPath: '',
  fingerprint: process.env.DSH_PTC_FINGERPRINT ?? '',
  opsPolicy: 'ask',
  loginEnv: false,
}
const ready = live && password.length > 0 && remoteRoot.length > 0 && host.username.length > 0 && host.fingerprint.length > 0
const secret: SecretMaterial = { password }
const require = createRequire(import.meta.url)
const HOST_PROCESS_JS = join(dirname(require.resolve('@deepseek-ai/dsh-ptc-runtime-node/package.json')), 'lib', 'process.js')

interface LiveHarness {
  readonly runtime: NodePtcRuntime
  readonly status: RunnerStatus
  readonly placeholder: string
  readonly dispose: () => Promise<void>
}

async function harness(): Promise<LiveHarness> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-live-home-'))
  const env = { DSH_HOME: home }
  const placeholder = mapRemoteToLocal(host.id, remoteRoot, env)!
  const pool = new SshPool(2)
  const status = await probeHost(pool, host, secret)
  assert.equal(status.node?.available, true, JSON.stringify(status.node))
  assert.ok(status.home.length > 0)
  let remoteWorkerPath = ''
  const fs = {
    processPathFromHostPath: (hostPath: string) => {
      const normalized = resolve(hostPath)
      return remoteWorkerPath.length > 0 && normalized === resolve(HOST_PROCESS_JS) ? remoteWorkerPath : hostPath
    },
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
    defaultMode: 'read-only',
    resolve: () => ({ mode: 'read-only', workspaceRoot: remoteRoot }),
  })
  await ctx.plugin(NodePtcRuntime, {
    executionMode: 'per-call',
    scriptPersistence: false,
    timeoutMs: 120_000,
    maxTimeoutMs: 600_000,
    maxOutputBytes: 1_000_000,
    maxOldGenerationSizeMb: 256,
    maxMessageBytes: 4_000_000,
    maxPendingCalls: 8,
    graceMs: 3000,
    launch: { kind: 'node-script', executable: process.execPath },
  })
  const runtime = ctx.get('ptcRuntime') as NodePtcRuntime
  const restoreWorld = installRemoteWorld(ctx as unknown as { get(name: string): unknown }, {
    transport: new SshPoolTransport(pool),
    hostOf: id => id === host.id ? host : undefined,
    secretOf: async () => secret,
    statusOf: async () => status,
  })
  assert.ok(restoreWorld !== undefined)
  const deps: RemotePtcDeps = {
    pool,
    hostOf: id => id === host.id ? host : undefined,
    secretOf: async () => secret,
    statusOf: async () => status,
    ensureWorker: async (target, targetSecret, targetStatus, signal) => {
      const uploaded = await ensureWorker(pool, target, targetSecret, targetStatus.home, signal)
      remoteWorkerPath = uploaded.workerRemotePath
      return uploaded
    },
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
    status,
    placeholder,
    dispose: async () => {
      detach()
      restoreWorld()
      await pool.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

test('live: official worker runs a program and the tool bridge on the SSH host', { skip: !ready }, async () => {
  const h = await harness()
  try {
    const result = await h.runtime.run(h.runtime.resolve({
      program: 'const value = await tools.echo({ value: 41 }); return { value, cwd: process.cwd(), env: Object.keys(process.env) }',
      cwd: h.placeholder,
      timeoutMs: 30_000,
      bindings: [{
        global: 'tools',
        functions: { echo: async args => ({ value: Number((args as { value?: number }).value ?? 0) + 1 }) },
        errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
      }],
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: remoteRoot },
    }))
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(result.value, { value: { value: 42 }, cwd: remoteRoot, env: [] })
  } finally {
    await h.dispose()
  }
})

test('live: read-only denies writes and workspace-write writes only on the remote', { skip: !ready }, async () => {
  const h = await harness()
  try {
    const readOnly = await h.runtime.run(h.runtime.resolve({
      program: 'const fs = await import("node:fs"); fs.writeFileSync("denied.txt", "x"); return "wrote"',
      cwd: h.placeholder,
      timeoutMs: 20_000,
      bindings: [],
      sandboxPolicy: { mode: 'read-only', workspaceRoot: remoteRoot },
    }))
    assert.equal(readOnly.error?.kind, 'exception', JSON.stringify(readOnly))
    assert.match(readOnly.error?.message ?? '', /read-only file system/i)
    assert.equal(readOnly.sandbox?.denied, true)

    const write = await h.runtime.run(h.runtime.resolve({
      program: 'const fs = await import("node:fs"); fs.writeFileSync("proof.txt", "remote"); return fs.readFileSync("proof.txt", "utf8")',
      cwd: h.placeholder,
      timeoutMs: 20_000,
      bindings: [],
      sandboxPolicy: { mode: 'workspace-write', workspaceRoot: remoteRoot },
    }))
    assert.equal(write.error, undefined, JSON.stringify(write))
    assert.equal(write.value, 'remote')
    assert.equal(existsSync(join(h.placeholder, 'proof.txt')), false, 'the placeholder must stay empty')
  } finally {
    await h.dispose()
  }
})

test('live: timeout leaves no worker or shim process behind', { skip: !ready }, async () => {
  const h = await harness()
  const pool = new SshPool(1)
  try {
    const timed = await h.runtime.run(h.runtime.resolve({
      program: 'await new Promise(resolve => setTimeout(resolve, 60_000)); return 1',
      cwd: h.placeholder,
      timeoutMs: 300,
      bindings: [],
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: remoteRoot },
    }))
    assert.equal(timed.error?.kind, 'timeout', JSON.stringify(timed))
    await new Promise(resolve => setTimeout(resolve, 500))
    const check = await pool.exec(host, secret, 'pgrep -af "process\\.mjs|ptc-shim\\.mjs" || true', 10_000)
    assert.equal(check.stdout.trim(), '')
  } finally {
    await pool.dispose()
    await h.dispose()
  }
})
