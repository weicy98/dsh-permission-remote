/**
 * The gate for delivery snapshots in a remote session.
 *
 * Every other present test mocks either the official tool or the filesystem, so
 * none of them can prove the one thing the design depends on: when the official
 * `present` runs with the session's placeholder cwd, a snapshot path has to reach
 * the *local* backend instead of being translated into a remote path. That
 * translation is invisible to a mock — the mock accepts whatever path it is
 * given — so this file drives the real `installRemoteFs` patch with a real local
 * backend over the real filesystem and asserts which side answered.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { posix } from 'node:path'
import test from 'node:test'

import { FsTargetKey } from '@deepseek-ai/dsh-fs'

import { createPresentCache, openPresentCache } from '../src/present-cache.ts'
import { installRemoteFs, type RemoteAccess } from '../src/remote-fs.ts'
import { clearSupersededRoots, mapRemoteToLocal, setRemoteRootOverride } from '../src/router.ts'
import type { HostConfig } from '../src/config.ts'
import { SshFailure, type SftpAttrs } from '../src/ssh-pool.ts'

const HOST_ID = 'host1'
const REMOTE_ROOT = '/srv/app'

/**
 * A local backend over the real filesystem.
 *
 * `resolve` realpaths, exactly as `dsh-fs-local` does, because that is what the
 * card's verifier compares against: `processPath(resolve(path))` must equal the
 * recorded path. A backend that echoed the request back would make the round
 * trip pass no matter what the patch did.
 */
function localBackend(observations: { resolves: string[], stats: string[], writes: string[] }): Record<string, unknown> {
  const keyOf = (target: unknown): string => String((target as { targetKey?: unknown })?.targetKey ?? '')
  return {
    sandboxMode: 'workspace-write',
    processPath(target: unknown): string {
      return keyOf(target)
    },
    async resolve(requested: string, opts?: { cwd?: string }): Promise<unknown> {
      observations.resolves.push(requested)
      const absolute = path.resolve(opts?.cwd ?? process.cwd(), requested)
      let key = absolute
      try {
        key = await realpath(absolute)
      } catch {
        // A path that does not exist yet keeps its lexical spelling; the patch
        // never asks this backend for a remote path, so this only affects
        // missing local files.
      }
      return { targetKey: FsTargetKey(key), displayPath: absolute }
    },
    async lstat(requested: string, opts?: { cwd?: string }): Promise<unknown> {
      const absolute = path.resolve(opts?.cwd ?? process.cwd(), requested)
      try {
        const info = await import('node:fs/promises').then(m => m.lstat(absolute))
        if (info.isSymbolicLink()) return { type: 'symlink', version: 'v', size: info.size }
        return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', version: 'v', size: info.size }
      } catch {
        return undefined
      }
    },
    async stat(target: unknown): Promise<unknown> {
      const key = keyOf(target)
      observations.stats.push(key)
      const info = await import('node:fs/promises').then(m => m.stat(key))
      return { type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', version: 'v', size: info.size }
    },
    async listDir(): Promise<unknown[]> { return [] },
    async readText(target: unknown): Promise<string> { return readFile(keyOf(target), 'utf8') },
    async streamText(target: unknown): Promise<AsyncIterable<string>> {
      const text = await readFile(keyOf(target), 'utf8')
      return (async function* () { yield text })()
    },
    async readBytes(target: unknown): Promise<Uint8Array> { return readFile(keyOf(target)) },
    async readByteRange(target: unknown, range: { offset: number, length: number }): Promise<Uint8Array> {
      const body = await readFile(keyOf(target))
      return body.subarray(range.offset, range.offset + range.length)
    },
    async writeText(target: unknown): Promise<unknown> {
      observations.writes.push(keyOf(target))
      return { version: 'v', before: null, after: '' }
    },
    async editText(target: unknown): Promise<unknown> {
      observations.writes.push(keyOf(target))
      return { version: 'v' }
    },
    // Present so `installRemoteFs` wraps them with the guard instead of
    // installing its remote-only refusal: the snapshot rule has to be the one
    // that answers, and its code is what these tests assert.
    async patchText(target: unknown): Promise<unknown> {
      observations.writes.push(keyOf(target))
      return { version: 'v', before: '', after: '' }
    },
    async deleteFile(target: unknown): Promise<unknown> {
      observations.writes.push(keyOf(target))
      return { before: '' }
    },
    async moveFile(): Promise<unknown> {
      return { sourceDeleted: true, sourceBefore: '', destination: { operation: 'create', before: null, after: '' } }
    },
    contains(): boolean { return true },
    async watch(): Promise<() => Promise<void>> { return async () => undefined },
    processPathFromHostPath(hostPath: string): string | undefined {
      return path.isAbsolute(hostPath) ? path.resolve(hostPath) : undefined
    },
  }
}

interface Fixture {
  /** The patched `ctx.fs`. */
  fs: Record<string, any>
  /** Paths the fake SFTP pool was asked to touch. */
  poolPaths: string[]
  observations: { resolves: string[], stats: string[], writes: string[] }
  cacheRoot: string
  snapshot: string
  dispose(): Promise<void>
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-present-e2e-'))
  // A symlinked remote root is what a home directory on macOS looks like, and
  // the snapshot root must still be recorded as a realpath.
  const root = path.join(base, 'remote')
  await mkdir(root, { recursive: true })
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = root
  setRemoteRootOverride(null)
  clearSupersededRoots()

  const observations = { resolves: [] as string[], stats: [] as string[], writes: [] as string[] }
  const poolPaths: string[] = []
  const backend = localBackend(observations)

  const pool = {
    async sftpRealpath(_h: unknown, _s: unknown, remotePath: string): Promise<string> {
      poolPaths.push(posix.normalize(remotePath))
      return posix.normalize(remotePath)
    },
    async sftpAttrs(_h: unknown, _s: unknown, remotePath: string): Promise<SftpAttrs | undefined> {
      poolPaths.push(posix.normalize(remotePath))
      return { type: 'file', size: 5, mtime: 7, mode: 0o644 }
    },
    async sftpReadLink(): Promise<string> { throw new SshFailure('Failure', 'sftp-readlink') },
    async sftpProbeDir(): Promise<void> {},
    async sftpReadDir(): Promise<never[]> { return [] },
    async sftpRead(): Promise<Buffer> { return Buffer.from('hello') },
    async sftpReadAt(): Promise<Buffer> { return Buffer.alloc(0) },
    async *sftpReadChunks(): AsyncGenerator<Buffer> { yield Buffer.from('hello') },
    async exec(): Promise<unknown> {
      return { code: 0, signal: null, stdout: '65024:1:5:2026-01-01 00:00:00.000000000 +0000', stderr: '', timedOut: false, stdoutTruncated: false, stderrTruncated: false }
    },
  }

  const access = {
    requireHost: () => ({ id: HOST_ID } as HostConfig),
    async secret(): Promise<Record<string, never>> { return {} },
    allowsRemoteSession: () => true,
    workspaceRootsOf: () => [REMOTE_ROOT],
    pool,
  } as unknown as RemoteAccess

  const ctx = {
    get(name: string): unknown {
      if (name === 'fs') return backend
      throw new Error(`unexpected service ${name}`)
    },
    logger: { warn(_message: string) {} },
  }
  const remove = installRemoteFs(ctx, access)
  assert.equal(typeof remove, 'function')
  const uninstall: () => void = remove ?? (() => undefined)

  const cache = await openPresentCache()
  assert.ok(cache, 'the cache opens under the remote root')
  const { handle, temp } = await cache!.createTemp()
  await handle.write(Buffer.from('hello'))
  await handle.close()
  const staged = await cache!.publish({
    temp,
    target: cache!.targetFor('f'.repeat(64), 'report.txt'),
    hash: 'f'.repeat(64),
    bytes: 5,
  })

  return {
    fs: backend as Record<string, any>,
    poolPaths,
    observations,
    cacheRoot: cache!.root,
    snapshot: staged.path,
    async dispose() {
      uninstall()
      if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
      else process.env.DSH_SSH_REMOTE_ROOT = previous
      await rm(base, { recursive: true, force: true })
    },
  }
}

test('a snapshot reached with a remote cwd is served by the local backend', async () => {
  const f = await fixture()
  try {
    const remoteCwd = mapRemoteToLocal(HOST_ID, REMOTE_ROOT)!
    await mkdir(remoteCwd, { recursive: true })
    f.poolPaths.length = 0
    f.observations.resolves.length = 0

    // This is the exact call the official present makes first.
    const entry = await f.fs.lstat(f.snapshot, { cwd: remoteCwd })
    assert.equal(entry?.type, 'file', 'lstat must see the snapshot as a real local file')

    const target = await f.fs.resolve(f.snapshot, { cwd: remoteCwd })
    const info = await f.fs.stat(target)
    assert.equal(info?.type, 'file')

    // The snapshot must never be handed to SFTP: a remote `stat` of this path
    // is exactly the failure that would reject every delivery.
    assert.equal(
      f.poolPaths.some(p => p.includes('.deliverables')),
      false,
      `the snapshot leaked to the remote host: ${f.poolPaths.join(', ')}`,
    )
  } finally {
    await f.dispose()
  }
})

test('the snapshot round trip equals what the card verifier requires', async () => {
  const f = await fixture()
  try {
    const remoteCwd = mapRemoteToLocal(HOST_ID, REMOTE_ROOT)!
    await mkdir(remoteCwd, { recursive: true })
    // `openVerified` and `verifyDesktopPath` both do exactly this.
    const mapped = f.fs.processPathFromHostPath(f.snapshot)
    assert.equal(typeof mapped, 'string')
    const round = f.fs.processPath(await f.fs.resolve(mapped!, { cwd: remoteCwd }))
    assert.equal(round, f.snapshot, 'the recorded path must survive the verifier round trip')
    assert.equal(round, await realpath(f.snapshot))
  } finally {
    await f.dispose()
  }
})

test('a remote cwd still resolves genuine remote paths over SFTP', async () => {
  const f = await fixture()
  try {
    const remoteCwd = mapRemoteToLocal(HOST_ID, REMOTE_ROOT)!
    await mkdir(remoteCwd, { recursive: true })
    f.poolPaths.length = 0
    // The sibling case matters as much as the snapshot: the carve-out must not
    // turn the rest of the remote namespace into local paths.
    const target = await f.fs.resolve('/srv/app/notes.md', { cwd: remoteCwd })
    assert.equal(typeof f.fs.processPath(target), 'string')
    assert.match(f.fs.processPath(target), new RegExp(`${HOST_ID}`, 'u'))
    assert.equal(
      f.observations.resolves.some(p => p === '/srv/app/notes.md'),
      false,
      'a remote path must not reach the local backend',
    )
  } finally {
    await f.dispose()
  }
})

test('every mutation refuses a snapshot target', async () => {
  const f = await fixture()
  try {
    const target = await f.fs.resolve(f.snapshot, { cwd: mapRemoteToLocal(HOST_ID, REMOTE_ROOT)! })
    f.observations.writes.length = 0
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['writeText', () => f.fs.writeText(target, 'changed')],
      ['editText', () => f.fs.editText(target, { oldText: 'hello', newText: 'x' }, undefined)],
      ['patchText', () => f.fs.patchText(target, [])],
      ['deleteFile', () => f.fs.deleteFile(target)],
      ['moveFile', () => f.fs.moveFile(target, target)],
    ]
    for (const [name, run] of cases) {
      await assert.rejects(run, (error: any) => {
        assert.equal(error?.code, 'FS_PERMISSION_DENIED', `${name} must refuse with FS_PERMISSION_DENIED`)
        return true
      })
    }
    assert.deepEqual(f.observations.writes, [], 'no mutation may reach the local backend')
  } finally {
    await f.dispose()
  }
})

test('a symlink into the snapshot tree is refused as its target', async () => {
  const f = await fixture()
  try {
    const { symlink } = await import('node:fs/promises')
    const base = path.dirname(f.cacheRoot)
    const link = path.join(base, 'innocent-link.txt')
    await symlink(f.snapshot, link)
    // A local cwd is the case where a link outside the cache reaches the guard
    // at all: with a remote cwd the plugin reads every absolute local path as a
    // remote one, so the path would never arrive as local. Here it does, and the
    // local backend keys the target by realpath — which lands inside the cache.
    const localCwd = base
    const target = await f.fs.resolve(link, { cwd: localCwd })
    await assert.rejects(() => f.fs.writeText(target, 'changed'), (error: any) => {
      assert.equal(error?.code, 'FS_PERMISSION_DENIED')
      return true
    })
  } finally {
    await f.dispose()
  }
})

test('an older provider without the patch mutations still refuses a snapshot', async () => {
  // `installRemoteFs` replaces patchText/deleteFile/moveFile only when the
  // mounted provider has all three. Otherwise it installs the remote-only
  // refusal, which decides by route alone — and a snapshot routes as *local*,
  // so without an explicit check the call would reach the provider and really
  // delete or move a frozen card's bytes. This is the branch that check missed.
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-present-older-'))
  const root = path.join(base, 'remote')
  await mkdir(root, { recursive: true })
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = root
  setRemoteRootOverride(null)
  clearSupersededRoots()
  try {
    const touched: string[] = []
    const keyOf = (target: unknown): string => String((target as { targetKey?: unknown })?.targetKey ?? '')
    const backend: Record<string, unknown> = {
      processPath: keyOf,
      async resolve(requested: string): Promise<unknown> {
        return { targetKey: FsTargetKey(path.resolve(requested)), displayPath: requested }
      },
      async lstat(): Promise<unknown> { return { type: 'file', version: 'v', size: 1 } },
      async stat(): Promise<unknown> { return { type: 'file', version: 'v', size: 1 } },
      async listDir(): Promise<unknown[]> { return [] },
      async readText(): Promise<string> { return '' },
      async streamText(): Promise<AsyncIterable<string>> { return (async function* () {})() },
      async readBytes(): Promise<Uint8Array> { return new Uint8Array() },
      async readByteRange(): Promise<Uint8Array> { return new Uint8Array() },
      async writeText(): Promise<unknown> { return { version: 'v' } },
      async editText(): Promise<unknown> { return { version: 'v' } },
      // Exactly one of the three, so the provider is "older" but `deleteFile`
      // is still a real method the guard wraps (and could forward).
      async deleteFile(target: unknown): Promise<unknown> {
        touched.push(`DELETE ${keyOf(target)}`)
        return { before: '' }
      },
      contains(): boolean { return true },
      async watch(): Promise<() => Promise<void>> { return async () => undefined },
      processPathFromHostPath(hostPath: string): string | undefined {
        return path.isAbsolute(hostPath) ? path.resolve(hostPath) : undefined
      },
    }
    const access = {
      requireHost: () => ({ id: HOST_ID } as HostConfig),
      async secret(): Promise<Record<string, never>> { return {} },
      allowsRemoteSession: () => true,
      workspaceRootsOf: () => [REMOTE_ROOT],
      pool: {
        async sftpRealpath(_h: unknown, _s: unknown, p: string): Promise<string> { return p },
        async sftpAttrs(): Promise<SftpAttrs> { return { type: 'file', size: 1, mtime: 1, mode: 0o644 } },
        async sftpReadLink(): Promise<string> { throw new SshFailure('Failure', 'sftp-readlink') },
        async sftpProbeDir(): Promise<void> {},
        async sftpReadDir(): Promise<never[]> { return [] },
        async sftpRead(): Promise<Buffer> { return Buffer.from('x') },
        async sftpReadAt(): Promise<Buffer> { return Buffer.alloc(0) },
        async *sftpReadChunks(): AsyncGenerator<Buffer> { yield Buffer.from('x') },
        async exec(): Promise<unknown> {
          return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, stdoutTruncated: false, stderrTruncated: false }
        },
      },
    } as unknown as RemoteAccess
    const ctx = { get: (name: string) => name === 'fs' ? backend : undefined, logger: { warn() {} } }
    const remove = installRemoteFs(ctx, access)
    assert.equal(typeof remove, 'function')
    try {
      const cache = await openPresentCache()
      assert.ok(cache)
      const { handle, temp } = await cache!.createTemp()
      await handle.write(Buffer.from('frozen'))
      await handle.close()
      const ref = await cache!.publish({ temp, target: cache!.targetFor('a'.repeat(64), 'r.txt'), hash: 'a'.repeat(64), bytes: 6 })

      const target = await (backend.resolve as (p: string) => Promise<unknown>)(ref.path)
      await assert.rejects(
        () => (backend.deleteFile as (t: unknown) => Promise<unknown>)(target),
        (error: any) => {
          assert.equal(error?.code, 'FS_PERMISSION_DENIED')
          return true
        },
      )
      assert.deepEqual(touched, [], 'the frozen snapshot must never reach the provider')
    } finally {
      remove?.()
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(base, { recursive: true, force: true })
  }
})

test('ordinary local files outside the cache stay writable', async () => {
  const f = await fixture()
  try {
    const base = await mkdtemp(path.join(tmpdir(), 'dsh-present-local-'))
    const plain = path.join(base, 'notes.md')
    await writeFile(plain, 'original')
    const remoteCwd = mapRemoteToLocal(HOST_ID, REMOTE_ROOT)!
    await mkdir(remoteCwd, { recursive: true })
    const target = await f.fs.resolve(plain, { cwd: remoteCwd })
    let error: unknown
    try {
      await f.fs.writeText(target, 'changed')
    } catch (caught) {
      error = caught
    }
    // The snapshot rule is not what answered: this path is not a snapshot.
    assert.notEqual((error as { code?: string })?.code, 'FS_PERMISSION_DENIED')
    await rm(base, { recursive: true, force: true })
  } finally {
    await f.dispose()
  }
})

test('a cache built by the tool path is deduplicated by content', async () => {
  const f = await fixture()
  try {
    const cache = createPresentCache(f.cacheRoot)
    const body = Buffer.from('deduplicated body')
    const hash = (await import('node:crypto')).createHash('sha256').update(body).digest('hex')
    const first = await cache.createTemp()
    await first.handle.write(body)
    await first.handle.close()
    const one = await cache.publish({ temp: first.temp, target: cache.targetFor(hash, 'report.txt'), hash, bytes: body.length })
    assert.equal(one.reused, false)
    const second = await cache.createTemp()
    await second.handle.write(body)
    await second.handle.close()
    const two = await cache.publish({ temp: second.temp, target: cache.targetFor(hash, 'report.txt'), hash, bytes: body.length })
    assert.equal(two.reused, true)
    assert.equal(two.path, one.path)
    assert.equal(await readFile(one.path, 'utf8'), 'deduplicated body')
  } finally {
    await f.dispose()
  }
})


// ---------------------------------------------------------------------------
// The real official `present`, driven directly.
// ---------------------------------------------------------------------------

/**
 * The upstream tool packages come from the globally installed DSH.
 *
 * They are not in this workspace's dependency tree, and the point here is to
 * exercise the shipped `present` code rather than a stand-in: the whole staging
 * design follows from how that file calls `ctx.fs`. A missing install skips the
 * block; `DSH_REQUIRE_OFFICIAL_TOOLS=1` turns that into a failure for CI, the
 * same switch `tests/official-tools.spec.ts` uses.
 */
async function loadOfficialPresent(): Promise<any | undefined> {
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    const anchor = path.resolve(path.dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh/package.json')
    const require = createRequire(anchor)
    return await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-present')).href)
  } catch {
    return undefined
  }
}

const officialPresent = await loadOfficialPresent()
const PRESENT_SKIP: false | string = officialPresent !== undefined
  ? false
  : process.env.DSH_REQUIRE_OFFICIAL_TOOLS === '1'
    ? false
    : 'the official dsh-tool-present could not be loaded from the global install'

test('the real official present accepts a snapshot path under a remote cwd', { skip: PRESENT_SKIP }, async () => {
  assert.ok(officialPresent, 'official present is required when the skip is off')
  const f = await fixture()
  try {
    const remoteCwd = mapRemoteToLocal(HOST_ID, REMOTE_ROOT)!
    await mkdir(remoteCwd, { recursive: true })

    // The official `apply` only needs a tool registry and an event hook; the
    // `execute` path needs agents/workingDirectory/fs. Supplying exactly those
    // drives the shipped code without booting a whole harness.
    const registered: any[] = []
    // No `append` collector: the official tool defers the event to `tools/result`,
    // which only the runtime fires, so this harness can never observe it. Assert
    // the returned record instead — that is the object it stores in `pending`.
    const boundary = { openTurnStartSeq: 1, lastTurn: 7 }
    const session = { append() {} }
    const agent = { session }
    const fakeCtx = {
      tools: { register: (definition: unknown) => { registered.push(definition); return () => undefined } },
      on: () => () => undefined,
      agents: { turnBoundaryOf: () => boundary },
      workingDirectory: { ensure: async () => remoteCwd },
      fs: f.fs,
    }
    officialPresent.apply(fakeCtx, { maxFiles: 8 })
    const tool = registered.find(definition => definition.name === 'present')
    assert.ok(tool, 'the official present registered itself')

    const exec = { agent, signal: new AbortController().signal, callId: 'call-1' }
    const result = await tool.execute({ files: [{ path: f.snapshot, description: 'the report' }] }, exec)

    // The returned path is what the official tool resolved, and it is the
    // realpath the card verifier will demand.
    assert.equal(result.files[0].path, f.snapshot)
    assert.equal(result.files[0].description, 'the report')

    // The description survives alongside the resolved path, so the card still
    // labels the file the way the model asked.
    assert.deepEqual(Object.keys(result.files[0]).sort(), ['description', 'path'])
  } finally {
    await f.dispose()
  }
})
