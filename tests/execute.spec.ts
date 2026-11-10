import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import test from 'node:test'
import type { HostConfig } from '../src/config.ts'
import { clearStagedPresentFiles, finishBackground, runBash, runWorkingDirectory, stagePresentFiles, type RunnerStatus, type ToolHost } from '../src/execute.ts'
import { createPresentCache, HARD_MAX_BYTES } from '../src/present-cache.ts'
import { mapRemoteToLocal, type RemoteRoute } from '../src/router.ts'
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
  home: '/home/dev',
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
const ENV_FILE = '/home/me/.dsh-permission-remote/login-env.sh'

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
    loginEnvFileOf: async () => {
      reads += 1
      return options.snapshot ? ENV_FILE : ''
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

test('a captured snapshot is sourced from a file, and an empty capture leaves the command alone', async () => {
  const ready = capturingBash({ loginEnv: true, snapshot: SNAPSHOT })
  await runBash(ready.api, route, { command: 'printf READY' }, {})
  const argv = ready.command()
  assert.equal(ready.reads(), 1)
  assert.match(argv, /login-env\.sh/)
  assert.match(argv, /printf READY/)
  assert.doesNotMatch(argv, /FROM_RC|eval |--noprofile|bashrc|__dsh_hit/)

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
  assert.match(command(), /login-env\.sh/)
  assert.match(command(), /printf READY/)
  assert.doesNotMatch(command(), /FROM_RC|eval |--noprofile|bashrc/)
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
  assert.match(bwrap.command(), /login-env\.sh/)
  assert.match(bwrap.command(), /printf READY/)
  assert.doesNotMatch(bwrap.command(), /FROM_RC|--noprofile/)

  const seatbelt = capturingBash({
    loginEnv: true,
    snapshot: SNAPSHOT,
    mode: 'read-only',
    status: { ...status, os: 'darwin', sandbox: { available: true, reason: 'ok' }, sandboxTool: 'sandbox-exec' },
  })
  await runBash(seatbelt.api, route, { command: 'printf READY' }, {})
  assert.match(seatbelt.command(), /sandbox-exec/)
  assert.match(seatbelt.command(), /login-env\.sh/)
  assert.match(seatbelt.command(), /printf READY/)
  assert.doesNotMatch(seatbelt.command(), /FROM_RC|--noprofile/)
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

test('working_directory does not commit a directory the caller rejects after realpath', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-wd-'))
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = root
  try {
    const api = {
      pool: {
        sftpRealpath: async () => '/etc',
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
    } as unknown as ToolHost
    const setCalls: string[] = []
    let seen: string | undefined
    await assert.rejects(
      () => runWorkingDirectory(api, route, { cd: '.' }, { agent: {} }, async directory => {
        setCalls.push(directory)
        return directory
      }, remote => {
        seen = remote
        throw new Error('no registered workspace owns this directory')
      }),
      /no registered workspace owns/,
    )
    assert.equal(seen, '/etc')
    assert.deepEqual(setCalls, [])
    assert.deepEqual(await readdir(root), [])
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})

const bwrapStatus: RunnerStatus = {
  ...status,
  sandbox: { available: true, reason: 'ok' },
  sandboxTool: 'bwrap',
}

test('workspace-write binds the opened workspace, not the live directory', async () => {
  const opened = mapRemoteToLocal('host1', '/srv/app')!
  const atRoot: RemoteRoute = { ...route, remoteCwd: '/' }
  const pinned = capturingBash({ mode: 'workspace-write', status: bwrapStatus })
  await runBash(pinned.api, atRoot, { command: 'true' }, {
    agent: { session: { header: { cwd: opened } } },
  })
  assert.match(pinned.command(), /'--bind' '\/srv\/app' '\/srv\/app'/)
  assert.doesNotMatch(pinned.command(), /'--bind' '\/' '\/'/)
  assert.match(pinned.command(), /'--chdir' '\/'/)

  // A header that already sits in a subdirectory still pins the encoded workspace.
  const fromChild = capturingBash({ mode: 'workspace-write', status: bwrapStatus })
  await runBash(fromChild.api, atRoot, { command: 'true', workdir: '/etc' }, {
    agent: { session: { header: { cwd: join(opened, 'src') } } },
  })
  assert.match(fromChild.command(), /'--bind' '\/srv\/app' '\/srv\/app'/)
  assert.match(fromChild.command(), /'--chdir' '\/etc'/)

  const background = capturingBash({ mode: 'workspace-write', status: bwrapStatus })
  await runBash(background.api, atRoot, { command: 'true', run_in_background: true }, {
    agent: { session: { header: { cwd: opened } } },
  })
  assert.match(background.command(), /'--bind' '\/srv\/app' '\/srv\/app'/)
  assert.doesNotMatch(background.command(), /'--bind' '\/' '\/'/)

  // danger-full-access does not wrap, and it may still chdir to the live directory.
  const open = capturingBash()
  await runBash(open.api, atRoot, { command: 'true' }, {
    agent: { session: { header: { cwd: opened } } },
  })
  assert.equal(open.command(), "cd '/' && 'bash' '-c' 'true'")
})

test('workspace-write binds the live directory when the header is not on this host', async () => {
  const local = capturingBash({
    mode: 'workspace-write',
    status: bwrapStatus,
  })
  const api = local.api as ToolHost & {
    pool: { sftpRealpath: (host: HostConfig, secret: unknown, path: string) => Promise<string> }
  }
  api.pool.sftpRealpath = async (_host, _secret, path) => path === '/srv/app/src' ? '/private/srv/app/src' : path
  const nested: RemoteRoute = { ...route, remoteCwd: '/srv/app/src' }
  await runBash(api, nested, { command: 'true' }, {
    agent: { session: { header: { cwd: '/tmp/local-project' } } },
  })
  assert.match(local.command(), /'--bind' '\/private\/srv\/app\/src' '\/private\/srv\/app\/src'/)
  assert.doesNotMatch(local.command(), /'--bind' '\/srv\/app' '\/srv\/app'/)
  assert.doesNotMatch(local.command(), /'--bind' '\/srv' '\/srv'/)
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

test('delivering a remote file streams it into a content-addressed snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    // A real remote route's placeholder cwd is the mapped path under this root:
    // the local backend can only stat what lives there.
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const exec = { signal: new AbortController().signal }
    const cache = createPresentCache(join(root, '.deliverables'))
    const api = {
      pool: {
        sftpAttrs: async () => ({ type: 'file', size: 5 }),
        async *sftpReadChunks() { yield Buffer.from('hello') },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    const staged = await stagePresentFiles(api, sessionRoute, [{ path: 'out/report.txt' }], exec, { maxBytes: 0, cache })
    assert.deepEqual(staged.map(file => file.bytes), [5])
    const entry = staged[0]!
    assert.equal(entry.hash, createHash('sha256').update('hello').digest('hex'))
    assert.equal(entry.reused, false)
    assert.equal(entry.remotePath, '/srv/app/out/report.txt')
    // The path is `<cache root>/<sha256>/<name>`, not the placeholder.
    assert.ok(entry.path.startsWith(join(root, '.deliverables')))
    assert.equal(entry.path, join(cache.root, entry.hash, 'report.txt'))
    assert.match(entry.path, /[0-9a-f]{64}/)
    assert.equal(await readFile(entry.path, 'utf8'), 'hello')
    // Nothing was written into the placeholder tree this time.
    assert.equal(existsSync(posix.join(mapping, 'out', 'report.txt')), false)
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing remote file fails delivery instead of presenting an empty copy', async () => {
  const api = {
    pool: {
      sftpStat: async () => {
        throw new Error('No such file')
      },
    } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'read-only' as const,
  } satisfies ToolHost
  await assert.rejects(
    () => stagePresentFiles(api, route, [{ path: 'missing.txt' }], {}),
    /no file at the remote path \/srv\/app\/missing\.txt/,
  )
})

test('a remote directory is not delivered as a file', async () => {
  let reads = 0
  const api = {
    pool: {
      sftpStat: async () => ({ isDirectory: true, size: 4096 }),
      sftpRead: async () => {
        reads += 1
        return Buffer.alloc(0)
      },
    } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'read-only' as const,
  } satisfies ToolHost
  await assert.rejects(
    () => stagePresentFiles(api, route, [{ path: 'src' }], {}),
    /is a directory, not a file/,
  )
  assert.equal(reads, 0)
})

test('identical content reuses its snapshot and changed content gets a new one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-snap-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const cache = createPresentCache(join(root, '.deliverables'))
    let body = Buffer.from('first version')
    const api = () => ({
      pool: {
        sftpAttrs: async () => ({ type: 'file', size: body.length }),
        async *sftpReadChunks() { yield body },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    }) satisfies ToolHost

    const [first] = await stagePresentFiles(api(), sessionRoute, [{ path: 'report.txt' }], {}, { maxBytes: 0, cache })
    // The same bytes again: reuse, no rewrite.
    const [again] = await stagePresentFiles(api(), sessionRoute, [{ path: 'report.txt' }], {}, { maxBytes: 0, cache })
    assert.equal(again!.path, first!.path)
    assert.equal(again!.reused, true)
    assert.equal(await readFile(first!.path, 'utf8'), 'first version')

    // Different bytes: a different content address, and the first card's file
    // is untouched. This is the whole reason the snapshot is immutable.
    body = Buffer.from('second version')
    const [second] = await stagePresentFiles(api(), sessionRoute, [{ path: 'report.txt' }], {}, { maxBytes: 0, cache })
    assert.notEqual(second!.path, first!.path)
    assert.notEqual(second!.hash, first!.hash)
    assert.equal(second!.reused, false)
    assert.equal(await readFile(first!.path, 'utf8'), 'first version')
    assert.equal(await readFile(second!.path, 'utf8'), 'second version')
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('a publish failure keeps a snapshot the batch only reused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-reuse-fail-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const cache = createPresentCache(join(root, '.deliverables'))
    const kept = Buffer.from('first version')
    const fresh = Buffer.from('brand new bytes')
    const clash = Buffer.from('clash-body')
    const bodies: Record<string, Buffer> = { 'report.txt': kept, 'fresh.txt': fresh, 'clash.txt': clash }
    const api = {
      pool: {
        sftpAttrs: async (_h: unknown, _s: unknown, remotePath: string) => {
          const name = remotePath.split('/').pop() ?? ''
          return { type: 'file' as const, size: bodies[name]?.length ?? 0 }
        },
        async *sftpReadChunks(_h: unknown, _s: unknown, remotePath: string) {
          const name = remotePath.split('/').pop() ?? ''
          yield bodies[name]!
        },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost

    const [first] = await stagePresentFiles(api, sessionRoute, [{ path: 'report.txt' }], {}, { maxBytes: 0, cache })
    const planted = cache.targetFor(createHash('sha256').update(clash).digest('hex'), 'clash.txt')
    await mkdir(dirname(planted), { recursive: true })
    await writeFile(planted, 'different bytes already here')

    await assert.rejects(
      () => stagePresentFiles(api, sessionRoute, [{ path: 'report.txt' }, { path: 'fresh.txt' }, { path: 'clash.txt' }], {}, { maxBytes: 0, cache }),
      /already holds different content/,
    )
    assert.equal(await readFile(first!.path, 'utf8'), 'first version')
    const freshPath = cache.targetFor(createHash('sha256').update(fresh).digest('hex'), 'fresh.txt')
    assert.equal(existsSync(freshPath), false)
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('a cleanup failure still reports the publish error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-cleanup-'))
  let locked = ''
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const cache = createPresentCache(join(root, '.deliverables'))
    const publish = cache.publish.bind(cache)
    let arm = false
    cache.publish = async pending => {
      const ref = await publish(pending)
      if (arm && !ref.reused) {
        locked = dirname(ref.path)
        await chmod(locked, 0o500)
      }
      return ref
    }
    const kept = Buffer.from('first version')
    const fresh = Buffer.from('brand new bytes')
    const clash = Buffer.from('clash-body')
    const bodies: Record<string, Buffer> = { 'report.txt': kept, 'fresh.txt': fresh, 'clash.txt': clash }
    const api = {
      pool: {
        sftpAttrs: async (_h: unknown, _s: unknown, remotePath: string) => {
          const name = remotePath.split('/').pop() ?? ''
          return { type: 'file' as const, size: bodies[name]?.length ?? 0 }
        },
        async *sftpReadChunks(_h: unknown, _s: unknown, remotePath: string) {
          const name = remotePath.split('/').pop() ?? ''
          yield bodies[name]!
        },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost

    const [first] = await stagePresentFiles(api, sessionRoute, [{ path: 'report.txt' }], {}, { maxBytes: 0, cache })
    arm = true
    const planted = cache.targetFor(createHash('sha256').update(clash).digest('hex'), 'clash.txt')
    await mkdir(dirname(planted), { recursive: true })
    await writeFile(planted, 'different bytes already here')

    await assert.rejects(
      () => stagePresentFiles(api, sessionRoute, [{ path: 'report.txt' }, { path: 'fresh.txt' }, { path: 'clash.txt' }], {}, { maxBytes: 0, cache }),
      (error: Error) => /already holds different content/.test(error.message) && !/EACCES/.test(error.message),
    )
    assert.equal(await readFile(first!.path, 'utf8'), 'first version')
  } finally {
    if (locked.length > 0) await chmod(locked, 0o700).catch(() => undefined)
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('a batch that fails on its second file leaves nothing behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-batch-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const cache = createPresentCache(join(root, '.deliverables'))
    // `good.txt` exists and reads; `bad.txt` fails mid-transfer.
    const api = {
      pool: {
        sftpAttrs: async (_h: unknown, _s: unknown, remotePath: string) => ({ type: 'file', size: remotePath.endsWith('good.txt') ? 4 : 3 }),
        async *sftpReadChunks(_h: unknown, _s: unknown, remotePath: string) {
          if (remotePath.endsWith('bad.txt')) throw new Error('connection reset')
          yield Buffer.from('good')
        },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    await assert.rejects(
      () => stagePresentFiles(api, sessionRoute, [{ path: 'good.txt' }, { path: 'bad.txt' }], {}, { maxBytes: 0, cache }),
      /connection reset/,
    )
    // No published snapshot, and no temp left behind: the batch is all-or-nothing.
    const hashDirs = (await readdir(cache.root)).filter(name => /^[0-9a-f]{64}$/.test(name))
    assert.deepEqual(hashDirs, [])
    assert.deepEqual(await readdir(join(cache.root, '.tmp')), [])
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('fallback mode leaves no copy behind when a later file fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-fb-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const api = {
      pool: {
        sftpAttrs: async (_h: unknown, _s: unknown, p: string) => ({ type: 'file', size: 4 }),
        sftpRead: async (_h: unknown, _s: unknown, p: string) => {
          if (p.endsWith('bad.txt')) throw new Error('connection reset')
          return Buffer.from('good')
        },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    // No `cache`: the placeholder path, which used to be written inside the read
    // loop. The first file must not survive a failure on the second.
    await assert.rejects(
      () => stagePresentFiles(api, sessionRoute, [{ path: 'good.txt' }, { path: 'bad.txt' }], {}),
      /connection reset/,
    )
    assert.equal(existsSync(posix.join(mapping, 'good.txt')), false, 'a failed batch must not leave the first copy')
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('the delivery ceiling follows the setting, and a hard ceiling backs up "no limit"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-ceiling-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const cache = createPresentCache(join(root, '.deliverables'))
    const api = (size: number) => ({
      pool: {
        sftpAttrs: async () => ({ type: 'file', size }),
        async *sftpReadChunks() { yield Buffer.from('hello') },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    }) satisfies ToolHost

    // The setting is the limit, and it says so.
    await assert.rejects(
      () => stagePresentFiles(api(5), sessionRoute, [{ path: 'report.txt' }], {}, { maxBytes: 4, cache }),
      /over the 4 byte delivery limit/,
    )
    // `0` means "no limit" for a transfer, but a delivery still has a ceiling;
    // the message says which one applied so the operator does not go looking at
    // the transfer setting.
    await assert.rejects(
      () => stagePresentFiles(api(HARD_MAX_BYTES + 1), sessionRoute, [{ path: 'report.txt' }], {}, { maxBytes: 0, cache }),
      new RegExp(`over the ${HARD_MAX_BYTES} byte snapshot limit \\(the transfer setting asks for no limit\\)`),
    )
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('a setting that equals the hard ceiling is still reported as the setting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-edgeset-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const cache = createPresentCache(join(root, '.deliverables'))
    const api = {
      pool: {
        sftpAttrs: async () => ({ type: 'file', size: HARD_MAX_BYTES + 1 }),
        async *sftpReadChunks() { yield Buffer.from('hello') },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    // Setting exactly at the ceiling: the operator picked this number, so the
    // message must not claim a hard ceiling they did not set. Deriving the
    // source from `limit === HARD_MAX_BYTES` would get this wrong.
    await assert.rejects(
      () => stagePresentFiles(api, sessionRoute, [{ path: 'report.txt' }], {}, { maxBytes: HARD_MAX_BYTES, cache }),
      new RegExp(`over the ${HARD_MAX_BYTES} byte delivery limit`),
    )
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('a setting above the ceiling is reported as a raised setting, not as "no limit"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-raised-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const cache = createPresentCache(join(root, '.deliverables'))
    const api = {
      pool: {
        sftpAttrs: async () => ({ type: 'file', size: HARD_MAX_BYTES + 1 }),
        async *sftpReadChunks() { yield Buffer.from('x') },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    // 300 MiB is not "no limit"; telling the operator their setting says
    // "unlimited" when it says 300 MiB sends them to the wrong place.
    await assert.rejects(
      () => stagePresentFiles(api, sessionRoute, [{ path: 'report.txt' }], {}, { maxBytes: HARD_MAX_BYTES * 2, cache }),
      new RegExp(`over the ${HARD_MAX_BYTES} byte snapshot limit \\(the transfer setting asks for more`),
    )
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('a pool without sftpReadChunks still delivers, through sftpRead', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-fallback-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const cache = createPresentCache(join(root, '.deliverables'))
    // An older pool (and a few test doubles) has no chunked read.
    const api = {
      pool: {
        sftpAttrs: async () => ({ type: 'file', size: 5 }),
        sftpRead: async () => Buffer.from('hello'),
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    const [entry] = await stagePresentFiles(api, sessionRoute, [{ path: 'report.txt' }], {}, { maxBytes: 0, cache })
    assert.equal(entry!.bytes, 5)
    assert.equal(await readFile(entry!.path, 'utf8'), 'hello')
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('an empty remote file is a valid delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-empty-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const cache = createPresentCache(join(root, '.deliverables'))
    const api = {
      pool: {
        sftpAttrs: async () => ({ type: 'file', size: 0 }),
        // An empty file yields no chunk at all; the loop must still succeed.
        async *sftpReadChunks() { /* nothing to yield */ },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    const [entry] = await stagePresentFiles(api, sessionRoute, [{ path: 'empty.txt' }], {}, { maxBytes: 0, cache })
    assert.equal(entry!.bytes, 0)
    assert.equal(entry!.hash, createHash('sha256').update('').digest('hex'))
    assert.equal((await stat(entry!.path)).size, 0)
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('one remote file named twice is transferred once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-dedupe-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const cache = createPresentCache(join(root, '.deliverables'))
    let reads = 0
    const api = {
      pool: {
        sftpAttrs: async () => ({ type: 'file', size: 5 }),
        async *sftpReadChunks() { reads += 1; yield Buffer.from('hello') },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    // Two spellings of the same remote file: a relative path and the absolute
    // one it resolves to. One transfer, two results in request order.
    const staged = await stagePresentFiles(
      api,
      sessionRoute,
      [{ path: 'report.txt' }, { path: '/srv/app/report.txt' }],
      {},
      { maxBytes: 0, cache },
    )
    assert.equal(reads, 1)
    assert.equal(staged.length, 2)
    assert.equal(staged[0]!.path, staged[1]!.path)
    assert.equal(staged[1]!.remotePath, '/srv/app/report.txt')
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('unloading removes the delivery copies it staged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-clear-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    const api = {
      pool: {
        sftpStat: async () => ({ isDirectory: false, size: 5 }),
        sftpRead: async () => Buffer.from('hello'),
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    const staged = await stagePresentFiles(api, sessionRoute, [{ path: 'out/report.txt' }], { signal: new AbortController().signal })
    const target = staged[0]!.path
    assert.equal(await readFile(target, 'utf8'), 'hello')
    await clearStagedPresentFiles([target])
    assert.equal(existsSync(target), false)
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('clearing delivery copies leaves files this process did not stage alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-keep-'))
  try {
    process.env.DSH_SSH_REMOTE_ROOT = root
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { ...route, remoteCwd: '/srv/app', placeholderCwd: mapping }
    // A file the operator put in the placeholder tree by hand. The clearer must
    // only remove paths this process wrote, never everything under the root.
    const foreign = join(mapping, 'out', 'foreign.txt')
    await mkdir(join(mapping, 'out'), { recursive: true })
    await writeFile(foreign, 'mine')
    await clearStagedPresentFiles([foreign])
    assert.equal(await readFile(foreign, 'utf8'), 'mine')
  } finally {
    delete process.env.DSH_SSH_REMOTE_ROOT
    await rm(root, { recursive: true, force: true })
  }
})

test('a transport failure is reported as such, not as a missing file', async () => {
  const api = {
    pool: {
      sftpStat: async () => {
        throw new Error('Timed out while waiting for handshake')
      },
    } as unknown as SshPool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'read-only' as const,
  } satisfies ToolHost
  // A connection fault must not read as "no file": that would send the model
  // hunting for a path that exists on a host it simply cannot reach right now.
  await assert.rejects(
    () => stagePresentFiles(api, route, [{ path: 'report.txt' }], {}),
    (error: unknown) => error instanceof Error
      && /could not stat/.test(error.message)
      && /Timed out while waiting for handshake/.test(error.message)
      && !/no file at/.test(error.message),
  )
})
