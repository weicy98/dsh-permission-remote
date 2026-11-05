import assert from 'node:assert/strict'
import test from 'node:test'
import { runOfficialBash, runOfficialSearch } from '../src/index.ts'
import { mapRemoteToLocal } from '../src/router.ts'

const remoteCwd = '/srv/app'
const placeholder = mapRemoteToLocal('h1', remoteCwd)!
const route = { kind: 'remote' as const, hostId: 'h1', remoteCwd, placeholderCwd: placeholder }

test('official glob/grep path arguments are rewritten from placeholder to remote paths', async () => {
  const calls: Array<Record<string, unknown>> = []
  const result = await runOfficialSearch((args) => {
    calls.push(args as Record<string, unknown>)
    return 'official-result'
  }, route, { pattern: '*.ts', path: `${placeholder}/src` }, {})
  assert.equal(result, 'official-result')
  assert.deepEqual(calls, [{ pattern: '*.ts', path: '/srv/app/src' }])
})

test('official glob/grep keep a missing path undefined', async () => {
  const calls: Array<Record<string, unknown>> = []
  await runOfficialSearch((args) => {
    calls.push(args as Record<string, unknown>)
    return 'ok'
  }, route, { pattern: '*.ts' }, {})
  assert.deepEqual(calls, [{ pattern: '*.ts' }])
})


const ANCHOR = (await import('node:path')).join((await import('node:path')).dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
let searchModule: any
try {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  searchModule = await import(pathToFileURL(createRequire(ANCHOR).resolve('@deepseek-ai/dsh-tool-fs-search')).href)
} catch {
  searchModule = undefined
}

test('official runRipgrep uses placeholder workingDirectory and complete collected output', { skip: searchModule === undefined ? 'official fs-search package unavailable' : false }, async () => {
  let captured: any
  const fake = {
    collected: {
      stdout: { readFrom: () => ({ text: 'src/a.ts\n', nextOffset: 9, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: () => undefined,
    waitForExit: async () => true,
  }
  const ctx = {
    workingDirectory: { ensure: async () => placeholder },
    subprocess: { spawn: (spec: any) => { captured = spec; return fake } },
  }
  const result = await searchModule.runRipgrep(
    ctx,
    { agent: { session: { header: { id: 's1', cwd: placeholder } } }, signal: new AbortController().signal },
    'glob',
    searchModule.buildGlobCommand({ pattern: '**/*.ts' }),
    10_000,
    1000,
    1000,
  )
  assert.equal(captured.cwd, placeholder)
  assert.equal(captured.argv[0].endsWith('/rg') || captured.argv[0].endsWith('\rg.exe'), true)
  assert.deepEqual(result, { stdout: 'src/a.ts\n', noMatches: false, workdir: placeholder })
})


test('official runRipgrep executes through the generic remote world', { skip: searchModule === undefined ? 'official fs-search package unavailable' : false }, async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Context } = await import('@deepseek-ai/cordis')
  const { installRemoteWorld } = await import('../src/remote-world.ts')
  const { LocalTransport } = await import('./helpers/local-ptc.ts')
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-search-'))
  const placeholder = mapRemoteToLocal('h1', root)!
  const rgPath = (await import('@vscode/ripgrep')).rgPath as string
  const status = {
    os: 'linux' as const,
    sandbox: { available: false, reason: 'missing' as const },
    sandboxTool: 'none' as const,
    ripgrep: 'system' as const,
    ripgrepPath: rgPath,
    roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
    home: root,
    node: { available: true as const, path: '/usr/bin/node', version: '22.20.0', major: 22 },
    install: null,
  }
  const ctx = new Context()
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => process.execPath,
  }
  const sandbox = { confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }) }
  ctx.provide('subprocess', subprocess)
  ctx.provide('sandbox', sandbox)
  const restore = installRemoteWorld(ctx as unknown as { get(name: string): unknown }, {
    transport: new LocalTransport(),
    hostOf: () => ({ id: 'h1', name: '', host: '127.0.0.1', port: 22, username: 'u', auth: 'key', privateKeyPath: '', fingerprint: '', opsPolicy: 'ask' }),
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === placeholder ? { kind: 'remote', hostId: 'h1', remoteCwd: root, placeholderCwd: placeholder } : { kind: 'local' },
  })
  assert.ok(restore !== undefined)
  try {
    await writeFile(join(root, 'a.ts'), 'x')
    const result = await searchModule.runRipgrep({
      workingDirectory: { ensure: async () => placeholder },
      subprocess: ctx.get('subprocess'),
    }, { agent: { session: { header: { id: 's1', cwd: placeholder } } }, signal: new AbortController().signal }, 'glob', searchModule.buildGlobCommand({ pattern: '*.ts' }), 10_000, 1000, 1000)
    assert.equal(result.workdir, placeholder)
    assert.equal(result.stdout.includes('a.ts'), true)
  } finally {
    restore!()
    await rm(root, { recursive: true, force: true })
  }
})


test('official bash workdir arguments are normalized back to the remote placeholder', async () => {
  const calls: Array<Record<string, unknown>> = []
  const result = await runOfficialBash((args) => {
    calls.push(args as Record<string, unknown>)
    return 'official-bash'
  }, route, { command: 'pwd', workdir: `${placeholder}/src` }, {})
  assert.equal(result, 'official-bash')
  assert.equal(calls.length, 1)
  const expected = mapRemoteToLocal('h1', '/srv/app/src')
  assert.equal(calls[0]!.workdir, expected)
})
