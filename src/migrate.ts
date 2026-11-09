/**
 * Move the remote-workspace placeholder tree to a new root.
 *
 * The placeholder directories are mostly empty workspace roots, but the plugin
 * must not assume that: a workspace may hold files that a remote command left
 * behind. The rules mirror the operator's choice:
 *
 * - a missing or empty target is a straight copy;
 * - a non-empty target is merged: missing entries are copied, identical files
 *   are skipped, and a file that differs is a conflict. `auto` keeps the
 *   target's copy (nothing is lost) and reports it; `overwrite` replaces it
 *   with the old root's copy;
 * - a name that is a directory on one side and a file on the other is always a
 *   conflict, never resolved automatically: replacing a file with a tree (or
 *   the reverse) is not what "keep target" or "use the old copy" promises. It
 *   is reported so the operator can look at it.
 *
 * Planning and copying are separate calls. {@link planRemoteRoot} reads the
 * tree and writes nothing; {@link runMigration} executes the copy list that plan
 * produced, so a plan and the run built from it never disagree.
 *
 * The settings action may plan twice for one change: once to report the
 * conflicts, and again with the operator's chosen strategy to execute. A file
 * that appears in the target between those two plans therefore is not part of
 * the previewed conflict list; the page sends the list it showed, and a new
 * conflict is asked again instead of being overwritten.
 *
 * Symlinks are not followed. A link in the target is a conflict, and a link in
 * the old tree is copied as a link. Writing through a link would change a file
 * outside the new root, or truncate whatever the link points at.
 */
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readdir, readlink, realpath, rmdir, stat, symlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { PRESENT_CACHE_DIR } from './router.ts'

export type MigrationStrategy = 'auto' | 'overwrite'

export interface MigrationReport {
  oldRoot: string
  newRoot: string
  action: 'copied' | 'merged' | 'unchanged'
  /** The target did not exist, or existed as an empty directory. */
  targetWasEmpty: boolean
  copied: number
  skipped: number
  overwritten: number
  /**
   * Relative paths left untouched: different content kept by `auto`, or a name
   * that is a directory on one side and a file on the other.
   */
  conflicts: string[]
}

/** One file operation the plan decided on. `rel` is the report's spelling. */
interface CopyStep {
  source: string
  target: string
  rel: string
}

export interface MigrationPlan {
  oldRoot: string
  newRoot: string
  action: 'copied' | 'merged' | 'unchanged'
  targetWasEmpty: boolean
  /** The whole old tree is copied as it is (the target was absent or empty). */
  copyTree: boolean
  /** Target directories to create, parents first. */
  directories: string[]
  /** Files missing on the target. Created exclusively, never overwriting. */
  copies: CopyStep[]
  /** Symlinks in the old tree, recreated as links and never followed. */
  links: CopyStep[]
  /** Conflicting files to replace with the old copy (`overwrite` only). */
  overwrites: CopyStep[]
  /** Relative paths the plan leaves untouched. */
  conflicts: string[]
  /** Identical files, counted but not touched. */
  skipped: number
}

type PathKind = 'missing' | 'dir' | 'file' | 'symlink' | 'other'

const COMPARE_CHUNK = 64 * 1024
const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW

/** `follow` is only for the roots themselves. Entries inside the tree use lstat. */
async function pathKind(target: string, follow = false): Promise<PathKind> {
  try {
    const info = follow ? await stat(target) : await lstat(target)
    if (info.isSymbolicLink()) return 'symlink'
    if (info.isDirectory()) return 'dir'
    if (info.isFile()) return 'file'
    return 'other'
  } catch {
    return 'missing'
  }
}

async function isEmptyDir(target: string): Promise<boolean> {
  return (await readdir(target)).length === 0
}

/**
 * Delivery snapshots are not part of the move.
 *
 * They are content addressed and only reachable through a path a past card
 * recorded, so copying them would duplicate gigabytes for no gain and counting
 * them would inflate the report the operator approves. The old root keeps them,
 * which is where an already-recorded card still looks.
 *
 * Only the top level is skipped. A subdirectory that merely shares the name is
 * an ordinary placeholder directory and belongs to the move.
 */
function isSnapshotTree(name: string, depth: number): boolean {
  return depth === 0 && name === PRESENT_CACHE_DIR
}

async function countTree(root: string, depth = 0): Promise<number> {
  let count = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (isSnapshotTree(entry.name, depth)) continue
    count += entry.isDirectory() ? await countTree(join(root, entry.name), depth + 1) : 1
  }
  return count
}

/** `child` equals `parent` or sits below it, lexically. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The path with symlinks resolved.
 *
 * A root that is itself a symlink (`~/.dsh` is one on some installs) would
 * otherwise slip past the nesting check and let a copy walk into itself.
 * When the path does not exist yet, the nearest existing ancestor is resolved
 * and the missing tail is rejoined, so a parent link cannot disguise a child
 * of the old root as a sibling of it.
 */
async function physicalPath(target: string): Promise<string> {
  const resolved = resolve(target)
  try {
    return await realpath(resolved)
  } catch {
    const tail: string[] = []
    let cursor = resolved
    for (;;) {
      const parent = dirname(cursor)
      if (parent === cursor) return resolved
      tail.push(basename(cursor))
      cursor = parent
      let ancestor: string
      try {
        ancestor = await realpath(cursor)
      } catch {
        // This ancestor does not exist yet either.
        continue
      }
      // Pushed leaf-first. Reverse only after the ancestor resolved, so a
      // failed realpath cannot leave the tail backwards for the next try.
      tail.reverse()
      return join(ancestor, ...tail)
    }
  }
}

/** A write through a parent symlink lands outside `rootReal`. */
async function resolvesInside(rootReal: string, target: string): Promise<boolean> {
  return within(rootReal, await physicalPath(target))
}

/**
 * Compare two files without holding either in memory.
 *
 * Placeholder trees are mostly empty, but one leftover artifact must not turn a
 * directory walk into two full reads of the same file.
 */
async function sameContent(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([stat(a), stat(b)])
  if (!left.isFile() || !right.isFile()) return false
  if (left.size !== right.size) return false
  const [leftHandle, rightHandle] = await Promise.all([open(a, 'r'), open(b, 'r')])
  try {
    const leftBytes = Buffer.alloc(COMPARE_CHUNK)
    const rightBytes = Buffer.alloc(COMPARE_CHUNK)
    for (;;) {
      const [leftRead, rightRead] = await Promise.all([
        leftHandle.read(leftBytes, 0, COMPARE_CHUNK, null),
        rightHandle.read(rightBytes, 0, COMPARE_CHUNK, null),
      ])
      if (leftRead.bytesRead !== rightRead.bytesRead) return false
      if (leftRead.bytesRead === 0) return true
      const leftChunk = leftBytes.subarray(0, leftRead.bytesRead)
      const rightChunk = rightBytes.subarray(0, rightRead.bytesRead)
      if (!leftChunk.equals(rightChunk)) return false
    }
  } finally {
    await Promise.all([leftHandle.close(), rightHandle.close()])
  }
}

async function planMerge(
  oldRoot: string,
  newRoot: string,
  strategy: MigrationStrategy,
  plan: MigrationPlan,
  rel = '',
): Promise<void> {
  const sourceDir = rel.length === 0 ? oldRoot : join(oldRoot, rel)
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    // See `isSnapshotTree`: only the root's own snapshot directory is skipped.
    if (rel.length === 0 && entry.name === PRESENT_CACHE_DIR) continue
    const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
    const source = join(oldRoot, childRel)
    const target = join(newRoot, childRel)
    const kind = await pathKind(target)
    // A symlink on either side is left untouched. Following it would write
    // outside the new root, and replacing it would truncate the link target.
    if (entry.isSymbolicLink() || kind === 'symlink' || kind === 'other') {
      if (entry.isSymbolicLink() && kind === 'missing') plan.links.push({ source, target, rel: childRel })
      else plan.conflicts.push(childRel)
      continue
    }
    if (entry.isDirectory()) {
      // A file in the target where the old root has a directory: leave both
      // sides alone instead of wiping the file, and let the report say why.
      if (kind === 'file') {
        plan.conflicts.push(childRel)
        continue
      }
      plan.directories.push(target)
      await planMerge(oldRoot, newRoot, strategy, plan, childRel)
      continue
    }
    if (kind === 'missing') {
      plan.copies.push({ source, target, rel: childRel })
      continue
    }
    if (kind === 'dir') {
      plan.conflicts.push(childRel)
      continue
    }
    if (await sameContent(source, target)) {
      plan.skipped += 1
      continue
    }
    plan.conflicts.push(childRel)
    if (strategy === 'overwrite') plan.overwrites.push({ source, target, rel: childRel })
  }
}

/**
 * Decide what a migration would do, reading the old tree once and writing
 * nothing. Throws before any of that when the roots are unusable (same path,
 * nested, or not a directory), so the page can report a real error instead of
 * asking the operator to confirm an impossible move.
 */
export async function planRemoteRoot(
  oldRoot: string,
  newRoot: string,
  strategy: MigrationStrategy = 'auto',
): Promise<MigrationPlan> {
  const from = resolve(oldRoot)
  const to = resolve(newRoot)
  const plan: MigrationPlan = {
    oldRoot: from,
    newRoot: to,
    action: 'unchanged',
    targetWasEmpty: false,
    copyTree: false,
    directories: [],
    copies: [],
    links: [],
    overwrites: [],
    conflicts: [],
    skipped: 0,
  }
  if (from === to) return plan
  if (within(from, to) || within(to, from)) {
    throw new Error('the new remote root must not be inside the old one, or the old one inside it')
  }
  const [fromReal, toReal] = await Promise.all([physicalPath(from), physicalPath(to)])
  if (within(fromReal, toReal) || within(toReal, fromReal)) {
    throw new Error('the new remote root must not be inside the old one, or the old one inside it')
  }
  const oldKind = await pathKind(from, true)
  if (oldKind !== 'dir' && oldKind !== 'missing') throw new Error(`the current remote root ${from} is not a directory`)
  if ((await pathKind(to, true)) === 'file') throw new Error(`the target ${to} exists and is not a directory`)

  // Nothing to move yet: just make the new root and switch the setting.
  if (oldKind === 'missing') return { ...plan, action: 'copied', targetWasEmpty: true }

  const targetWasEmpty = (await pathKind(to, true)) === 'missing' || (await isEmptyDir(to))
  if (targetWasEmpty) {
    return { ...plan, action: 'copied', targetWasEmpty: true, copyTree: true }
  }
  const merged: MigrationPlan = { ...plan, action: 'merged', targetWasEmpty: false }
  await planMerge(from, to, strategy, merged)
  return merged
}

/** The plan's own counts, for showing what it would do without doing it. */
export function plannedReport(plan: MigrationPlan): MigrationReport {
  return {
    oldRoot: plan.oldRoot,
    newRoot: plan.newRoot,
    action: plan.action,
    targetWasEmpty: plan.targetWasEmpty,
    // A whole-tree copy learns its count while copying; see the callers.
    copied: plan.copyTree ? 0 : plan.copies.length + plan.links.length,
    skipped: plan.skipped,
    overwritten: plan.overwrites.length,
    conflicts: [...plan.conflicts],
  }
}

/**
 * Execute a plan.
 *
 * Copies are created exclusively: if a file appears in the target between the
 * plan and the run, it is reported as a conflict instead of being overwritten,
 * which keeps `auto`'s promise that nothing in the target is lost.
 */
/** Replace a regular file without following a symlink that appears in its place. */
async function overwriteRegularFile(source: string, target: string): Promise<void> {
  const info = await lstat(target)
  if (!info.isFile()) {
    const error = new Error(`refusing to replace ${target}`) as NodeJS.ErrnoException
    error.code = 'EEXIST'
    throw error
  }
  if (typeof NOFOLLOW !== 'number') {
    await copyFile(source, target)
    return
  }
  const src = await open(source, constants.O_RDONLY)
  try {
    const dest = await open(target, constants.O_WRONLY | constants.O_TRUNC | NOFOLLOW)
    try {
      const bytes = Buffer.alloc(COMPARE_CHUNK)
      for (;;) {
        const read = await src.read(bytes, 0, COMPARE_CHUNK, null)
        if (read.bytesRead === 0) break
        let offset = 0
        while (offset < read.bytesRead) {
          const wrote = await dest.write(bytes, offset, read.bytesRead - offset)
          if (wrote.bytesWritten === 0) throw new Error(`could not write ${target}`)
          offset += wrote.bytesWritten
        }
      }
    } finally {
      await dest.close()
    }
  } finally {
    await src.close()
  }
}

/**
 * Copy one old-tree entry without following symlinks.
 *
 * `cp` follows links by default, which would pull an outside directory into
 * the new root or write through a link that landed there.
 */
async function copyEntry(source: string, target: string, rootReal: string): Promise<void> {
  if (!(await resolvesInside(rootReal, target))) {
    throw new Error(`refusing to write ${target}: it resolves outside the new remote root`)
  }
  const info = await lstat(source)
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), target)
    return
  }
  if (info.isDirectory()) {
    await mkdir(target)
    for (const name of await readdir(source)) await copyEntry(join(source, name), join(target, name), rootReal)
    return
  }
  if (info.isFile()) {
    await copyFile(source, target, constants.COPYFILE_EXCL)
  }
}

async function assertDistinctRoots(plan: MigrationPlan, rootReal: string): Promise<void> {
  const oldReal = await physicalPath(plan.oldRoot)
  if (within(oldReal, rootReal) || within(rootReal, oldReal)) {
    throw new Error('the new remote root must not be inside the old one, or the old one inside it')
  }
}

/**
 * Create the new root only when its resolved path stays outside the old one.
 *
 * A parent symlink can make a missing path look like a sibling while its real
 * location is inside the old tree. Checking after mkdir would leave that
 * directory behind.
 */
async function openNewRoot(plan: MigrationPlan): Promise<string> {
  await assertDistinctRoots(plan, await physicalPath(plan.newRoot))
  const before = await pathKind(plan.newRoot)
  await mkdir(plan.newRoot, { recursive: true })
  const rootReal = await realpath(plan.newRoot)
  try {
    await assertDistinctRoots(plan, rootReal)
  } catch (error) {
    if (before === 'missing') await rmdir(plan.newRoot).catch(() => undefined)
    throw error
  }
  return rootReal
}

export async function runMigration(plan: MigrationPlan): Promise<MigrationReport> {
  if (plan.action === 'unchanged') return plannedReport(plan)
  if (plan.copyTree) {
    // The plan wanted a whole-tree copy because the target was absent or empty.
    // If it gained content since, a `force` copy would silently overwrite files
    // the operator never saw: refuse instead, so nothing in the target is lost.
    // The operator can re-run, which plans a merge and reports the conflicts.
    const kind = await pathKind(plan.newRoot, true)
    if (kind === 'file') throw new Error(`the target ${plan.newRoot} is no longer a directory`)
    if (kind === 'dir' && !(await isEmptyDir(plan.newRoot))) {
      throw new Error(`the target ${plan.newRoot} is no longer empty; nothing was copied and nothing was overwritten`)
    }
    const copied = await countTree(plan.oldRoot)
    const rootReal = await openNewRoot(plan)
    for (const name of await readdir(plan.oldRoot)) {
      // Snapshots stay behind; see `isSnapshotTree`.
      if (name === PRESENT_CACHE_DIR) continue
      await copyEntry(join(plan.oldRoot, name), join(plan.newRoot, name), rootReal)
    }
    return { ...plannedReport(plan), copied }
  }
  const rootReal = await openNewRoot(plan)
  let copied = 0
  let overwritten = 0
  const conflicts = [...plan.conflicts]
  for (const dir of plan.directories) {
    if (!(await resolvesInside(rootReal, dir))) {
      throw new Error(`refusing to create ${dir}: it resolves outside the new remote root`)
    }
    const kind = await pathKind(dir)
    if (kind === 'symlink' || kind === 'file' || kind === 'other') {
      conflicts.push(relative(plan.newRoot, dir).split('\\').join('/'))
      continue
    }
    await mkdir(dir, { recursive: true })
  }
  for (const step of plan.copies) {
    if (!(await resolvesInside(rootReal, step.target))) {
      throw new Error(`refusing to write ${step.target}: it resolves outside the new remote root`)
    }
    try {
      await copyFile(step.source, step.target, constants.COPYFILE_EXCL)
      copied += 1
    } catch (error) {
      // The target gained this file after the plan was made; report it instead
      // of silently overwriting what the operator was told would be kept.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        conflicts.push(step.rel)
        continue
      }
      throw error
    }
  }
  for (const step of plan.links) {
    if (!(await resolvesInside(rootReal, step.target))) {
      throw new Error(`refusing to write ${step.target}: it resolves outside the new remote root`)
    }
    try {
      await symlink(await readlink(step.source), step.target)
      copied += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        conflicts.push(step.rel)
        continue
      }
      throw error
    }
  }
  for (const step of plan.overwrites) {
    if (!(await resolvesInside(rootReal, step.target))) {
      throw new Error(`refusing to write ${step.target}: it resolves outside the new remote root`)
    }
    try {
      await overwriteRegularFile(step.source, step.target)
      overwritten += 1
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST' || code === 'ELOOP') {
        conflicts.push(step.rel)
        continue
      }
      throw error
    }
  }
  return {
    ...plannedReport(plan),
    copied,
    overwritten,
    conflicts,
  }
}

/**
 * Plan and immediately run a migration.
 *
 * Kept for callers that do not need the two-step flow (tests, scripts). The
 * settings page plans once and then runs that plan.
 */
export async function migrateRemoteRoot(
  oldRoot: string,
  newRoot: string,
  strategy: MigrationStrategy = 'auto',
  dryRun = false,
): Promise<MigrationReport> {
  const plan = await planRemoteRoot(oldRoot, newRoot, strategy)
  if (dryRun) {
    if (!plan.copyTree) return plannedReport(plan)
    return { ...plannedReport(plan), copied: await countTree(plan.oldRoot) }
  }
  return runMigration(plan)
}
