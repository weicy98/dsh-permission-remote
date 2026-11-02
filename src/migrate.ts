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
 * Planning and copying are separate calls. The settings page asks once with
 * {@link planRemoteRoot} (which reads the tree but writes nothing), shows the
 * conflicts it found, and then executes that same plan with {@link runMigration}.
 * The tree is walked and the files compared exactly once, and what the operator
 * approved is what runs.
 */
import { constants } from 'node:fs'
import { copyFile, cp, mkdir, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

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
  /** Conflicting files to replace with the old copy (`overwrite` only). */
  overwrites: CopyStep[]
  /** Relative paths the plan leaves untouched. */
  conflicts: string[]
  /** Identical files, counted but not touched. */
  skipped: number
}

type PathKind = 'missing' | 'dir' | 'file'

const COMPARE_CHUNK = 64 * 1024

async function pathKind(target: string): Promise<PathKind> {
  try {
    const info = await stat(target)
    return info.isDirectory() ? 'dir' : 'file'
  } catch {
    return 'missing'
  }
}

async function isEmptyDir(target: string): Promise<boolean> {
  return (await readdir(target)).length === 0
}

async function countTree(root: string): Promise<number> {
  let count = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    count += entry.isDirectory() ? await countTree(join(root, entry.name)) : 1
  }
  return count
}

/** `child` equals `parent` or sits below it, lexically. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The path with symlinks resolved, or the lexical path when it does not exist.
 *
 * A root that is itself a symlink (`~/.dsh` is one on some installs) would
 * otherwise slip past the nesting check and let a copy walk into itself.
 */
async function physicalPath(target: string): Promise<string> {
  try {
    return await realpath(target)
  } catch {
    return resolve(target)
  }
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
    const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
    const source = join(oldRoot, childRel)
    const target = join(newRoot, childRel)
    const kind = await pathKind(target)
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
  const oldKind = await pathKind(from)
  if (oldKind === 'file') throw new Error(`the current remote root ${from} is not a directory`)
  if (await pathKind(to) === 'file') throw new Error(`the target ${to} exists and is not a directory`)

  // Nothing to move yet: just make the new root and switch the setting.
  if (oldKind === 'missing') return { ...plan, action: 'copied', targetWasEmpty: true }

  const targetWasEmpty = (await pathKind(to)) === 'missing' || (await isEmptyDir(to))
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
    copied: plan.copyTree ? 0 : plan.copies.length,
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
export async function runMigration(plan: MigrationPlan): Promise<MigrationReport> {
  if (plan.action === 'unchanged') return plannedReport(plan)
  await mkdir(plan.newRoot, { recursive: true })
  if (plan.copyTree) {
    const copied = await countTree(plan.oldRoot)
    await cp(plan.oldRoot, plan.newRoot, { recursive: true, force: true })
    return { ...plannedReport(plan), copied }
  }
  for (const dir of plan.directories) await mkdir(dir, { recursive: true })
  let copied = 0
  let overwritten = 0
  const conflicts = [...plan.conflicts]
  for (const step of plan.copies) {
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
  for (const step of plan.overwrites) {
    await copyFile(step.source, step.target)
    overwritten += 1
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
