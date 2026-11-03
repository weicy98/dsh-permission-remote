import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { HostConfig } from '../src/config.ts'
import { clearStagedPresentFiles, stagePresentFiles, type RunnerStatus, type ToolHost } from '../src/execute.ts'
import { apply } from '../src/index.ts'
import { mapRemoteToLocal, type RemoteRoute } from '../src/router.ts'
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

const status: RunnerStatus = {
  os: 'linux',
  sandbox: { available: false, reason: 'missing' },
  sandboxTool: 'none',
  ripgrep: 'system',
  ripgrepPath: '/usr/bin/rg',
  roots: { workspaceRoot: '/srv/app', tmp: '/tmp', userTmp: '/tmp' },
  install: null,
}

test('a delivery that finishes during unload does not leave its copy behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-race-'))
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = root
  try {
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { kind: 'remote', hostId: 'host1', remoteCwd: '/srv/app', placeholderCwd: mapping }
    let release: () => void = () => undefined
    let entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    let reads = 0
    const api = {
      pool: {
        sftpStat: async () => ({ isDirectory: false, size: 5 }),
        sftpRead: () => {
          reads += 1
          if (reads > 1) return Promise.resolve(Buffer.from('hello'))
          return new Promise<Buffer>(resolve => {
            entered()
            release = () => resolve(Buffer.from('hello'))
          })
        },
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    const pending = stagePresentFiles(api, sessionRoute, [{ path: 'out/report.txt' }], { signal: new AbortController().signal })
    await reading
    const clearing = clearStagedPresentFiles()
    release()
    await clearing
    await assert.rejects(pending, /plugin is unloading/)
    assert.equal(existsSync(join(mapping, 'out', 'report.txt')), false)

    const again = await stagePresentFiles(api, sessionRoute, [{ path: 'out/later.txt' }], { signal: new AbortController().signal })
    assert.equal(await readFile(again[0]!.path, 'utf8'), 'hello')
    await clearStagedPresentFiles([again[0]!.path])
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('plugin unload waits until the delivery copies it staged are gone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-apply-'))
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = root
  const ctx = new Context()
  ctx.provide('settings', { configure: () => () => undefined, describe: () => [], update: async () => undefined })
  ctx.provide('credentials', { readRecord: async () => undefined, modifyRecord: async () => undefined })
  const disposers: Array<() => unknown> = []
  const writable = ctx as unknown as { effect(execute: () => unknown): unknown }
  const original = writable.effect.bind(ctx)
  writable.effect = execute => original(() => {
    const dispose = execute()
    if (typeof dispose === 'function') disposers.push(dispose as () => unknown)
    return dispose
  })
  try {
    apply(ctx, { hosts: [], maxConnections: 4 })
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { kind: 'remote', hostId: 'host1', remoteCwd: '/srv/app', placeholderCwd: mapping }
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
    let sawPromise = false
    for (const dispose of disposers) {
      const result = dispose()
      if (result instanceof Promise) {
        sawPromise = true
        await result
      }
    }
    assert.equal(sawPromise, true)
    assert.equal(existsSync(target), false)
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('present refuses a non-regular remote file instead of blocking on it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-special-'))
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = root
  try {
    const mapping = mapRemoteToLocal('host1', '/srv/app')!
    const sessionRoute: RemoteRoute = { kind: 'remote', hostId: 'host1', remoteCwd: '/srv/app', placeholderCwd: mapping }
    const api = {
      pool: {
        sftpStat: async () => ({ isDirectory: false, size: 0, type: 'other' }),
        sftpRead: async () => Buffer.alloc(0),
      } as unknown as SshPool,
      hostOf: () => host,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async () => 'read-only' as const,
    } satisfies ToolHost
    await assert.rejects(
      () => stagePresentFiles(api, sessionRoute, [{ path: 'pipe' }], { signal: new AbortController().signal }),
      (error: unknown) => error instanceof FsError && error.code === 'FS_IO_ERROR',
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})
