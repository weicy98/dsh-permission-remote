import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HostConfig } from '../src/config.ts'
import { finishBackground, runBash, runGlob, runWorkingDirectory, runWrite, type RunnerStatus, type ToolHost } from '../src/execute.ts'
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

const SNAPSHOT = 'declare -x FROM_RC=rc\n'

function capturingBash(options: {
  loginEnv?: boolean
  snapshot?: string
  mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  status?: RunnerStatus
} = {}): { api: ToolHost, command: () => string, reads: () => number } {
  let command = ''
  let reads = 0
  const api = {
    pool: {
      sftpRealpath: async (_host: HostConfig, _secret: unknown, remotePath: string) => remotePath,
      exec: async (_host: HostConfig, _secret: unknown, argv: string) => {
        command = argv
        return { ...killed(), code: 0, signal: null, stdout: 'ok\n' }
      },
      open: async (_host: HostConfig, _secret: unknown, argv: string) => {
        command = argv
        return { close() {}, done: Promise.resolve({ ...killed(), code: 0, signal: null }) }
      },
    } as unknown as SshPool,
    hostOf: () => options.loginEnv === undefined ? host : { ...host, loginEnv: options.loginEnv },
    secretOf: async () => ({}),
    statusOf: async () => options.status ?? status,
    resolveMode: async () => options.mode ?? 'danger-full-access' as const,
    loginEnvOf: async () => {
      reads += 1
      return options.snapshot ?? ''
    },
    jobs: {
      start(spec: { run: (job: { append: () => void }) => { cancel(): void, done: Promise<unknown> } }) {
        spec.run({ append() {} })
        return 'job-1'
      },
    },
  } as unknown as ToolHost
  return { api, command: () => command, reads: () => reads }
}

test('workspace bash stays a plain bash -c when login environment is off', async () => {
  const absent = capturingBash()
  await runBash(absent.api, route, { command: 'printf READY' }, {})
  assert.equal(absent.command(), "cd '/srv/app' && 'bash' '-c' 'printf READY'")
  assert.equal(absent.reads(), 0)

  const explicit = capturingBash({ loginEnv: false })
  await runBash(explicit.api, route, { command: 'printf READY' }, {})
  assert.equal(explicit.command(), "cd '/srv/app' && 'bash' '-c' 'printf READY'")
  assert.equal(explicit.reads(), 0)
})

test('a captured snapshot is evaled, and an empty capture leaves the command alone', async () => {
  const ready = capturingBash({ loginEnv: true, snapshot: SNAPSHOT })
  await runBash(ready.api, route, { command: 'printf READY' }, {})
  const argv = ready.command()
  assert.equal(ready.reads(), 1)
  assert.match(argv, /eval /)
  assert.match(argv, /FROM_RC/)
  assert.match(argv, /printf READY/)
  assert.doesNotMatch(argv, /--noprofile|bashrc|__dsh_hit/)

  const missed = capturingBash({ loginEnv: true, snapshot: '' })
  await runBash(missed.api, route, { command: 'printf READY' }, {})
  assert.equal(missed.command(), "cd '/srv/app' && 'bash' '-c' 'printf READY'")
  assert.equal(missed.reads(), 1)
})

test('a background command reuses the snapshot and does not source startup files', async () => {
  const { api, command, reads } = capturingBash({ loginEnv: true, snapshot: SNAPSHOT })
  const value = await runBash(api, route, { command: 'printf READY', run_in_background: true }, {})
  assert.equal(value.kind, 'background')
  assert.equal(reads(), 1)
  assert.match(command(), /eval /)
  assert.match(command(), /FROM_RC/)
  assert.match(command(), /printf READY/)
  assert.doesNotMatch(command(), /--noprofile|bashrc/)
})

test('the snapshot stays inside bwrap and seatbelt', async () => {
  const bwrap = capturingBash({
    loginEnv: true,
    snapshot: SNAPSHOT,
    mode: 'read-only',
    status: { ...status, sandbox: { available: true, reason: 'ok' }, sandboxTool: 'bwrap' },
  })
  await runBash(bwrap.api, route, { command: 'printf READY' }, {})
  assert.match(bwrap.command(), /bwrap/)
  assert.match(bwrap.command(), /--chdir/)
  assert.match(bwrap.command(), /FROM_RC/)
  assert.match(bwrap.command(), /printf READY/)
  assert.doesNotMatch(bwrap.command(), /--noprofile/)

  const seatbelt = capturingBash({
    loginEnv: true,
    snapshot: SNAPSHOT,
    mode: 'read-only',
    status: { ...status, os: 'darwin', sandbox: { available: true, reason: 'ok' }, sandboxTool: 'sandbox-exec' },
  })
  await runBash(seatbelt.api, route, { command: 'printf READY' }, {})
  assert.match(seatbelt.command(), /sandbox-exec/)
  assert.match(seatbelt.command(), /FROM_RC/)
  assert.match(seatbelt.command(), /printf READY/)
  assert.doesNotMatch(seatbelt.command(), /--noprofile/)
})

test('a file write does not load startup files', async () => {
  let command = ''
  const api = {
    pool: {
      sftpRealpath: async (_host: HostConfig, _secret: unknown, remotePath: string) => remotePath,
      sftpRead: async () => {
        throw new Error('ENOENT')
      },
      exec: async (_host: HostConfig, _secret: unknown, argv: string) => {
        command = argv
        return { ...killed(), code: 0, signal: null }
      },
    } as unknown as SshPool,
    hostOf: () => ({ ...host, loginEnv: true }),
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'danger-full-access' as const,
    loginEnvOf: async () => {
      throw new Error('file writes must not read startup files')
    },
  } satisfies ToolHost
  const written = await runWrite(api, route, { file_path: '/srv/app/note.txt', content: 'next' }, {})
  assert.equal(written.operation, 'create')
  assert.doesNotMatch(command, /__dsh_login/)
  assert.doesNotMatch(command, /--noprofile/)
})

test('working_directory reports the remote directory alongside the placeholder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wd-'))
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = root
  try {
    // A symlinked directory: sftpRealpath returns the canonical path, which
    // differs from both the requested path and the placeholder it maps to.
    // Returning the requested path instead would let a regression that skips
    // the realpath call still pass.
    const canonical = '/srv/app/real-src'
    const requestedPaths: string[] = []
    let realpaths = 0
    const api = {
      pool: {
        sftpRealpath: async (_host: HostConfig, _secret: unknown, requested: string) => {
          realpaths += 1
          requestedPaths.push(requested)
          return canonical
        },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
    } as unknown as ToolHost
    const setCalls: string[] = []
    const setDirectory = async (directory: string): Promise<string> => {
      setCalls.push(directory)
      return `/canonical-${setCalls.length}`
    }

    const changed = await runWorkingDirectory(api, route, { cd: '/srv/app/src' }, { agent: {} }, setDirectory)
    // `remote` is the sftpRealpath result, never the requested path.
    assert.equal(changed.remote, canonical)
    // `cwd` is whatever `setDirectory` committed, not the placeholder it was handed.
    assert.equal(changed.cwd, '/canonical-1')
    assert.equal(setCalls.length, 1)
    assert.equal(realpaths, 1)
    // `resolveRemotePath` turned `cd: '/srv/app/src'` into the path we confirm.
    assert.deepEqual(requestedPaths, ['/srv/app/src'])

    // The handed path must live under the temp root we set, not the default
    // `~/.dsh/remote`. Otherwise a mapping regression would still pass here and
    // leave a directory behind that `rm(root)` cannot clean up.
    const handed = setCalls[0]!
    assert.ok(handed.startsWith(root), `setDirectory received ${handed}, expected a path under ${root}`)
    assert.equal((await stat(handed)).isDirectory(), true)

    const read = await runWorkingDirectory(api, route, {}, { agent: {} }, setDirectory)
    assert.equal(read.cwd, route.placeholderCwd)
    assert.equal(read.remote, route.remoteCwd)
    // Reading the current directory must not dial the host or move the session.
    assert.equal(setCalls.length, 1)
    assert.equal(realpaths, 1)
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('working_directory rejects a remote directory that does not exist', async () => {
  const api = {
    pool: {
      sftpRealpath: async () => {
        throw new Error('ENOENT')
      },
    } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
  } as unknown as ToolHost
  await assert.rejects(
    () => runWorkingDirectory(api, route, { cd: '/srv/app/missing' }, { agent: {} }, async () => '/canonical'),
    /directory does not exist on the remote host: \/srv\/app\/missing/,
  )
})
