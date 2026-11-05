import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { RunnerStatus } from '../src/execute.ts'
import { installRemoteWorld } from '../src/remote-world.ts'
import { installRemoteShell } from '../src/remote-shell.ts'
import { mapRemoteToLocal } from '../src/router.ts'
import { LocalTransport } from './helpers/local-ptc.ts'

const require = createRequire(import.meta.url)
const ANCHOR = join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
let bashModule: any
try {
  bashModule = await import(pathToFileURL(createRequire(ANCHOR).resolve('@deepseek-ai/dsh-bash-sandbox')).href)
} catch {
  bashModule = undefined
}
const SKIP = bashModule === undefined ? 'official bash package is not available' : false

function statusFor(root: string): RunnerStatus {
  return {
    os: 'linux',
    sandbox: { available: false, reason: 'missing' },
    sandboxTool: 'none',
    ripgrep: 'system',
    ripgrepPath: '/usr/bin/rg',
    roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
    home: root,
    node: { available: true, path: '/usr/bin/node', version: '22.20.0', major: 22 },
    install: null,
  }
}

test('official SandboxBashExecutor runs through the generic remote subprocess world', { skip: SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-bash-'))
  const placeholder = mapRemoteToLocal('h1', root)!
  const status = statusFor(root)
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => process.execPath,
  }
  const sandbox = {
    confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  }
  const ctx = new Context()
  ctx.provide('subprocess', subprocess)
  ctx.provide('sandbox', sandbox)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'danger-full-access',
    resolve: () => ({ mode: 'danger-full-access', workspaceRoot: placeholder }),
  })
  const restore = installRemoteWorld(ctx as unknown as { get(name: string): unknown }, {
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
  try {
    await ctx.plugin(bashModule.default, {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxTimeoutMs: 20_000,
      maxOutputBytes: 64_000,
      maxSpillBytes: 1_000_000,
      graceMs: 1000,
    })
    const shell = ctx.get('shell') as any
    const spec = shell.resolve({ command: 'printf hello', workdir: placeholder })
    const execution = await shell.execute(spec)
    const result = await execution.result()
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.text, 'hello')
    assert.equal(result.sandbox?.mode, 'danger-full-access')
  } finally {
    restore!()
    await rm(root, { recursive: true, force: true })
  }
})


test('remote shell adapter preserves loginEnv through the official SandboxBashExecutor', { skip: SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-bash-login-'))
  const placeholder = mapRemoteToLocal('h1', root)!
  const status = statusFor(root)
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => process.execPath,
  }
  const sandbox = {
    confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  }
  const host = {
    id: 'h1', name: '', host: '127.0.0.1', port: 22, username: 'u', auth: 'key' as const,
    privateKeyPath: '', fingerprint: '', opsPolicy: 'ask' as const, loginEnv: true,
  }
  const ctx = new Context()
  ctx.provide('subprocess', subprocess)
  ctx.provide('sandbox', sandbox)
  ctx.provide('sandboxPolicy', {
    defaultMode: 'danger-full-access',
    resolve: () => ({ mode: 'danger-full-access', workspaceRoot: placeholder }),
  })
  const restoreWorld = installRemoteWorld(ctx as unknown as { get(name: string): unknown }, {
    transport: new LocalTransport(),
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === placeholder ? { kind: 'remote', hostId: 'h1', remoteCwd: root, placeholderCwd: placeholder } : { kind: 'local' },
  })
  assert.ok(restoreWorld !== undefined)
  let restoreShell: (() => void) | undefined
  try {
    await ctx.plugin(bashModule.default, {
      cwd: process.cwd(),
      timeoutMs: 10_000,
      maxTimeoutMs: 20_000,
      maxOutputBytes: 64_000,
      maxSpillBytes: 1_000_000,
      graceMs: 1000,
    })
    restoreShell = installRemoteShell(ctx as unknown as { get(name: string): unknown }, {
      routeByCwd: cwd => cwd === placeholder ? { kind: 'remote', hostId: 'h1', remoteCwd: root, placeholderCwd: placeholder } : { kind: 'local' },
      hostOf: () => host,
      loginEnvOf: async () => 'declare -x SNAP=from-login\n',
    })
    assert.ok(restoreShell !== undefined)
    const shell = ctx.get('shell') as any
    const spec = shell.resolve({ command: 'printf "$SNAP"', workdir: placeholder })
    const execution = await shell.execute(spec)
    const result = await execution.result()
    assert.equal(result.exitCode, 0, JSON.stringify(result))
    assert.equal(result.stdout.text, 'from-login')
  } finally {
    restoreShell!()
    restoreWorld!()
    await rm(root, { recursive: true, force: true })
  }
})

test('official SandboxBashExecutor workspace-write uses the generic remote bwrap profile', { skip: SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-bash-write-'))
  const placeholder = mapRemoteToLocal('h1', root)!
  const status: RunnerStatus = {
    ...statusFor(root),
    sandbox: { available: true, reason: 'ok' },
    sandboxTool: 'bwrap',
  }
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => process.execPath,
  }
  const sandbox = { confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }) }
  const ctx = new Context()
  ctx.provide('subprocess', subprocess)
  ctx.provide('sandbox', sandbox)
  ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write', resolve: () => ({ mode: 'workspace-write', workspaceRoot: placeholder }) })
  const restore = installRemoteWorld(ctx as unknown as { get(name: string): unknown }, {
    transport: new LocalTransport(),
    hostOf: () => ({ id: 'h1', name: '', host: '127.0.0.1', port: 22, username: 'u', auth: 'key', privateKeyPath: '', fingerprint: '', opsPolicy: 'ask' }),
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === placeholder ? { kind: 'remote', hostId: 'h1', remoteCwd: root, placeholderCwd: placeholder } : { kind: 'local' },
  })
  assert.ok(restore !== undefined)
  try {
    await ctx.plugin(bashModule.default, { cwd: process.cwd(), timeoutMs: 10_000, maxTimeoutMs: 20_000, maxOutputBytes: 64_000, maxSpillBytes: 1_000_000, graceMs: 1000 })
    const shell = ctx.get('shell') as any
    const execution = await shell.execute(shell.resolve({ command: 'printf hi > proof.txt', workdir: placeholder }))
    const result = await execution.result()
    assert.equal(result.exitCode, 0, JSON.stringify(result))
    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(join(root, 'proof.txt'), 'utf8'), 'hi')
    assert.equal(result.sandbox?.mode, 'workspace-write')
  } finally {
    restore!()
    await rm(root, { recursive: true, force: true })
  }
})
