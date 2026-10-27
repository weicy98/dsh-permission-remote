import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostConfig } from '../src/config.ts'
import { runGlob, runWrite, type RunnerStatus, type ToolHost } from '../src/execute.ts'
import type { RemoteRoute } from '../src/router.ts'
import type { ExecResult, SshPool } from '../src/ssh-pool.ts'

const host: HostConfig = {
  id: 'host1',
  name: '',
  host: '127.0.0.1',
  port: 22,
  username: 'u',
  auth: 'key',
  privateKeyPath: '',
  fingerprint: '',
}

const route: RemoteRoute = {
  kind: 'remote',
  hostId: 'host1',
  remoteCwd: '/srv/app',
  placeholderCwd: '/tmp/placeholder',
}

const status: RunnerStatus = {
  os: 'linux',
  sandbox: { available: false, reason: 'missing' },
  sandboxTool: 'none',
  ripgrep: 'system',
  ripgrepPath: '/usr/bin/rg',
  roots: { workspaceRoot: '/srv/app', tmp: '/tmp', userTmp: '/tmp' },
  install: null,
}

function killed(): ExecResult {
  return {
    code: null,
    signal: 'KILL',
    stdout: '',
    stderr: '',
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

test('a cancelled glob is an abort, not a command failure', async () => {
  const controller = new AbortController()
  controller.abort()
  const api = {
    pool: { exec: async () => killed() } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'read-only' as const,
  } satisfies ToolHost
  await assert.rejects(
    () => runGlob(api, route, { pattern: '*.ts' }, { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
})

test('a glob that exits 2 is still a command failure', async () => {
  const api = {
    pool: {
      exec: async () => ({ ...killed(), code: 2, signal: null, stderr: 'rg exploded' }),
    } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'read-only' as const,
  } satisfies ToolHost
  await assert.rejects(
    () => runGlob(api, route, { pattern: '*.ts' }, {}),
    (error: unknown) => error instanceof Error && error.name === 'Error' && error.message === 'rg exploded',
  )
})

test('cancelling a write does not turn the read into a missing file', async () => {
  const controller = new AbortController()
  controller.abort()
  let writes = 0
  const api = {
    pool: {
      sftpRealpath: async (_host: HostConfig, _secret: unknown, remotePath: string) => remotePath,
      sftpRead: () => new Promise<Buffer>(() => undefined),
      exec: async () => {
        writes += 1
        return { ...killed(), code: 0, signal: null }
      },
    } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'danger-full-access' as const,
  } satisfies ToolHost
  await assert.rejects(
    () => runWrite(api, route, { file_path: '/srv/app/note.txt', content: 'next' }, { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(writes, 0)
})

test('a missing file is still created', async () => {
  let writes = 0
  const api = {
    pool: {
      sftpRealpath: async (_host: HostConfig, _secret: unknown, remotePath: string) => remotePath,
      sftpRead: async () => {
        throw new Error('ENOENT')
      },
      exec: async () => {
        writes += 1
        return { ...killed(), code: 0, signal: null }
      },
    } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'danger-full-access' as const,
  } satisfies ToolHost
  const written = await runWrite(api, route, { file_path: '/srv/app/note.txt', content: 'next' }, {})
  assert.equal(written.operation, 'create')
  assert.equal(writes, 1)
})
