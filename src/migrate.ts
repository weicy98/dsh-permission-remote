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
 *   with the old root's copy.
 */
import { copyFile, cp, mkdir, readdir, readFile, stat } from 'node:fs/promises'
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
  /** Relative paths present on both sides with different content. */
  conflicts: string[]
}

type PathKind = 'missing' | 'dir' | 'file'

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

async function sameContent(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([stat(a), stat(b)])
  if (!left.isFile() || !right.isFile()) return false
  if (left.size !== right.size) return false
  const [leftBytes, rightBytes] = await Promise.all([readFile(a), readFile(b)])
  return leftBytes.equals(rightBytes)
}

async function mergeInto(
  oldRoot: string,
  newRoot: string,
  strategy: MigrationStrategy,
  report: MigrationReport,
  dryRun: boolean,
  rel = '',
): Promise<void> {
  const sourceDir = rel.length === 0 ? oldRoot : join(oldRoot, rel)
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const childRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`
    const source = join(oldRoot, childRel)
    const target = join(newRoot, childRel)
    if (entry.isDirectory()) {
      if (!dryRun) await mkdir(target, { recursive: true })
      await mergeInto(oldRoot, newRoot, strategy, report, dryRun, childRel)
      continue
    }
    const kind = await pathKind(target)
    if (kind === 'missing') {
      report.copied += 1
      if (!dryRun) await copyFile(source, target)
      continue
    }
    if (kind === 'dir') {
      report.conflicts.push(childRel)
      continue
    }
    if (await sameContent(source, target)) {
      report.skipped += 1
      continue
    }
    report.conflicts.push(childRel)
    if (strategy === 'overwrite') {
      report.overwritten += 1
      if (!dryRun) await copyFile(source, target)
    }
  }
}

export async function migrateRemoteRoot(
  oldRoot: string,
  newRoot: string,
  strategy: MigrationStrategy = 'auto',
  dryRun = false,
): Promise<MigrationReport> {
  const from = resolve(oldRoot)
  const to = resolve(newRoot)
  const empty: MigrationReport = {
    oldRoot: from,
    newRoot: to,
    action: 'unchanged',
    targetWasEmpty: false,
    copied: 0,
    skipped: 0,
    overwritten: 0,
    conflicts: [],
  }
  if (from === to) return empty
  if (within(from, to) || within(to, from)) {
    throw new Error('the new remote root must not be inside the old one, or the old one inside it')
  }
  const oldKind = await pathKind(from)
  if (oldKind === 'file') throw new Error(`the current remote root ${from} is not a directory`)
  if (await pathKind(to) === 'file') throw new Error(`the target ${to} exists and is not a directory`)

  // Nothing to move yet: just make the new root and switch the setting.
  if (oldKind === 'missing') {
    if (!dryRun) await mkdir(to, { recursive: true })
    return { ...empty, action: 'copied', targetWasEmpty: true }
  }

  const targetWasEmpty = (await pathKind(to)) === 'missing' || (await isEmptyDir(to))
  if (targetWasEmpty) {
    const copied = await countTree(from)
    if (!dryRun) {
      await mkdir(to, { recursive: true })
      await cp(from, to, { recursive: true, force: true })
    }
    return { ...empty, action: 'copied', targetWasEmpty: true, copied }
  }
  const report: MigrationReport = { ...empty, action: 'merged', targetWasEmpty: false }
  await mergeInto(from, to, strategy, report, dryRun)
  return report
}
