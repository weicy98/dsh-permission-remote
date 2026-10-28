import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HostConfig } from '../src/config.ts'
import { cacheRgBinary, probeHost, resolveRgBinary, rgCachePath, rgCachePaths } from '../src/execute.ts'
import type { SshPool } from '../src/ssh-pool.ts'

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

/** A throwaway DSH home so the cache never touches the real one. */
async function scratchHome(): Promise<{ env: NodeJS.ProcessEnv, dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rg-cache-'))
  return { env: { DSH_HOME: root }, dispose: () => rm(root, { recursive: true, force: true }) }
}

test('the cache lives under the harness cache root, not the remote workspace root', () => {
  // `<DSH_HOME>/remote` is the placeholder namespace for remote workspaces, so a
  // binary cached there would sit among host ids, one of which could be named
  // after a platform key.
  const [current] = rgCachePaths('linux-x64', { DSH_HOME: '/home/u/.dsh' })
  assert.equal(current, '/home/u/.dsh/cache/ripgrep/linux-x64/rg')
  assert.equal(rgCachePath('linux-x64', { DSH_HOME: '/home/u/.dsh' }), current)
})

test('a blank DSH_HOME falls back to the default home instead of the cwd', () => {
  const path = rgCachePath('linux-arm64', { DSH_HOME: '   ' })
  assert.match(path, /(^|\/)\.dsh\/cache\/ripgrep\/linux-arm64\/rg$/)
})

test('the pre-move cache location is still read as a fallback', () => {
  assert.deepEqual(rgCachePaths('darwin-arm64', { DSH_HOME: '/home/u/.dsh' }), [
    '/home/u/.dsh/cache/ripgrep/darwin-arm64/rg',
    '/home/u/.dsh/remote/ripgrep/darwin-arm64/rg',
  ])
})

test('a cached binary is found when the package is not installed', async () => {
  const { env, dispose } = await scratchHome()
  try {
    assert.equal(resolveRgBinary('@vscode/ripgrep-does-not-exist', 'linux-x64', env), null)
    const target = await cacheRgBinary('linux-x64', Buffer.from([0x7f, 0x45, 0x4c, 0x46]), env)
    assert.equal(resolveRgBinary('@vscode/ripgrep-does-not-exist', 'linux-x64', env), target)
    // Without a platform there is no cache path to fall back to.
    assert.equal(resolveRgBinary('@vscode/ripgrep-does-not-exist'), null)
  } finally {
    await dispose()
  }
})

test('an installed platform package still wins over the cache', async () => {
  const { env, dispose } = await scratchHome()
  try {
    await cacheRgBinary('linux-x64', Buffer.from([1, 2, 3]), env)
    const resolved = resolveRgBinary('@vscode/ripgrep-linux-x64', 'linux-x64', env)
    // The behaviour an already-working environment had must not change: the
    // package copy, not the download, is what gets uploaded.
    assert.equal(resolved, createRequire(import.meta.url).resolve('@vscode/ripgrep-linux-x64/bin/rg'))
  } finally {
    await dispose()
  }
})

test('a cached binary is executable and readable as a whole', async () => {
  const { env, dispose } = await scratchHome()
  try {
    const body = Buffer.from('binary-body')
    const target = await cacheRgBinary('linux-x64', body, env)
    assert.deepEqual(readFileSync(target), body)
    assert.equal(statSync(target).mode & 0o777, 0o755)
  } finally {
    await dispose()
  }
})

test('concurrent installs of one platform never leave a partial file', async () => {
  const { env, dispose } = await scratchHome()
  try {
    const first = Buffer.alloc(64 * 1024, 1)
    const second = Buffer.alloc(64 * 1024, 2)
    await Promise.all([cacheRgBinary('linux-x64', first, env), cacheRgBinary('linux-x64', second, env)])
    const written = readFileSync(rgCachePath('linux-x64', env))
    assert.equal(written.length, first.length)
    // Whichever write won, the file is one complete body and never a mix.
    assert.ok(written.equals(first) || written.equals(second))
  } finally {
    await dispose()
  }
})

/** A pool whose uploads always fail and whose commands answer as scripted. */
function refusedUploadPool(script: Array<[string, { code: number, stdout?: string }]>): SshPool {
  return {
    async exec(_host: HostConfig, _secret: unknown, command: string) {
      for (const [needle, answer] of script) {
        if (command.includes(needle)) {
          return { code: answer.code, stdout: answer.stdout ?? '', stderr: '', timedOut: false, signal: null, stdoutTruncated: false, stderrTruncated: false }
        }
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null, stdoutTruncated: false, stderrTruncated: false }
    },
    async sftpUpload(): Promise<void> {
      throw new Error('sftp-write: permission denied')
    },
  } as unknown as SshPool
}

test('a refused upload reports upload-failed instead of failing the probe', async () => {
  const { env, dispose } = await scratchHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = env.DSH_HOME
  try {
    await cacheRgBinary('linux-x64', Buffer.from('rg'), env)
    // The remote reports no system rg, so the upload path is the only option.
    const pool = refusedUploadPool([
      ['__DSH_FACTS_BEGIN__', { code: 0, stdout: '__DSH_FACTS_BEGIN__\nLinux\nx86_64\n/tmp\n/tmp\n/home/dev\n__DSH_FACTS_END__\n' }],
      ['__DSH_RG_BEGIN__', { code: 1 }],
      ['bwrap', { code: 0 }],
      ['/etc/os-release', { code: 0, stdout: 'ID=ubuntu\n' }],
    ])
    const status = await probeHost(pool, host, {})
    // The sandbox verdict still arrives; only ripgrep reports the refusal.
    assert.equal(status.sandbox.available, true)
    assert.equal(status.ripgrep, 'upload-failed')
    assert.equal(status.ripgrepPath, '')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await dispose()
  }
})
