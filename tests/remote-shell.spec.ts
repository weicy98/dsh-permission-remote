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

test('remote shell adds the captured login environment to a remote command', async () => {
  const calls: Array<{ command: string, workdir: string }> = []
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
    loginEnvOf: async () => 'export SNAP=1\n',
  })
  assert.ok(restore !== undefined)
  try {
    await shell.execute({ command: 'echo hi', workdir: placeholder })
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.command, /SNAP=1/)
    assert.equal(calls[0]!.workdir, placeholder)
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
    loginEnvOf: async () => 'export SNAP=1\n',
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
