import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * Migration bookkeeping kept beside the settings, not inside them.
 *
 * Two pieces of state describe work in progress rather than anything the
 * operator chose: the placeholder roots this profile migrated away from, and
 * the sessions whose workspace membership still needs restoring. They used to
 * be `volatile` config fields, which is also what makes a field editable in the
 * generic settings page — internal bookkeeping should not be there, and a
 * mistaken edit silently drops the record of a session that still needs
 * re-homing.
 *
 * They live in their own JSON document under the DSH home instead, written
 * through `writeFileAtomic` (readers see the old or the new document, never a
 * partial one) with `0600` because it names local paths. Every read is
 * defensive: a corrupt or missing file degrades to empty bookkeeping, which the
 * next migration or sweep rebuilds, rather than failing the plugin load.
 */

const STATE_FILE_NAME = 'dsh-permission-remote.migration.json'
const STATE_VERSION = 1
const STATE_MODE = 0o600

/** One relocated session waiting for its workspace membership to be restored. */
export interface PendingSessionGrouping {
  /** The workspace placeholder path the session now lives at. */
  path: string
  /** The session id to attach to that workspace. */
  id: string
}

/** The persisted migration bookkeeping. */
export interface MigrationState {
  /** Placeholder roots this profile migrated away from, oldest first. */
  supersededRemoteRoots: string[]
  /** Relocated sessions whose workspace membership still needs restoring. */
  pendingSessionGrouping: PendingSessionGrouping[]
}

/** An empty state, used when the file is absent or unreadable. */
export function emptyMigrationState(): MigrationState {
  return { supersededRemoteRoots: [], pendingSessionGrouping: [] }
}

/**
 * Where the bookkeeping lives for this DSH home.
 *
 * Under the plugin's own `data/` directory, alongside other plugins' state, not
 * in `storages/` — that is DSH's own storage-unit directory and enumerating or
 * relocating it should stay DSH's business.
 */
export function migrationStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env.DSH_HOME || undefined, env), 'data', 'dsh-permission-remote', STATE_FILE_NAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keep absolute, non-empty roots, first spelling wins, order stable. */
export function normalizeRootList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const root = item.trim()
    if (root.length === 0) continue
    // A placeholder root is always absolute: POSIX, a drive letter, or UNC.
    if (!(root.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\'))) continue
    if (seen.has(root)) continue
    seen.add(root)
    out.push(root)
  }
  return out
}

/** Keep well-formed pending entries, deduped by session id (first wins). */
export function normalizePendingList(value: unknown): PendingSessionGrouping[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: PendingSessionGrouping[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const path = typeof item.path === 'string' ? item.path.trim() : ''
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (path.length === 0 || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    out.push({ path, id })
  }
  return out
}

/** Validate an arbitrary parsed document into a {@link MigrationState}. */
export function parseMigrationState(raw: unknown): MigrationState {
  if (!isRecord(raw)) return emptyMigrationState()
  return {
    supersededRemoteRoots: normalizeRootList(raw.supersededRemoteRoots),
    pendingSessionGrouping: normalizePendingList(raw.pendingSessionGrouping),
  }
}

/** Shape written to disk; a version tag lets a future format migrate the file. */
function serialize(state: MigrationState): string {
  return `${JSON.stringify({
    version: STATE_VERSION,
    supersededRemoteRoots: state.supersededRemoteRoots,
    pendingSessionGrouping: state.pendingSessionGrouping,
  }, null, 2)}\n`
}

/**
 * Read the bookkeeping, degrading to empty on any problem.
 *
 * A missing file is the normal first-run case. A corrupt one costs at most a
 * lost pending attach (the session stays where it was moved to, merely
 * ungrouped), which a later migration rebuilds — so this never throws.
 */
export interface ReadMigrationStateResult {
  state: MigrationState
  /** A human-readable note when the file was absent-but-corrupt or a newer shape. */
  problem?: string
  /**
   * The file exists but could not be read (EACCES/EBUSY/…). Distinct from a
   * missing or corrupt file: the caller must NOT overwrite it, or it would
   * clobber bookkeeping it simply was not allowed to see.
   */
  readError?: boolean
}

export async function readMigrationState(env: NodeJS.ProcessEnv = process.env): Promise<ReadMigrationStateResult> {
  let text: string
  try {
    text = await readFile(migrationStatePath(env), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Missing is the normal first run — safe to write a fresh document later.
    if (code === 'ENOENT') return { state: emptyMigrationState() }
    return { state: emptyMigrationState(), problem: `the migration bookkeeping could not be read: ${code ?? String(error)}`, readError: true }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    // Corrupt but readable: degrade to empty and allow a rewrite to heal it.
    return { state: emptyMigrationState(), problem: 'the migration bookkeeping file is not valid JSON' }
  }
  const state = parseMigrationState(raw)
  if (isRecord(raw) && raw.version !== undefined && raw.version !== STATE_VERSION) {
    return { state, problem: `the migration bookkeeping was written by a different version (${String(raw.version)}); reading what it can` }
  }
  return { state }
}

/**
 * Replace the bookkeeping document atomically.
 *
 * `writeFileAtomic` writes a fresh sibling and renames it over the target, so a
 * concurrent reader (the same plugin in another DSH process, or this one after
 * a partial write) only ever sees a complete document. Throws on failure; the
 * caller decides whether that is fatal (it never is for migration bookkeeping).
 */
export async function writeMigrationState(state: MigrationState, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await writeFileAtomic(migrationStatePath(env), serialize(state), { mode: STATE_MODE, dirMode: 0o700 })
}
