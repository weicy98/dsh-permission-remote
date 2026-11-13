import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunnerStatus } from '../src/execute.ts'
import { installRemoteWorld, installWorkerPathMap, remoteWorldContext, type RemoteWorld } from '../src/remote-world.ts'
import { rememberTerminalHistory, resetRemoteTerminalState, runRemoteTerminal } from '../src/terminal-remote-state.ts'
import type { RemoteTransport } from '../src/remote-transport.ts'

const status: RunnerStatus = {
  os: 'linux',
  sandbox: { available: true, reason: 'ok' },
  sandboxTool: 'bwrap',
  ripgrep: 'system',
  ripgrepPath: '/usr/bin/rg',
  roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
  home: '/home/dev',
  node: { available: true, path: '/usr/bin/node', version: '22.20.0', major: 22 },
  install: null,
}

const world: RemoteWorld = {
  host: {
    id: 'h1', name: '', host: '127.0.0.1', port: 22, username: 'u', auth: 'key',
    privateKeyPath: '', fingerprint: '', opsPolicy: 'ask',
  },
  secret: {},
  status,
  remoteCwd: '/srv/app/sub',
  remoteRoot: '/srv/app',
  remoteNodePath: '/usr/bin/node',
  remoteRipgrepPath: '/usr/bin/rg',
  workerLocalPaths: ['/host/dsh/lib/process.js'],
  workerRemotePath: '/home/dev/.dsh-permission-remote/ptc/hash/process.mjs',
  shimRemotePath: '/home/dev/.dsh-permission-remote/ptc/hash/ptc-shim.mjs',
  launchExecutable: '/usr/local/bin/node',
  resolvedLocalExecutable: '/usr/local/bin/node',
}

function fakeTransport(): RemoteTransport {
  return {
    async exec() { throw new Error('not used') },
    async forwardOutStreamLocal() { throw new Error('not used') },
    async forwardOutTcp() { throw new Error('not used') },
  }
}

test('confine produces the remote bwrap profile and maps the node path', async () => {
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => '/usr/local/bin/node',
  }
  const sandbox = {
    confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  }
  const ctx = { get: (name: string) => name === 'subprocess' ? subprocess : name === 'sandbox' ? sandbox : undefined }
  const restore = installRemoteWorld(ctx, {
    transport: fakeTransport(),
    hostOf: () => world.host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === world.remoteCwd ? { kind: 'remote', hostId: 'h1', remoteCwd: world.remoteCwd, placeholderCwd: cwd } : { kind: 'local' },
  })
  assert.ok(restore !== undefined)
  try {
    // A non-PTC spawn still takes the original path.
    assert.deepEqual(subprocess.spawn({ stdio: { control: 'pipe' } } as never), { marker: 'original-spawn' })
    assert.deepEqual(await sandbox.confine(['bash', '-c', 'true'], { mode: 'workspace-write', workspaceRoot: '/placeholder' } as never), {
      argv: ['bash', '-c', 'true'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [],
    })

    const confined = await remoteWorldContext.run(world, () => sandbox.confine([
      '/usr/local/bin/node', '--max-old-space-size=256', world.workerRemotePath, '1000',
    ], { mode: 'workspace-write', workspaceRoot: '/placeholder' } as never))
    assert.equal(confined.argv[0], 'bwrap')
    assert.equal(confined.argv.includes('/usr/bin/node'), true, JSON.stringify(confined.argv))
    assert.equal(confined.argv.includes('--chdir'), true)
    assert.equal(confined.argv.includes(world.remoteCwd), true)
    assert.equal(confined.argv.includes('/srv/app'), true)
    assert.equal(confined.enforcement, 'full')
    assert.deepEqual(confined.denialSignatures, ['read-only file system'])
  } finally {
    restore!()
  }
})

test('seatbelt confinement grants the same writable roots as the remote bash path', async () => {
  const macStatus: RunnerStatus = {
    os: 'darwin',
    sandbox: { available: true, reason: 'ok' },
    sandboxTool: 'sandbox-exec',
    ripgrep: 'system',
    ripgrepPath: '/usr/bin/rg',
    roots: { workspaceRoot: '/Users/dev/app', tmp: '/private/tmp', userTmp: '/var/folders/xy/T' },
    home: '/Users/dev',
    node: { available: true, path: '/usr/bin/node', version: '22.20.0', major: 22 },
    install: null,
  }
  const macWorld: RemoteWorld = {
    ...world,
    status: macStatus,
    remoteCwd: '/Users/dev/app/sub',
    remoteRoot: '/Users/dev/app',
  }
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => '/usr/local/bin/node',
  }
  const sandbox = {
    confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  }
  const ctx = { get: (name: string) => name === 'subprocess' ? subprocess : name === 'sandbox' ? sandbox : undefined }
  const restore = installRemoteWorld(ctx, {
    transport: fakeTransport(),
    hostOf: () => macWorld.host,
    secretOf: async () => ({}),
    statusOf: async () => macStatus,
    routeByCwd: cwd => cwd === macWorld.remoteCwd ? { kind: 'remote', hostId: 'h1', remoteCwd: macWorld.remoteCwd, placeholderCwd: cwd } : { kind: 'local' },
  })
  assert.ok(restore !== undefined)
  try {
    const confined = await remoteWorldContext.run(macWorld, () => sandbox.confine([
      '/usr/local/bin/node', macWorld.workerRemotePath, '1000',
    ], { mode: 'workspace-write', workspaceRoot: '/placeholder' } as never))
    assert.equal(confined.argv[0], 'sandbox-exec')
    const profile = confined.argv[2] ?? ''
    // The bash path grants workspace + temp roots under workspace-write; a PTC
    // program that can write less than bash silently breaks temp-file use.
    for (const root of ['/Users/dev/app', '/private/tmp', '/var/folders/xy/T']) {
      assert.equal(profile.includes(root), true, `seatbelt profile must grant ${root}: ${profile}`)
    }
    // read-only grants none of them.
    const readOnly = await remoteWorldContext.run(macWorld, () => sandbox.confine([
      '/usr/local/bin/node', macWorld.workerRemotePath, '1000',
    ], { mode: 'read-only', workspaceRoot: '/placeholder' } as never))
    const readOnlyProfile = readOnly.argv[2] ?? ''
    for (const root of ['/Users/dev/app', '/private/tmp']) {
      assert.equal(readOnlyProfile.includes(root), false, `read-only must not grant ${root}`)
    }
  } finally {
    restore!()
  }
})

test('generic remote confinement does not override the caller cd with --chdir', async () => {
  // The generic branch only knows policy.workspaceRoot, while a terminal may
  // `cd` to a requested subdirectory before exec. A --chdir here would send it
  // back to the workspace root; the terminal command builders add the real cwd.
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => '/usr/local/bin/node',
  }
  const sandbox = {
    confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  }
  const ctx = { get: (name: string) => name === 'subprocess' ? subprocess : name === 'sandbox' ? sandbox : undefined }
  const restore = installRemoteWorld(ctx, {
    transport: fakeTransport(),
    hostOf: () => world.host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === world.remoteCwd ? { kind: 'remote', hostId: 'h1', remoteCwd: world.remoteCwd, placeholderCwd: cwd } : { kind: 'local' },
  })
  assert.ok(restore !== undefined)
  try {
    const confined = await sandbox.confine(['bash', '-c', 'pwd'], {
      mode: 'workspace-write',
      workspaceRoot: world.remoteCwd,
    } as never)
    assert.equal(confined.argv[0], 'bwrap')
    const separator = confined.argv.indexOf('--')
    assert.ok(separator > 2, JSON.stringify(confined.argv))
    // Leaving --chdir to the terminal launcher prevents this generic branch
    // from overriding a different cwd the caller already cd'd into.
    assert.equal(confined.argv.includes('--chdir'), false, JSON.stringify(confined.argv))
    assert.ok(confined.argv.includes('--tmpfs'), JSON.stringify(confined.argv))
    assert.deepEqual(confined.argv.slice(separator + 1), ['bash', '-c', 'pwd'])
  } finally {
    restore!()
  }
})

test('terminalEnvironment reports the remote platform only during a remote allocation', async () => {
  const localShell = { platform: 'posix', defaultShell: '/bin/zsh' }
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => '/usr/local/bin/node',
    terminalEnvironment: async () => localShell,
  }
  const sandbox = {
    confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  }
  const ctx = { get: (name: string) => name === 'subprocess' ? subprocess : name === 'sandbox' ? sandbox : undefined }
  const restore = installRemoteWorld(ctx, {
    transport: fakeTransport(),
    hostOf: () => world.host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === world.remoteCwd ? { kind: 'remote', hostId: 'h1', remoteCwd: world.remoteCwd, placeholderCwd: cwd } : { kind: 'local' },
  })
  assert.ok(restore !== undefined)
  try {
    // A local session must keep its own default shell.
    assert.deepEqual(await subprocess.terminalEnvironment(), localShell)
    const remote = { hostId: 'h1', remoteCwd: world.remoteCwd, placeholderCwd: '/placeholder' }
    // Start a local call in the outer async context; it must keep the local
    // default shell even while the remote allocation is running.
    const concurrentLocal = subprocess.terminalEnvironment()
    await runRemoteTerminal(remote, async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      // No defaultShell: upstream resolveShell falls back to /bin/sh, which
      // exists on every host this plugin supports.
      assert.deepEqual(await subprocess.terminalEnvironment(), { platform: 'posix' })
    })
    assert.deepEqual(await concurrentLocal, localShell)
    assert.deepEqual(await subprocess.terminalEnvironment(), localShell)
  } finally {
    restore!()
    resetRemoteTerminalState()
  }
})

test('rc.2 history cleanup is routed once by terminal id', async () => {
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => '/usr/local/bin/node',
    terminalEnvironment: async () => ({ platform: 'posix' }),
  }
  const sandbox = {
    confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  }
  const ctx = { get: (name: string) => name === 'subprocess' ? subprocess : name === 'sandbox' ? sandbox : undefined }
  const restore = installRemoteWorld(ctx, {
    transport: fakeTransport(),
    hostOf: () => world.host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === world.remoteCwd ? { kind: 'remote', hostId: 'h1', remoteCwd: world.remoteCwd, placeholderCwd: cwd } : { kind: 'local' },
  })
  assert.ok(restore !== undefined)
  try {
    const route = { hostId: 'h1', remoteCwd: world.remoteCwd, placeholderCwd: '/placeholder' }
    rememberTerminalHistory('terminal-1', route)
    const spec = {
      argv: ['rm', '-f', '--', '/tmp/dsh-agent-history-terminal-1'],
      cwd: '/',
      stdio: { stdin: 'ignore' as const, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
    }
    const routed = subprocess.spawn(spec) as unknown as { done: Promise<unknown> }
    assert.notDeepEqual(routed, { marker: 'original-spawn' }, 'the cleanup must not spawn locally')
    await routed.done.catch(() => undefined)
    // Single use: a second identical rm is no longer hijacked.
    assert.deepEqual(subprocess.spawn(spec), { marker: 'original-spawn' })
  } finally {
    restore!()
    resetRemoteTerminalState()
  }
})

test('session-registered additional writable roots are refused instead of ignored', async () => {
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => '/usr/local/bin/node',
    terminalEnvironment: async () => ({ platform: 'posix' }),
  }
  const sandbox = {
    confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  }
  const ctx = { get: (name: string) => name === 'subprocess' ? subprocess : name === 'sandbox' ? sandbox : undefined }
  const restore = installRemoteWorld(ctx, {
    transport: fakeTransport(),
    hostOf: () => world.host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === world.remoteCwd ? { kind: 'remote', hostId: 'h1', remoteCwd: world.remoteCwd, placeholderCwd: cwd } : { kind: 'local' },
  })
  assert.ok(restore !== undefined)
  try {
    await assert.rejects(
      () => sandbox.confine(['bash', '-c', 'true'], { mode: 'workspace-write', workspaceRoot: world.remoteCwd, additionalWritableRoots: ['/extra'] } as never),
      /does not support additional writable roots/u,
    )
    // A local session must fall through to the original confine untouched.
    const local = await sandbox.confine(['bash', '-c', 'true'], {
      mode: 'workspace-write',
      workspaceRoot: '/tmp/local-project',
      additionalWritableRoots: ['/tmp/extra'],
    } as never)
    assert.deepEqual(local.argv, ['bash', '-c', 'true'])
  } finally {
    restore!()
  }
})

test('worker path map only applies inside the PTC world', () => {
  const fs = { processPathFromHostPath: (path: string) => `original:${path}` }
  const remove = installWorkerPathMap(fs)
  try {
    assert.equal(fs.processPathFromHostPath('/host/dsh/lib/process.js'), 'original:/host/dsh/lib/process.js')
    const mapped = remoteWorldContext.run(world, () => fs.processPathFromHostPath('/host/dsh/lib/process.js'))
    assert.equal(mapped, world.workerRemotePath)
  } finally {
    remove()
  }
  assert.equal(fs.processPathFromHostPath('/host/dsh/lib/process.js'), 'original:/host/dsh/lib/process.js')
})
