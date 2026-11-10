/**
 * Delivery snapshots for the official `present` tool.
 *
 * `present` records a path, and the card that opens it reads this computer's
 * filesystem through `ctx.fs`. A remote session therefore cannot hand the tool
 * a remote path: the bytes have to exist locally. The plugin stages them, and
 * where those bytes live is what this module decides.
 *
 * The layout is `<remoteRoot>/.deliverables/<sha256>/<name>`:
 *
 * - Content addressed, so a second delivery of different content lands at a new
 *   path and never rewrites the bytes a card already points at. A re-delivery of
 *   identical content reuses the existing file.
 * - Under the remote root with a leading dot, so `routeUnderRoot` reads it as a
 *   local path rather than a host id (`router.ts` explains why that matters).
 *
 * There is no use index. Opening a card never comes back through this plugin,
 * so the only freshness signal is the directory mtime of the delivery itself.
 * Expiry is that age ({@link SNAPSHOT_TTL_MS}). A separate byte budget
 * ({@link CACHE_BUDGET_BYTES}) drops the oldest hash directories when every
 * snapshot together exceeds 1 GiB; that can remove a card that is still on
 * screen, which is why the budget is documented as a disk backstop.
 */
import { randomBytes } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { chmod, mkdir, lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { presentCacheRoot, presentCacheRoots } from './router.ts'

/**
 * Hard ceiling for one delivered file, independent of the transfer setting.
 *
 * `transferMaxBytes` supports `0` meaning "no limit". Chat uploads,
 * `ssh_upload`, and `ssh_download` are chunked, so `0` runs until the file
 * ends or the disk is full. This path writes the operator's own disk for a
 * model call with no approval of its own, so the setting raises the limit up
 * to this ceiling and never past it.
 */
export const HARD_MAX_BYTES = 256 * 1024 * 1024

/** How long a snapshot stays openable. Cards older than this stop resolving. */
export const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Total bytes all snapshot roots may hold.
 *
 * `present` is a tool the model can call with no approval step, so a delivery
 * loop over distinct large files would otherwise fill the operator's disk. Age
 * alone does not bound it: 30 days of deliveries at 256 MiB each is unbounded.
 *
 * The eviction order is oldest-directory-mtime first, which is the same signal
 * {@link SNAPSHOT_TTL_MS} uses. It is not "least recently used": opening a card
 * never comes back through this plugin, so there is no use signal to observe.
 * A directory's mtime is the time of its newest delivery, so the oldest one is
 * the least likely to be on screen. Evicting it can still break a card, which
 * is why the budget is far larger than a single delivery and the docs say so.
 */
export const CACHE_BUDGET_BYTES = 1024 * 1024 * 1024

/**
 * Temp files are abandoned only when the process died mid-write, so they get a
 * much shorter life than a snapshot: a crashed 256 MiB `.part` must not sit on
 * disk for a month.
 */
const TEMP_TTL_MS = 60 * 60 * 1000

/** Hash directory names this module created, and therefore the only ones it removes. */
const HASH_DIR = /^[0-9a-f]{64}$/u

/** Temp files, in their own sibling so pruning a hash directory never sees one. */
const TEMP_DIR = '.tmp'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

export interface PendingSnapshot {
  /** Temp file the bytes were streamed into. */
  readonly temp: string
  /** Final path, `<root>/<hash>/<name>`. */
  readonly target: string
  /** SHA-256 of the bytes, lowercase hex. */
  readonly hash: string
  /** Byte count actually written. */
  readonly bytes: number
}

export interface SnapshotRef {
  /** The path to hand the official tool: an absolute local path. */
  readonly path: string
  readonly hash: string
  readonly bytes: number
  /** True when the same bytes were already staged, so nothing was rewritten. */
  readonly reused: boolean
}

export interface PresentCache {
  /** Realpath of the snapshot root; every path this cache returns uses it. */
  readonly root: string
  /** Start one write: an exclusive temp handle and its path. */
  createTemp(): Promise<{ handle: FileHandle, temp: string }>
  /** Where the bytes for `hash` belong. Pure; creates nothing. */
  targetFor(hash: string, name: string): string
  /**
   * Promote a fully written temp file to its content-addressed path.
   *
   * When the target already holds this content the temp is discarded and the
   * existing path is returned with `reused: true`; the bytes on disk are never
   * rewritten, because a card may be pointing at them.
   */
  publish(pending: PendingSnapshot): Promise<SnapshotRef>
  /** Remove a temp file that will not be published. */
  discard(temp: string): Promise<void>
  /** Delete hash directories older than {@link SNAPSHOT_TTL_MS}. */
  prune(now?: number): Promise<{ removed: number }>
}

/**
 * One path segment that is safe on every host this plugin runs on.
 *
 * The remote name is the model's and the user's label, so it is kept whenever it
 * can be. Windows refuses `<>:"|?*`, control characters, trailing dots and
 * spaces, and the reserved device names. Those names get a digest prefix rather
 * than a rewritten stem: `CON` cannot be created at all, and turning `a:b.txt`
 * into `a_b.txt` would present a card whose name silently differs from the
 * remote file. The hash directory already guarantees uniqueness either way.
 */
export function sanitizeSnapshotName(remoteBasename: string, hash?: string): string {
  const prefix = (hash ?? '').slice(0, 8)
  const fallback = prefix.length > 0 ? `file-${prefix}` : 'file'
  const raw = String(remoteBasename ?? '')
  // A basename survives a separator-bearing input; an empty one gets a fixed name.
  const base = raw.split(/[/\\]/u).pop() ?? ''
  if (base.length === 0 || base === '.' || base === '..') return fallback
  // A trailing dot or space is legal on POSIX and silently trimmed on Windows,
  // which would make the card show a name the file does not have.
  const trimmed = base.replace(/[. ]+$/u, '')
  if (trimmed.length === 0) return fallback
  if (RESERVED.test(trimmed) || UNSAFE.test(trimmed)) {
    const cleaned = trimmed.replace(/[<>:"|?*\u0000-\u001f\u007f]/gu, '_').replace(/[. ]+$/u, '')
    if (cleaned.length === 0) return fallback
    return prefixName(prefix, cleaned)
  }
  if (trimmed.length > MAX_NAME) return shorten(trimmed, prefix)
  return trimmed
}

/** Windows device names, with or without an extension. */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu
/** Characters Windows refuses, plus control characters everywhere. */
const UNSAFE = /[<>:"|?*\u0000-\u001f\u007f]/u
const MAX_NAME = 120

function prefixName(prefix: string, value: string): string {
  return prefix.length === 0 ? `file-${value}` : `${prefix}-${value}`
}

function shorten(value: string, prefix: string): string {
  const ext = path.extname(value).slice(0, 16)
  const stem = value.slice(0, Math.max(1, MAX_NAME - ext.length - 12))
  return prefixName(prefix, `${stem}${ext}`)
}

/** Every hash directory under one root, with the mtime pruning decides on. */
async function hashDirectories(root: string): Promise<Array<{ path: string, at: number }>> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const found: Array<{ path: string, at: number }> = []
  for (const name of names) {
    if (!HASH_DIR.test(name)) continue
    const full = path.join(root, name)
    try {
      const info = await lstat(full)
      // A symlink planted here is not ours; never follow or remove one.
      if (!info.isDirectory()) continue
      found.push({ path: full, at: info.mtimeMs })
    } catch {
      // Vanished between the listing and the probe: nothing to prune.
    }
  }
  return found
}

/**
 * Build a cache rooted at `root`, which must already be a realpath.
 *
 * Kept separate from {@link openPresentCache} so tests can drive pruning and
 * naming without a home directory.
 */
export function createPresentCache(root: string, options?: { ttlMs?: number, roots?: readonly string[], budgetBytes?: number }): PresentCache {
  const ttl = options?.ttlMs ?? SNAPSHOT_TTL_MS
  const tempDir = path.join(root, TEMP_DIR)

  return {
    root,
    async createTemp() {
      await mkdir(tempDir, { recursive: true, mode: DIR_MODE })
      const temp = path.join(tempDir, `${process.pid}-${randomBytes(9).toString('hex')}.part`)
      // `wx` refuses a file someone else already made at this name, so a
      // planted symlink cannot redirect the write.
      const handle = await open(temp, 'wx', FILE_MODE)
      return { handle, temp }
    },
    targetFor(hash, name) {
      return path.join(root, hash, sanitizeSnapshotName(name, hash))
    },
    async publish(pending) {
      const existing = await existingBytes(pending.target)
      if (existing !== undefined) {
        // Size alone does not prove the bytes: the path is *claimed* to be the
        // SHA-256 of its content, and a foreign or truncated file of the same
        // size would otherwise be handed to the card as if it were the
        // delivery. Read the temp back and compare — the temp is right here and
        // the check runs once per delivery, not per read.
        if (existing === pending.bytes && await sameContent(pending.target, pending.temp)) {
          await rm(pending.temp, { force: true })
          return { path: pending.target, hash: pending.hash, bytes: pending.bytes, reused: true }
        }
        await rm(pending.temp, { force: true })
        throw new Error(
          `delivery snapshot ${pending.target} already holds different content (${existing} bytes), not the ${pending.bytes} just read; refusing to replace a file a card may open`,
        )
      }
      await mkdir(path.dirname(pending.target), { recursive: true, mode: DIR_MODE })
      try {
        await rename(pending.temp, pending.target)
      } catch (error) {
        // Another delivery of the same content won the race. Same bytes, same
        // content address: adopt its file and drop ours.
        const raced = await existingBytes(pending.target)
        const identical = raced === pending.bytes && await sameContent(pending.target, pending.temp)
        await rm(pending.temp, { force: true })
        if (identical) {
          return { path: pending.target, hash: pending.hash, bytes: pending.bytes, reused: true }
        }
        throw error
      }
      return { path: pending.target, hash: pending.hash, bytes: pending.bytes, reused: false }
    },
    async discard(temp) {
      await rm(temp, { force: true })
    },
    async prune(now = Date.now()) {
      let removed = 0
      // Every root this process routes under, not only the current one. A
      // snapshot recorded before the operator moved the root lives under the
      // superseded root, which `routingRoots` keeps routable and therefore
      // keeps on disk — and without this it would never be collected.
      for (const scanRoot of options?.roots ?? [root]) {
        for (const entry of await hashDirectories(scanRoot)) {
          // A directory mtime moves when an entry inside it is added or removed,
          // and a delivery adds one: the age is the age of its newest snapshot.
          if (now - entry.at < ttl) continue
          try {
            await rm(entry.path, { recursive: true, force: true })
          } catch {
            // A locked expired directory must not skip the budget pass below.
            continue
          }
          removed += 1
        }
        await dropStaleTemps(path.join(scanRoot, TEMP_DIR), now, TEMP_TTL_MS)
      }
      await enforceBudget(options?.roots ?? [root], options?.budgetBytes ?? CACHE_BUDGET_BYTES)
      return { removed }
    },
  }
}

/**
 * Keep the combined size of every snapshot root under `budget`.
 *
 * Oldest directory first, by the same mtime the age rule uses. Deleting a
 * directory someone still has a card open for is a real risk, so this only runs
 * once the total is already over budget — it is a backstop for a delivery loop,
 * not the normal expiry path. A directory that cannot be measured is skipped
 * rather than guessed at. A removal that fails is measured again and only the
 * bytes that actually disappeared leave the running total, so a locked file
 * does not stop the pass and a half-deleted directory is not counted in full.
 * An undeletable directory that by itself exceeds `budget` stops the pass.
 * Deleting every newer snapshot cannot get under the budget, and those
 * snapshots are the ones a card is most likely to still have open.
 */
async function enforceBudget(roots: readonly string[], budget: number): Promise<void> {
  if (budget <= 0) return
  const found: Array<{ path: string, at: number, bytes: number }> = []
  let total = 0
  for (const root of roots) {
    for (const entry of await hashDirectories(root)) {
      const bytes = await directoryBytes(entry.path)
      total += bytes
      found.push({ ...entry, bytes })
    }
  }
  if (total <= budget) return
  found.sort((left, right) => left.at - right.at)
  for (const entry of found) {
    if (total <= budget) return
    try {
      await rm(entry.path, { recursive: true, force: true })
      total -= entry.bytes
    } catch {
      const left = await directoryBytes(entry.path).catch(() => entry.bytes)
      total -= Math.max(0, entry.bytes - left)
      if (left > budget) return
    }
  }
}

/** Sum of the regular files directly inside one hash directory. */
async function directoryBytes(dir: string): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    try {
      const info = await lstat(path.join(dir, name))
      if (info.isFile()) total += info.size
    } catch {
      // Vanished mid-scan: it is not taking up space.
    }
  }
  return total
}

/**
 * Whether two files hold the same bytes.
 *
 * Used only to confirm a reuse, so it compares the whole file: a length check
 * cannot tell a foreign file from the delivery that claims the same size.
 */
async function sameContent(left: string, right: string): Promise<boolean> {
  let a: FileHandle | undefined
  let b: FileHandle | undefined
  try {
    a = await open(left, 'r')
    b = await open(right, 'r')
    const size = 1024 * 1024
    const leftBuf = Buffer.allocUnsafe(size)
    const rightBuf = Buffer.allocUnsafe(size)
    for (;;) {
      const [first, second] = await Promise.all([
        a.read(leftBuf, 0, size, null),
        b.read(rightBuf, 0, size, null),
      ])
      if (first.bytesRead !== second.bytesRead) return false
      if (first.bytesRead === 0) return true
      if (!leftBuf.subarray(0, first.bytesRead).equals(rightBuf.subarray(0, second.bytesRead))) return false
    }
  } catch {
    return false
  } finally {
    await a?.close().catch(() => undefined)
    await b?.close().catch(() => undefined)
  }
}

/** Size of an existing snapshot, or `undefined` when there is nothing there. */
async function existingBytes(target: string): Promise<number | undefined> {
  try {
    const info = await lstat(target)
    // Never adopt a symlink: the content address would stop naming the bytes.
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

/**
 * Remove abandoned temp files.
 *
 * A temp file only outlives its delivery when the process died mid-write, so the
 * same age bound applies. Live writes are never this old.
 */
async function dropStaleTemps(tempDir: string, now: number, ttl: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(tempDir)
  } catch {
    return
  }
  for (const name of names) {
    const full = path.join(tempDir, name)
    try {
      const info = await lstat(full)
      if (!info.isFile() || now - info.mtimeMs < ttl) continue
      await rm(full, { force: true })
    } catch {
      // Already gone.
    }
  }
}

/**
 * Open the cache for the root in force right now.
 *
 * The root is resolved through `realpath` before any path is handed out: the
 * official tool records what `processPath` returns, the card later requires that
 * exact string to survive a resolve round trip, and the local backend's
 * `processPath` is a realpath. Recording the lexical spelling would open a card
 * against a path the verifier never reproduces. `DSH_HOME` is a symlink on some
 * installs, so this is not hypothetical.
 *
 * A cache whose root cannot be created is not an error: the caller falls back to
 * staging at the placeholder path, which still works.
 */
export async function openPresentCache(env: NodeJS.ProcessEnv = process.env): Promise<PresentCache | undefined> {
  const lexical = presentCacheRoot(env)
  try {
    await mkdir(path.join(lexical, TEMP_DIR), { recursive: true, mode: DIR_MODE })
    await chmod(lexical, DIR_MODE).catch(() => undefined)
    const root = await realpath(lexical)
    // Superseded roots keep their snapshots readable, so pruning has to reach
    // them or their bytes are never reclaimed. A root that does not exist is
    // still listed; `hashDirectories` returns nothing for it.
    const roots = presentCacheRoots(env)
    return createPresentCache(root, { roots: roots.includes(lexical) ? roots : [...roots, lexical] })
  } catch {
    return undefined
  }
}
