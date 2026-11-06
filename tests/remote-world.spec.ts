import assert from 'node:assert/strict'
import test from 'node:test'
import type { RunnerStatus } from '../src/execute.ts'
import { installRemoteWorld, installWorkerPathMap, remoteWorldContext, type RemoteWorld } from '../src/remote-world.ts'
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
