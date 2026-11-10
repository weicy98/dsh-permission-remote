import assert from 'node:assert/strict'
import test from 'node:test'
import { installRemoteShell } from '../src/remote-shell.ts'
import { mapRemoteToLocal } from '../src/router.ts'

const host = {
  id: 'h1', name: '', host: '127.0.0.1', port: 22, username: 'u', auth: 'key' as const,
  privateKeyPath: '', fingerprint: '', opsPolicy: 'ask' as const, loginEnv: true,
}
const remoteRoot = '/srv/app'
const placeholder = mapRemoteToLocal('h1', remoteRoot)!

test('remote shell sources the published login environment and flushes when there is no handle', async () => {
  const calls: Array<{ command: string, workdir: string }> = []
  let flushed = 0
  const shell = {
    async execute(spec: { command: string, workdir: string }) {
      calls.push({ command: spec.command, workdir: spec.workdir })
      return { ok: true }
    },
  }
  const ctx = { get: (name: string) => name === 'shell' ? shell : undefined }
  const restore = installRemoteShell(ctx, {
    routeByCwd: cwd => cwd === placeholder ? { kind: 'remote', hostId: 'h1', remoteCwd: remoteRoot, placeholderCwd: placeholder } : { kind: 'local' },
    hostOf: () => host,
    loginEnvFileOf: async () => '/home/me/.dsh-permission-remote/login-env.sh',
    onCommandFinished: () => { flushed += 1 },
  })
  assert.ok(restore !== undefined)
  try {
    await shell.execute({ command: 'echo hi', workdir: placeholder })
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.command, /login-env\.sh/)
    assert.doesNotMatch(calls[0]!.command, /export SNAP/)
    assert.equal(calls[0]!.workdir, placeholder)
    assert.equal(flushed, 1)
  } finally {
    restore!()
  }
})

test('remote shell flushes attributes only after the process handle settles', async () => {
  let release: () => void = () => undefined
  const done = new Promise<void>(resolve => { release = resolve })
  let flushed = 0
  const shell = {
    async execute(_spec: { command: string, workdir: string }) {
      return { done }
    },
  }
  const ctx = { get: (name: string) => name === 'shell' ? shell : undefined }
  const restore = installRemoteShell(ctx, {
    routeByCwd: () => ({ kind: 'remote', hostId: 'h1', remoteCwd: remoteRoot, placeholderCwd: placeholder }),
    hostOf: () => ({ ...host, loginEnv: false }),
    loginEnvFileOf: async () => '',
    onCommandFinished: () => { flushed += 1 },
  })
  assert.ok(restore !== undefined)
  try {
    await shell.execute({ command: 'echo hi', workdir: placeholder })
    assert.equal(flushed, 0)
    release()
    await done
    await Promise.resolve()
    assert.equal(flushed, 1)
  } finally {
    restore!()
  }
})

test('remote shell leaves local commands and loginEnv-off hosts untouched', async () => {
  const calls: string[] = []
  const shell = {
    async execute(spec: { command: string, workdir: string }) {
      calls.push(spec.command)
      return { ok: true }
    },
  }
  const ctx = { get: (name: string) => name === 'shell' ? shell : undefined }
  const restore = installRemoteShell(ctx, {
    routeByCwd: cwd => cwd === placeholder ? { kind: 'remote', hostId: 'h1', remoteCwd: remoteRoot, placeholderCwd: placeholder } : { kind: 'local' },
    hostOf: () => ({ ...host, loginEnv: false }),
    loginEnvFileOf: async () => '/home/me/.dsh-permission-remote/login-env.sh',
  })
  assert.ok(restore !== undefined)
  try {
    await shell.execute({ command: 'echo local', workdir: '/tmp' })
    await shell.execute({ command: 'echo remote', workdir: placeholder })
    assert.deepEqual(calls, ['echo local', 'echo remote'])
  } finally {
    restore!()
  }
})
