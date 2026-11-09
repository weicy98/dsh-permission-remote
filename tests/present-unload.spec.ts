/**
 * What plugin unload does, and does not, do to a delivery.
 *
 * A card resolves its path when the user opens it, with no time limit, so the
 * copy behind it has to outlive the plugin run that produced it. The two staging
 * modes differ here on purpose:
 *
 * - Placeholders (`fs`-tree paths) are rewritten on every delivery and are
 *   cleaned up at unload, because nothing about them is immutable.
 * - Snapshots are content addressed and pruned by age, so unload must leave them
 *   alone: removing them would blank a card that is still on screen, which is
 *   the exact failure the snapshot design exists to prevent.
 *
 * One test here also pins the unload race: a delivery that finishes *during* an
 * unload must not leave a copy behind that the unload already walked past.
 */
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
import { openPresentCache } from '../src/present-cache.ts'
import { clearSupersededRoots, mapRemoteToLocal, setRemoteRootOverride, type RemoteRoute } from '../src/router.ts'
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
  home: '/home/dev',
  install: null,
}

/** Point the plugin at a scratch root for the duration of one test. */
async function scratchRoot(prefix: string): Promise<{ root: string, route: RemoteRoute, dispose: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = root
  setRemoteRootOverride(null)
  clearSupersededRoots()
  const mapping = mapRemoteToLocal('host1', '/srv/app')!
  return {
    root,
    route: { kind: 'remote', hostId: 'host1', remoteCwd: '/srv/app', placeholderCwd: mapping },
    dispose: async () => {
      setRemoteRootOverride(null)
      clearSupersededRoots()
      if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
      else process.env.DSH_SSH_REMOTE_ROOT = previous
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * A pool that serves one body. `sftpRead` is kept for the placeholder path and
 * `sftpReadChunks` for the snapshot path, which streams instead of buffering.
 */
function poolOf(body: Buffer, hooks?: { beforeRead?: () => Promise<void> }): SshPool {
  return {
    sftpStat: async () => ({ isDirectory: false, size: body.length }),
    sftpAttrs: async () => ({ type: 'file', size: body.length, mtime: 1 }),
    sftpRead: async () => body,
    sftpReadChunks: async function* () {
      await hooks?.beforeRead?.()
      yield body
    },
  } as unknown as SshPool
}

function hostApiOf(pool: SshPool): ToolHost {
  return {
    pool,
    hostOf: () => host,
    secretOf: async () => ({}),
    statusOf: async () => status,
    resolveMode: async () => 'read-only' as const,
  } satisfies ToolHost
}

test('a placeholder delivery that finishes during unload does not leave its copy behind', async () => {
  const scratch = await scratchRoot('dsh-present-race-')
  try {
    let release: () => void = () => undefined
    let entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    let reads = 0
    const api = hostApiOf({
      sftpStat: async () => ({ isDirectory: false, size: 5 }),
      sftpRead: () => {
        reads += 1
        if (reads > 1) return Promise.resolve(Buffer.from('hello'))
        return new Promise<Buffer>(resolve => {
          entered()
          release = () => resolve(Buffer.from('hello'))
        })
      },
    } as unknown as SshPool)
    // No `cache`: this is the placeholder mode, whose copies unload owns.
    const pending = stagePresentFiles(api, scratch.route, [{ path: 'out/report.txt' }], { signal: new AbortController().signal })
    await reading
    const clearing = clearStagedPresentFiles()
    release()
    await clearing
    await assert.rejects(pending, /plugin is unloading/)
    assert.equal(existsSync(join(scratch.route.placeholderCwd, 'out', 'report.txt')), false)

    const again = await stagePresentFiles(api, scratch.route, [{ path: 'out/later.txt' }], { signal: new AbortController().signal })
    assert.equal(await readFile(again[0]!.path, 'utf8'), 'hello')
    await clearStagedPresentFiles([again[0]!.path])
  } finally {
    await scratch.dispose()
  }
})

test('a snapshot delivery that finishes during unload keeps the published bytes', async () => {
  const scratch = await scratchRoot('dsh-present-race-snapshot-')
  try {
    const cache = await openPresentCache()
    assert.ok(cache, 'the cache root must be creatable under a writable remote root')
    let release: () => void = () => undefined
    let entered!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    let chunks = 0
    const api = hostApiOf({
      sftpStat: async () => ({ isDirectory: false, size: 5 }),
      sftpAttrs: async () => ({ type: 'file', size: 5, mtime: 1 }),
      sftpReadChunks: async function* () {
        chunks += 1
        if (chunks > 1) {
          yield Buffer.from('hello')
          return
        }
        await new Promise<void>(resolve => {
          entered()
          release = resolve
        })
        yield Buffer.from('hello')
      },
    } as unknown as SshPool)
    const pending = stagePresentFiles(api, scratch.route, [{ path: 'out/report.txt' }], { signal: new AbortController().signal }, {
      maxBytes: 1024,
      cache,
    })
    await reading
    // An unload that starts while the bytes are still in flight. Surprising as
    // it looks, this must not delete anything: a snapshot names its own content,
    // so the published file is already the finished article and the card that
    // records it may be opening right now.
    const clearing = clearStagedPresentFiles()
    release()
    await clearing
    const [staged] = await pending
    assert.ok(staged)
    assert.equal(staged.reused, false)
    assert.equal(staged.remotePath, '/srv/app/out/report.txt')
    assert.equal(staged.bytes, 5)

    // Read it back through a freshly opened cache: that is what a card does
    // after a reload, and it is the path an unload must not have touched.
    const reopened = await openPresentCache()
    assert.ok(reopened)
    const snapshot = reopened.targetFor(staged.hash, 'report.txt')
    assert.equal(snapshot, staged.path)
    assert.equal(await readFile(snapshot, 'utf8'), 'hello')
    // Nothing was left half-written, either.
    assert.equal(existsSync(join(cache.root, '.tmp')), true)
    const leftovers = await readFile(staged.path, 'utf8')
    assert.equal(leftovers, 'hello')
  } finally {
    await scratch.dispose()
  }
})

test('plugin unload removes the placeholder copies it staged', async () => {
  const scratch = await scratchRoot('dsh-present-apply-')
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
    const api = hostApiOf(poolOf(Buffer.from('hello')))
    // Placeholder mode: no cache, so the copy lives in the placeholder tree and
    // the plugin owns its lifetime.
    const staged = await stagePresentFiles(api, scratch.route, [{ path: 'out/report.txt' }], { signal: new AbortController().signal })
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
    await scratch.dispose()
  }
})

test('plugin unload leaves published snapshots for the card to open', async () => {
  const scratch = await scratchRoot('dsh-present-apply-snapshot-')
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
    const cache = await openPresentCache()
    assert.ok(cache)
    const api = hostApiOf(poolOf(Buffer.from('pdf')))
    const staged = await stagePresentFiles(api, scratch.route, [{ path: 'out/report.pdf' }], { signal: new AbortController().signal }, {
      maxBytes: 1024,
      cache,
    })
    const snapshot = staged[0]!.path
    assert.equal(await readFile(snapshot, 'utf8'), 'pdf')
    for (const dispose of disposers) {
      const result = dispose()
      if (result instanceof Promise) await result
    }
    // The whole point of the snapshot layout: the record on screen outlives the
    // plugin run. Only the TTL removes this file.
    assert.equal(existsSync(snapshot), true)
    assert.equal(await readFile(snapshot, 'utf8'), 'pdf')
    const reopened = await openPresentCache()
    assert.ok(reopened)
    assert.equal(reopened.targetFor(staged[0]!.hash, 'report.pdf'), snapshot)
    assert.equal(await readFile(reopened.targetFor(staged[0]!.hash, 'report.pdf'), 'utf8'), 'pdf')
  } finally {
    await scratch.dispose()
  }
})

test('present refuses a non-regular remote file instead of blocking on it', async () => {
  const scratch = await scratchRoot('dsh-present-special-')
  try {
    const api = hostApiOf({
      sftpStat: async () => ({ isDirectory: false, size: 0, type: 'other' }),
      sftpAttrs: async () => ({ type: 'other', size: 0, mtime: 1 }),
      sftpRead: async () => Buffer.alloc(0),
    } as unknown as SshPool)
    await assert.rejects(
      () => stagePresentFiles(api, scratch.route, [{ path: 'pipe' }], { signal: new AbortController().signal }),
      (error: unknown) => error instanceof FsError && error.code === 'FS_NOT_REGULAR_FILE',
    )
  } finally {
    await scratch.dispose()
  }
})
