import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostConfig } from '../src/config.ts'
import { finishBackground, runBash, runGlob, runWrite, type RunnerStatus, type ToolHost } from '../src/execute.ts'
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
  opsPolicy: 'ask',
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

test('a finished background job appends its note once and returns no result', () => {
  const appended: string[] = []
  const outcome = finishBackground({ ...killed(), signal: null, code: 0 }, 'note', text => appended.push(text))
  assert.deepEqual(appended, ['note'])
  assert.equal('result' in outcome, false)
  assert.equal(outcome.status, 'completed')
  assert.equal(outcome.detail, 'exit code: 0')
})

test('an empty background note is not appended', () => {
  const appended: string[] = []
  const outcome = finishBackground({ ...killed(), signal: null, code: 0 }, '', text => appended.push(text))
  assert.deepEqual(appended, [])
  assert.equal(outcome.status, 'completed')
})

test('a killed background job reports cancelled', () => {
  const outcome = finishBackground(killed(), '', () => undefined)
  assert.equal(outcome.status, 'killed')
  assert.equal(outcome.detail, 'cancelled')
})

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

test('a login banner before the search block is not a glob path', async () => {
  let command = ''
  const api = {
    pool: {
      exec: async (_host: HostConfig, _secret: unknown, argv: string) => {
        command = argv
        return {
          ...killed(),
          code: 0,
          signal: null,
          stdout: ['Welcome to Ubuntu 24.04', '__DSH_SEARCH_BEGIN__', 'src/main.ts', '__DSH_SEARCH_END__', ''].join('\n'),
        }
      },
    } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'read-only' as const,
  } satisfies ToolHost
  const result = await runGlob(api, route, { pattern: '*.ts' }, {})
  assert.match(command, /__DSH_SEARCH_BEGIN__/)
  assert.match(command, /exit \$status/)
  assert.deepEqual(result.paths, [`${route.placeholderCwd}/src/main.ts`])
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

test('a foreground bash result survives a JSON round trip', async () => {
  // The harness rejects a tool value holding `undefined`: the SSH layer used to
  // pass the absent ssh2 signals straight through, so every foreground command
  // failed with "value is not lossless JSON".
  const api = {
    pool: {
      sftpRealpath: async (_host: HostConfig, _secret: unknown, remotePath: string) => remotePath,
      exec: async () => ({ ...killed(), code: 0, signal: null, stdout: 'ok\n' }),
    } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'danger-full-access' as const,
  } satisfies ToolHost
  const value = await runBash(api, route, { command: 'echo ok', description: 'echo' }, {})
  assert.equal(value.exitCode, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('a non-positive timeout falls back to the default instead of passing it on', async () => {
  const timeouts: number[] = []
  const api = {
    pool: {
      sftpRealpath: async (_host: HostConfig, _secret: unknown, remotePath: string) => remotePath,
      exec: async (_host: HostConfig, _secret: unknown, _command: string, timeoutMs: number) => {
        timeouts.push(timeoutMs)
        return { ...killed(), code: 0, signal: null }
      },
    } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'danger-full-access' as const,
  } satisfies ToolHost
  const value = await runBash(api, route, { command: 'echo ok', description: 'echo', timeoutMs: 0 }, {})
  assert.equal(value.timeoutMs, 60_000)
  assert.deepEqual(timeouts, [60_000])
})
