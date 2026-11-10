/**
 * Delivery snapshots: naming, deduplication, pruning, and the routing premise.
 *
 * The routing assertion (`routeByCwd` and `isPresentCachePath`) is the reason
 * the snapshot directory lives under the remote root with a leading dot. If it
 * ever stopped holding, a remote session's `ctx.fs` would try to `stat` the
 * snapshot over SFTP and every delivery would fail, so it is pinned here rather
 * than left to an integration test.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  CACHE_BUDGET_BYTES,
  createPresentCache,
  HARD_MAX_BYTES,
  openPresentCache,
  sanitizeSnapshotName,
  SNAPSHOT_TTL_MS,
} from '../src/present-cache.ts'
import {
  addSupersededRoot,
  clearSupersededRoots,
  encodeRemotePath,
  isPresentCachePath,
  PRESENT_CACHE_DIR,
  presentCacheRoot,
  presentCacheRoots,
  routeByCwd,
  setRemoteRootOverride,
} from '../src/router.ts'
import { planRemoteRoot, runMigration } from '../src/migrate.ts'

async function scratch(): Promise<{ dir: string, dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-present-cache-'))
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) }
}

/** Stage bytes through the public interface, the way the tool path does. */
async function stage(cache: ReturnType<typeof createPresentCache>, name: string, body: Buffer): Promise<{ path: string, hash: string, bytes: number, reused: boolean }> {
  const hash = createHash('sha256').update(body).digest('hex')
  const { handle, temp } = await cache.createTemp()
  try {
    await handle.write(body)
  } finally {
    await handle.close()
  }
  return cache.publish({ temp, target: cache.targetFor(hash, name), hash, bytes: body.length })
}

test('a snapshot is routed as a local path, not as a remote host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-route-'))
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = root
  setRemoteRootOverride(null)
  clearSupersededRoots()
  try {
    const hash = 'a'.repeat(64)
    const snapshot = join(root, PRESENT_CACHE_DIR, hash, 'report.txt')
    // The leading dot is what keeps `.deliverables` out of the host-id grammar.
    assert.equal(routeByCwd(snapshot).kind, 'local')
    assert.equal(isPresentCachePath(snapshot), true)
    // The root itself and a file inside the cache both count.
    assert.equal(isPresentCachePath(join(root, PRESENT_CACHE_DIR)), true)
    // A placeholder inside the same root is still remote.
    const placeholder = join(root, 'host1', encodeRemotePath('/srv/app'))
    assert.equal(routeByCwd(placeholder).kind, 'remote')
    assert.equal(isPresentCachePath(placeholder), false)
    assert.equal(presentCacheRoot(), join(root, PRESENT_CACHE_DIR))
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('the cached root list follows every way a root can change', async () => {
  const first = await mkdtemp(join(tmpdir(), 'dsh-root-a-'))
  const second = await mkdtemp(join(tmpdir(), 'dsh-root-b-'))
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  setRemoteRootOverride(null)
  clearSupersededRoots()
  try {
    process.env.DSH_SSH_REMOTE_ROOT = first
    assert.equal(presentCacheRoot(), join(first, PRESENT_CACHE_DIR))
    // A memoized answer must never outlive a root change: these are the three
    // mutators, and each has to invalidate it.
    setRemoteRootOverride(second)
    assert.equal(presentCacheRoot(), join(second, PRESENT_CACHE_DIR))
    addSupersededRoot(first)
    assert.equal(presentCacheRoots().length, 2, 'the superseded root is routable again after a move')
    setRemoteRootOverride(null)
    assert.equal(presentCacheRoot(), join(first, PRESENT_CACHE_DIR), 'the override resets to the environment')
    clearSupersededRoots()
    assert.equal(presentCacheRoots().length, 1)
  } finally {
    clearSupersededRoots()
    setRemoteRootOverride(null)
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('a traversal out of the cache root is not a cache path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-escape-'))
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = root
  setRemoteRootOverride(null)
  clearSupersededRoots()
  try {
    assert.equal(isPresentCachePath(join(root, PRESENT_CACHE_DIR, '..', '..', 'etc', 'passwd')), false)
    assert.equal(isPresentCachePath('relative/inside/.deliverables/x'), false)
    // A sibling whose name merely starts with the cache directory's is outside it.
    assert.equal(isPresentCachePath(join(root, `${PRESENT_CACHE_DIR}-other`, 'x')), false)
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('a superseded root keeps its snapshots guarded and routable', async () => {
  const old = await mkdtemp(join(tmpdir(), 'dsh-present-old-'))
  const current = await mkdtemp(join(tmpdir(), 'dsh-present-new-'))
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = current
  setRemoteRootOverride(null)
  clearSupersededRoots()
  try {
    addSupersededRoot(old)
    const stale = join(old, PRESENT_CACHE_DIR, 'b'.repeat(64), 'report.txt')
    // A card recorded before the move still names this file, so the read-only
    // guard has to keep covering the old tree.
    assert.equal(isPresentCachePath(stale), true)
    assert.equal(routeByCwd(stale).kind, 'local')
    assert.equal(presentCacheRoots().length, 2)
  } finally {
    clearSupersededRoots()
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(old, { recursive: true, force: true })
    await rm(current, { recursive: true, force: true })
  }
})

test('identical content is reused, different content gets a new snapshot', async () => {
  const { dir, dispose } = await scratch()
  try {
    const cache = createPresentCache(dir)
    const first = await stage(cache, 'report.txt', Buffer.from('hello'))
    assert.equal(first.reused, false)
    assert.match(first.path, new RegExp(`/${'[0-9a-f]{64}'}/report\\.txt$`, 'u'))
    assert.equal(await readFile(first.path, 'utf8'), 'hello')

    const second = await stage(cache, 'report.txt', Buffer.from('hello'))
    assert.equal(second.reused, true)
    assert.equal(second.path, first.path)

    // Different content never rewrites the bytes a card may already open.
    const changed = await stage(cache, 'report.txt', Buffer.from('goodbye'))
    assert.equal(changed.reused, false)
    assert.notEqual(changed.path, first.path)
    assert.equal(await readFile(first.path, 'utf8'), 'hello')
    assert.equal(await readFile(changed.path, 'utf8'), 'goodbye')
  } finally {
    await dispose()
  }
})

test('a snapshot path that already holds other bytes is refused, not replaced', async () => {
  const { dir, dispose } = await scratch()
  try {
    const cache = createPresentCache(dir)
    const body = Buffer.from('hello')
    const hash = createHash('sha256').update(body).digest('hex')
    const target = cache.targetFor(hash, 'report.txt')
    await mkdir(join(dir, hash), { recursive: true })
    // Simulate a corrupted or foreign file sitting at the content address.
    await writeFile(target, 'not the hash content')
    const { handle, temp } = await cache.createTemp()
    await handle.write(body)
    await handle.close()
    await assert.rejects(
      () => cache.publish({ temp, target, hash, bytes: body.length }),
      /refusing to replace a file a card may open/u,
    )
    assert.equal(await readFile(target, 'utf8'), 'not the hash content')
    // The refused temp does not linger.
    assert.deepEqual(await readdir(join(dir, '.tmp')), [])
  } finally {
    await dispose()
  }
})

test('a same-size but different snapshot is refused, not reused', async () => {
  const { dir, dispose } = await scratch()
  try {
    const cache = createPresentCache(dir)
    const body = Buffer.from('hello')
    const hash = createHash('sha256').update(body).digest('hex')
    const target = cache.targetFor(hash, 'report.txt')
    await mkdir(join(dir, hash), { recursive: true })
    // Same length, different bytes: a size check alone would adopt this and the
    // card would show the wrong content while the path claims a hash it lacks.
    await writeFile(target, 'HELLO')
    const { handle, temp } = await cache.createTemp()
    await handle.write(body)
    await handle.close()
    await assert.rejects(
      () => cache.publish({ temp, target, hash, bytes: body.length }),
      /already holds different content/u,
    )
    assert.equal(await readFile(target, 'utf8'), 'HELLO', 'the foreign file is left alone')
  } finally {
    await dispose()
  }
})

test('pruning removes only aged hash directories and leaves live ones alone', async () => {
  const { dir, dispose } = await scratch()
  try {
    const cache = createPresentCache(dir, { ttlMs: SNAPSHOT_TTL_MS })
    const fresh = await stage(cache, 'fresh.txt', Buffer.from('fresh'))
    const old = await stage(cache, 'old.txt', Buffer.from('old'))
    const oldDir = join(dir, old.hash)
    const aged = (Date.now() - SNAPSHOT_TTL_MS - 60_000) / 1000
    await utimes(oldDir, aged, aged)
    // A file the operator put here by hand is not ours to remove.
    const foreign = join(dir, 'notes.txt')
    await writeFile(foreign, 'keep me')
    // Nor is a temp file still being written.
    const live = await cache.createTemp()
    await live.handle.write(Buffer.from('in flight'))
    await live.handle.close()

    const result = await cache.prune()
    assert.equal(result.removed, 1)
    assert.equal(existsSync(oldDir), false)
    assert.equal(await readFile(fresh.path, 'utf8'), 'fresh')
    assert.equal(existsSync(foreign), true)
    assert.equal(existsSync(live.temp), true)
  } finally {
    await dispose()
  }
})

test('pruning skips a symlink planted at a hash directory name', async () => {
  const { dir, dispose } = await scratch()
  try {
    const cache = createPresentCache(dir, { ttlMs: 1 })
    const outside = await mkdtemp(join(tmpdir(), 'dsh-present-outside-'))
    await writeFile(join(outside, 'precious.txt'), 'do not delete')
    const name = 'c'.repeat(64)
    await symlink(outside, join(dir, name))
    const aged = (Date.now() - 1_000_000) / 1000
    await utimes(join(dir, name), aged, aged).catch(() => undefined)
    await cache.prune()
    // The link itself must not be followed or removed, and its target survives.
    assert.equal(existsSync(join(outside, 'precious.txt')), true)
    await rm(outside, { recursive: true, force: true })
  } finally {
    await dispose()
  }
})

test('snapshot names survive every host this plugin runs on', () => {
  assert.equal(sanitizeSnapshotName('report.txt'), 'report.txt')
  assert.equal(sanitizeSnapshotName('季度报告.pdf'), '季度报告.pdf')
  // Windows device names cannot be created at all.
  assert.match(sanitizeSnapshotName('CON', 'abcdef1234'), /^abcdef12-/u)
  assert.match(sanitizeSnapshotName('com1.txt', 'abcdef1234'), /^abcdef12-/u)
  // Windows refuses these characters; the readable stem is kept.
  assert.match(sanitizeSnapshotName('a:b.txt', 'abcdef1234'), /^abcdef12-a_b\.txt$/u)
  assert.match(sanitizeSnapshotName('what?', 'abcdef1234'), /^abcdef12-what_$/u)
  // A trailing dot or space is silently trimmed on Windows and would make the
  // card show a name the file does not have.
  assert.equal(sanitizeSnapshotName('trailing.', 'abcdef1234'), 'trailing')
  assert.equal(sanitizeSnapshotName('trailing ', 'abcdef1234'), 'trailing')
  // Separators never survive into the segment.
  assert.equal(sanitizeSnapshotName('/srv/app/out/report.txt'), 'report.txt')
  assert.equal(sanitizeSnapshotName('..'), 'file')
  const long = 'x'.repeat(400)
  assert.ok(sanitizeSnapshotName(long, 'abcdef1234').length <= 140)
})

test('the hard delivery ceiling is below what the transfer setting can request', () => {
  // `0` means "no limit" for a transfer that streams onto the remote host. The
  // snapshot is written to this computer for an unapproved tool call, so it
  // keeps a ceiling of its own.
  assert.equal(HARD_MAX_BYTES, 256 * 1024 * 1024)
  assert.ok(HARD_MAX_BYTES > 32 * 1024 * 1024)
})

test('opening the cache returns a realpath root so the card can verify it', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-present-real-'))
  // A symlinked root is what `~/.dsh` is on some installs.
  const viaLink = join(base, 'link')
  const real = join(base, 'real')
  await mkdir(real, { recursive: true })
  await symlink(real, viaLink)
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  process.env.DSH_SSH_REMOTE_ROOT = viaLink
  setRemoteRootOverride(null)
  clearSupersededRoots()
  try {
    const cache = await openPresentCache()
    assert.ok(cache)
    // `openVerified` compares `processPath(resolve(path))` with the recorded
    // path, and the local backend's `processPath` is a realpath. Recording the
    // lexical spelling would make every card 422.
    assert.equal(cache!.root, join(await stat(real).then(() => real), PRESENT_CACHE_DIR))
    assert.notEqual(cache!.root, join(viaLink, PRESENT_CACHE_DIR))
    const staged = await stage(cache!, 'report.txt', Buffer.from('hello'))
    assert.ok(staged.path.startsWith(cache!.root))
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(base, { recursive: true, force: true })
  }
})

test('an unwritable cache root yields no cache instead of throwing', async () => {
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  // A path under a regular file cannot be a directory.
  const base = await mkdtemp(join(tmpdir(), 'dsh-present-bad-'))
  const file = join(base, 'plain')
  await writeFile(file, 'x')
  process.env.DSH_SSH_REMOTE_ROOT = file
  setRemoteRootOverride(null)
  clearSupersededRoots()
  try {
    assert.equal(await openPresentCache(), undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(base, { recursive: true, force: true })
  }
})

test('pruning reaches a superseded root, not only the current one', async () => {
  const { dir, dispose } = await scratch()
  try {
    const oldRoot = join(dir, 'old', '.deliverables')
    const newRoot = join(dir, 'new', '.deliverables')
    const oldHash = join(oldRoot, 'e'.repeat(64))
    await mkdir(oldHash, { recursive: true })
    await writeFile(join(oldHash, 'stale.bin'), 'stale')
    const aged = (Date.now() - SNAPSHOT_TTL_MS - 60_000) / 1000
    await utimes(oldHash, aged, aged)
    await mkdir(newRoot, { recursive: true })
    // Only the current root is `root`; the old one is listed through `roots`.
    const cache = createPresentCache(newRoot, { ttlMs: SNAPSHOT_TTL_MS, roots: [newRoot, oldRoot] })
    const result = await cache.prune()
    assert.equal(result.removed, 1)
    // Without the extra root this file would survive forever after a migration.
    assert.equal(existsSync(join(oldHash, 'stale.bin')), false)
  } finally {
    await dispose()
  }
})

test('a total budget evicts the oldest snapshot first', async () => {
  const { dir, dispose } = await scratch()
  try {
    const root = join(dir, '.deliverables')
    // A budget far below the current total, with three directories of known age.
    const cache = createPresentCache(root, { ttlMs: SNAPSHOT_TTL_MS, budgetBytes: 250 })
    const names = ['one', 'two', 'three']
    const dirs: string[] = []
    for (const [index, name] of names.entries()) {
      const hash = String(index + 1).repeat(64)
      const holder = join(root, hash)
      await mkdir(holder, { recursive: true })
      await writeFile(join(holder, `${name}.bin`), 'x'.repeat(200))
      // Oldest first: `one` is the least likely to be on screen.
      const at = (Date.now() - (3 - index) * 86_400_000) / 1000
      await utimes(holder, at, at)
      dirs.push(holder)
    }
    await cache.prune()
    // 600 bytes over a 250 budget: the two oldest go, the newest stays.
    assert.equal(existsSync(join(dirs[0]!, 'one.bin')), false)
    assert.equal(existsSync(join(dirs[1]!, 'two.bin')), false)
    assert.equal(existsSync(join(dirs[2]!, 'three.bin')), true)
  } finally {
    await dispose()
  }
})

test('an expired directory that cannot be removed does not skip the budget', async () => {
  const { dir, dispose } = await scratch()
  const root = join(dir, '.deliverables')
  let locked = ''
  try {
    const cache = createPresentCache(root, { ttlMs: SNAPSHOT_TTL_MS, budgetBytes: 250 })
    const aged = join(root, 'a'.repeat(64))
    const mid = join(root, 'b'.repeat(64))
    const fresh = join(root, 'c'.repeat(64))
    await mkdir(aged, { recursive: true })
    await mkdir(mid, { recursive: true })
    await mkdir(fresh, { recursive: true })
    await writeFile(join(aged, 'old.bin'), 'x'.repeat(100))
    await writeFile(join(mid, 'mid.bin'), 'x'.repeat(200))
    await writeFile(join(fresh, 'new.bin'), 'x'.repeat(100))
    const day = 86_400_000
    await utimes(aged, (Date.now() - 40 * day) / 1000, (Date.now() - 40 * day) / 1000)
    await utimes(mid, (Date.now() - day) / 1000, (Date.now() - day) / 1000)
    locked = aged
    await chmod(locked, 0o500)
    await cache.prune()
    // The 40-day directory is over the TTL and cannot be removed. The budget
    // pass still runs: 400 bytes against 250 drops the middle directory and
    // keeps the newest.
    assert.equal(existsSync(join(locked, 'old.bin')), true)
    assert.equal(existsSync(join(mid, 'mid.bin')), false)
    assert.equal(existsSync(join(fresh, 'new.bin')), true)
  } finally {
    if (locked.length > 0) await chmod(locked, 0o700).catch(() => undefined)
    await dispose()
  }
})

test('an undeletable directory that itself exceeds the budget keeps the newer snapshots', async () => {
  const { dir, dispose } = await scratch()
  const root = join(dir, '.deliverables')
  let locked = ''
  try {
    const cache = createPresentCache(root, { ttlMs: SNAPSHOT_TTL_MS, budgetBytes: 250 })
    const dirs: string[] = []
    for (const [index, name] of ['old', 'mid', 'new'].entries()) {
      const holder = join(root, String(index + 1).repeat(64))
      await mkdir(holder, { recursive: true })
      await writeFile(join(holder, `${name}.bin`), 'x'.repeat(index === 0 ? 300 : 200))
      const at = (Date.now() - (3 - index) * 86_400_000) / 1000
      await utimes(holder, at, at)
      dirs.push(holder)
    }
    locked = dirs[0]!
    await chmod(locked, 0o500)
    await cache.prune()
    // 700 bytes, budget 250. The oldest 300 cannot be removed and already
    // exceeds the budget, so the newer snapshots stay.
    assert.equal(existsSync(join(locked, 'old.bin')), true)
    assert.equal(existsSync(join(dirs[1]!, 'mid.bin')), true)
    assert.equal(existsSync(join(dirs[2]!, 'new.bin')), true)
  } finally {
    if (locked.length > 0) await chmod(locked, 0o700).catch(() => undefined)
    await dispose()
  }
})

test('a crashed temp file is reclaimed after an hour, not after a month', async () => {
  const { dir, dispose } = await scratch()
  try {
    const cache = createPresentCache(dir)
    const crashed = await cache.createTemp()
    await crashed.handle.write(Buffer.alloc(1024, 7))
    await crashed.handle.close()
    const aged = (Date.now() - 2 * 60 * 60 * 1000) / 1000
    await utimes(crashed.temp, aged, aged)
    const live = await cache.createTemp()
    await live.handle.close()
    await cache.prune()
    assert.equal(existsSync(crashed.temp), false, 'an abandoned write must not hold disk for a month')
    assert.equal(existsSync(live.temp), true, 'a fresh temp belongs to a live or very recent delivery')
  } finally {
    await dispose()
  }
})

test('moving the remote root skips snapshots but not a look-alike subdirectory', async () => {
  const { dir, dispose } = await scratch()
  try {
    const oldRoot = join(dir, 'old')
    const newRoot = join(dir, 'new')
    const hostDir = join(oldRoot, 'host1')
    await mkdir(hostDir, { recursive: true })
    await writeFile(join(hostDir, 'Y3NyYy9hcHA'), 'placeholder-ish')
    // A real snapshot tree at the root of the old tree.
    await mkdir(join(oldRoot, PRESENT_CACHE_DIR, 'd'.repeat(64)), { recursive: true })
    await writeFile(join(oldRoot, PRESENT_CACHE_DIR, 'd'.repeat(64), 'report.txt'), 'snapshot bytes')
    // A directory that merely shares the name one level down is an ordinary
    // placeholder directory and must move with everything else.
    await mkdir(join(oldRoot, 'host1', PRESENT_CACHE_DIR), { recursive: true })
    await writeFile(join(oldRoot, 'host1', PRESENT_CACHE_DIR, 'keep.txt'), 'nested')

    const plan = await planRemoteRoot(oldRoot, newRoot, 'auto')
    assert.equal(plan.action, 'copied')
    assert.equal(plan.copyTree, true)

    const report = await runMigration(plan)
    // The root-level snapshot tree stays behind, so it is not counted as moved.
    assert.equal(existsSync(join(newRoot, PRESENT_CACHE_DIR)), false)
    assert.equal(existsSync(join(oldRoot, PRESENT_CACHE_DIR, 'd'.repeat(64), 'report.txt')), true, 'the old snapshot must stay for an already-recorded card')
    // The nested look-alike did move.
    assert.equal(await readFile(join(newRoot, 'host1', PRESENT_CACHE_DIR, 'keep.txt'), 'utf8'), 'nested')
    assert.ok(report.copied >= 2)
  } finally {
    await dispose()
  }
})
