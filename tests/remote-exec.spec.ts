import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { RunnerStatus } from '../src/execute.ts'
import { installRemoteWorld } from '../src/remote-world.ts'
import { LocalTransport } from './helpers/local-ptc.ts'
import { mapRemoteToLocal } from '../src/router.ts'

function statusFor(root: string): RunnerStatus {
  return {
    os: 'linux',
    sandbox: { available: true, reason: 'ok' },
    sandboxTool: 'bwrap',
    ripgrep: 'system',
    ripgrepPath: '/usr/bin/rg',
    roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
    home: root,
    node: { available: true, path: '/usr/bin/node', version: '22.20.0', major: 22 },
    install: null,
  }
}

async function harness(): Promise<{
  root: string
  placeholder: string
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  close: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-exec-'))
  const placeholder = mapRemoteToLocal('h1', root)!
  const status = statusFor(root)
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => process.execPath,
  }
  const sandbox = {
    confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  }
  const ctx = { get: (name: string) => name === 'subprocess' ? subprocess : name === 'sandbox' ? sandbox : undefined }
  const restore = installRemoteWorld(ctx, {
    transport: new LocalTransport(),
    hostOf: () => ({
      id: 'h1', name: '', host: '127.0.0.1', port: 22, username: 'u', auth: 'key',
      privateKeyPath: '', fingerprint: '', opsPolicy: 'ask',
    }),
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === placeholder ? { kind: 'remote', hostId: 'h1', remoteCwd: root, placeholderCwd: placeholder } : { kind: 'local' },
  })
  assert.ok(restore !== undefined)
  return {
    root,
    placeholder,
    spawn: spec => subprocess.spawn(spec) as unknown as SubprocessHandle,
    close: async () => {
      restore!()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function spec(cwd: string, overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['bash', '-c', 'printf out; printf err >&2'],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 },
      stderr: { maxBytes: 1024 },
    },
    graceMs: 1000,
    ...overrides,
  }
}

test('generic remote spawn collects stdout/stderr and maps the remote cwd', async () => {
  const h = await harness()
  try {
    const handle = h.spawn(spec(h.placeholder))
    const result = await handle.done
    assert.deepEqual(result, { exitCode: 0, signal: null })
    assert.equal(handle.collected.stdout?.readFrom(0).text, 'out')
    assert.equal(handle.collected.stderr?.readFrom(0).text, 'err')
    await handle.waitForExit()
  } finally {
    await h.close()
  }
})

test('generic remote spawn forwards stdin data', async () => {
  const h = await harness()
  try {
    const handle = h.spawn(spec(h.placeholder, {
      argv: ['cat'],
      stdio: { stdin: { data: 'hello from stdin' }, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    }))
    const result = await handle.done
    assert.deepEqual(result, { exitCode: 0, signal: null })
    assert.equal(handle.collected.stdout?.readFrom(0).text, 'hello from stdin')
  } finally {
    await h.close()
  }
})

test('generic remote spawn terminates on abort', async () => {
  const h = await harness()
  try {
    const controller = new AbortController()
    const handle = h.spawn(spec(h.placeholder, {
      argv: ['bash', '-c', 'printf before; sleep 2; printf after'],
      signal: controller.signal,
    }))
    setTimeout(() => controller.abort(), 100)
    const result = await handle.done
    assert.equal(result.signal === null || result.signal === 'SIGKILL' || result.signal === 'SIGTERM', true)
    assert.equal(handle.collected.stdout?.readFrom(0).text.includes('before'), true)
  } finally {
    await h.close()
  }
})
