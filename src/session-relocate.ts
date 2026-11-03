import { realpathSync } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join as joinPath, relative as relativePath, resolve as resolvePath, sep } from 'node:path'
import { constants as zconst, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * Relocate stored sessions after a remote-root migration.
 *
 * What actually breaks when `Core.changeRemoteRoot` re-registers the
 * workspaces at a new root without touching the sessions — the session logs
 * themselves stay consistent, because each log already sits in the project
 * directory its own header names, and the backend keeps loading it:
 *
 * 1. The workspace registry filters a session out of membership when the
 *    canonical cwd of its header differs from the workspace path, so every
 *    older session drops out of its sidebar group.
 * 2. The plugin's entry guard refuses a cwd on an old placeholder that no
 *    registered workspace covers, so the session can no longer be used.
 *
 * The repair restores both by moving the session to the new root: rewrite only
 * the header frame (or first line) so the `cwd` names the new placeholder,
 * keep every following byte — complete event frames and a torn final frame
 * alike — exactly as written, and move the session directory to the project
 * key the new `cwd` implies. The move is a whole-directory rename, so older
 * format generations and the session lock travel with it.
 *
 * Sessions that are currently live are skipped: their writer owns the files.
 * The workspace registry also caches session headers at startup, so attaching
 * a just-moved session to its workspace is left to the caller to retry on the
 * next plugin load, when the registry reads headers from disk again.
 *
 * The filename, segment-encoding, project-key, and frame-scanning rules mirror
 * `@deepseek-ai/dsh-session-persistence-jsonl`; the persistence service
 * exposes no path or rename operation, so the file surgery happens here.
 */

const ZSTD_MAGIC = 0xfd2fb528
const SESSION_FORMAT_VERSION = 4
const CHECKSUM_OPTIONS = { params: { [zconst.ZSTD_c_checksumFlag]: 1 } }
/**
 * Generation filenames, DSH's canonical rule: generation 0 is written without
 * a version tag (`session.jsonl[.zstd]`), later generations carry the tag. A
 * literal `session.v0.jsonl` is explicitly not a committed generation and is
 * ignored here, exactly like the backend ignores it.
 */
const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/
/** Hard ceiling for the in-memory header rewrite; real session logs are far below it. */
const MAX_REWRITE_BYTES = 64 * 1024 * 1024
/** First read of a header probe; a header frame is a few hundred bytes. */
const HEADER_PROBE_BYTES = 4 * 1024

/** Whether this Node build can rewrite a Zstandard header frame. */
export function zstdAvailable(): boolean {
  return typeof zstdCompressSync === 'function' && typeof zstdDecompressSync === 'function'
}

/**
 * Encode one Session id as a single safe path segment.
 *
 * Kept verbatim against `@deepseek-ai/dsh-session-persistence-jsonl`; a
 * divergence would move a log to a directory DSH does not look in. The drift
 * guard in {@link relocateSessions} turns any divergence into a loud failure
 * instead of a silent move to a wrong directory.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the readable project directory key for a Session `cwd`, matching the
 * persistence backend's own encoder including its 251-unit truncation.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Whether `cwd` is the root itself or a path inside it.
 *
 * `path.relative` is used so Windows drive-letter and component case fold the
 * way the filesystem folds it; a raw prefix comparison would miss a session
 * whose header spells the same path with a different drive-letter case.
 */
function isEscapingRelative(rel: string): boolean {
  // A real parent escape only: `..` alone or `..` followed by a separator. A
  // sibling literally named `..cache` is inside the root, not outside it.
  return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../')
}

function sitsUnderRoot(cwd: string, root: string): boolean {
  const rel = relativePath(root, cwd)
  if (rel === '') return true
  if (isEscapingRelative(rel)) return false
  return !(rel.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rel))
}

/**
 * Every spelling of a placeholder root that a stored cwd may use.
 *
 * The configured root is only `path.resolve`d, but DSH registers workspaces
 * through `realpath`, and a Session header records the canonical cwd. On an
 * install where the root itself sits behind a symlink (`~/.dsh` is commonly a
 * link), those two spellings differ — comparing against one of them silently
 * matches nothing. Both are therefore candidates, the lexical one first so a
 * genuine non-symlink path always wins.
 */
export function rootCandidateSpellings(root: string): string[] {
  const trimmed = root.replace(/[\\/]+$/, '')
  const out = [trimmed]
  try {
    const real = realpathSync(trimmed).replace(/[\\/]+$/, '')
    if (real !== trimmed) out.push(real)
  } catch {
    // A root that does not exist yet has no canonical spelling; the lexical
    // one is all there is.
  }
  return out
}

/** Whether `cwd` sits under any spelling of the root. */
function sitsUnder(cwd: string, roots: readonly string[]): boolean {
  return roots.some(root => sitsUnderRoot(cwd, root))
}

/**
 * The session's placeholder path moved from `oldRoot` to `newRoot`.
 *
 * `olds` holds every accepted spelling of the old root; the one that actually
 * contains `cwd` is the one whose remainder is carried over.
 */
export function mapPlaceholderCwd(cwd: string, olds: readonly string[], newRoot: string): string {
  const trimmedNew = newRoot.replace(/[\\/]+$/, '')
  for (const old of olds) {
    const trimmedOld = old.replace(/[\\/]+$/, '')
    const rest = relativePath(trimmedOld, cwd)
    if (rest === '') return trimmedNew
    if (isEscapingRelative(rest) || rest.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rest)) continue
    return joinPath(trimmedNew, rest)
  }
  // No spelling contains it; fall back to the lexical prefix strip so a caller
  // that already established membership keeps its old behaviour.
  const trimmedOld = olds[0]!.replace(/[\\/]+$/, '')
  const lexical = cwd.slice(trimmedOld.length).replace(/^[\\/]+/, '')
  return lexical.length === 0 ? trimmedNew : joinPath(trimmedNew, lexical)
}

/** Structural scan result: complete frames plus an optional torn final frame. */
interface FrameScan {
  frames: Array<{ start: number, end: number }>
  /** Start of an incomplete final frame; the backend treats it as committed prefix. */
  tornStart?: number
}

/**
 * Locate complete frames without decompressing their blocks, mirroring the
 * backend's scanner including its tolerance: an incomplete final frame is a
 * torn tail (a crash mid-append — DSH opens such logs as a committed prefix),
 * not an error. Structural corruption inside a complete frame still throws.
 */
export function scanLogFrames(buffer: Buffer): FrameScan {
  const frames: Array<{ start: number, end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      offset += blockType === 1 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    if (offset > buffer.length) return { frames, tornStart: start }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** Decode the newest log's header from a probed prefix or a complete buffer. */
function decodeHeader(bytes: Buffer, compression: boolean): { header: Record<string, unknown>, headerEnd: number } {
  if (compression) {
    const scan = scanLogFrames(bytes)
    if (scan.frames.length === 0) throw new Error('the log holds no complete header frame')
    const text = zstdDecompressSync(bytes.subarray(scan.frames[0].start, scan.frames[0].end))
    if (text.length === 0 || text.indexOf(10) !== text.length - 1) throw new Error('first frame is not exactly one header line')
    return { header: JSON.parse(text.subarray(0, -1).toString('utf8')) as Record<string, unknown>, headerEnd: scan.frames[0].end }
  }
  const cut = bytes.indexOf(10)
  const text = cut < 0 ? bytes : bytes.subarray(0, cut)
  return { header: JSON.parse(text.toString('utf8')) as Record<string, unknown>, headerEnd: cut < 0 ? bytes.length : cut + 1 }
}

/**
 * Read just enough of a log to decode its header.
 *
 * The scan phase runs over every stored session, so reading each log whole
 * would drag hundreds of megabytes through I/O on a single settings save. A
 * header frame is tiny; the probe starts at 64 KiB and grows only when it
 * genuinely lands inside a larger first frame.
 */
async function readLogHeader(path: string, size: number): Promise<{ header: Record<string, unknown>, headerEnd: number, compression: boolean }> {
  if (size === 0) throw new Error('the log is empty')
  const handle = await open(path, 'r')
  try {
    let want = Math.min(size, HEADER_PROBE_BYTES)
    for (;;) {
      const chunk = Buffer.alloc(want)
      const { bytesRead } = await handle.read(chunk, 0, want, 0)
      const view = chunk.subarray(0, bytesRead)
      const compression = view.length >= 4 && view.readUInt32LE(0) === ZSTD_MAGIC
      try {
        const decoded = decodeHeader(view, compression)
        return { ...decoded, compression }
      } catch (error) {
        // A probe can stop inside the first frame; read more and retry. Any
        // other failure (bad magic, corrupt block, no header record) is real.
        const torn = compression && scanLogFrames(view).frames.length === 0
        if (!torn || bytesRead >= size || bytesRead < want) throw error
        want = Math.min(size, want * 4)
      }
    }
  } finally {
    await handle.close()
  }
}

/**
 * Rewrite only the header of a log and leave every other byte untouched.
 *
 * Complete event frames and a torn final frame are preserved byte for byte:
 * re-encoding them would change committed history, and the old placeholder
 * path inside messages must keep reading exactly as written. The result is
 * proven before it is returned — complete-frame count unchanged, header reads
 * back with the new cwd, every following complete frame byte-identical, torn
 * tail byte-identical.
 */
function rewriteHeader(buffer: Buffer, expectedId: string, to: string, compression: boolean): Buffer {
  if (!compression) return rewritePlainHeader(buffer, expectedId, to)
  const scan = scanLogFrames(buffer)
  if (scan.frames.length === 0) throw new Error('the log holds no complete header frame')
  const first = scan.frames[0]
  const decoded = decodeHeader(buffer.subarray(first.start, first.end), true)
  const header = decoded.header
  if (header.type !== 'session') throw new Error(`first record is not a Session header (type ${String(header.type)})`)
  if (header.id !== expectedId) throw new Error(`header id ${String(header.id)} does not match directory ${expectedId}`)
  if (typeof header.cwd !== 'string' || header.cwd.length === 0) throw new Error('header carries no cwd')
  const rewritten = { ...header, version: header.version ?? SESSION_FORMAT_VERSION, cwd: to }
  const plaintext = Buffer.from(`${JSON.stringify(rewritten)}\n`, 'utf8')
  const head = zstdCompressSync(plaintext, CHECKSUM_OPTIONS)
  const bytes = Buffer.concat([head, buffer.subarray(first.end)])
  const check = scanLogFrames(bytes)
  if (check.frames.length !== scan.frames.length) {
    throw new Error(`complete frame count changed: ${scan.frames.length} → ${check.frames.length}`)
  }
  const back = decodeHeader(bytes.subarray(check.frames[0].start, check.frames[0].end), true).header
  if (back.cwd !== to) throw new Error('rewritten header does not read back with the new cwd')
  if (back.id !== expectedId) throw new Error('rewritten header does not read back with the same id')
  for (let i = 1; i < check.frames.length; i += 1) {
    const before = buffer.subarray(scan.frames[i].start, scan.frames[i].end)
    const after = bytes.subarray(check.frames[i].start, check.frames[i].end)
    if (before.length !== after.length || !before.equals(after)) throw new Error(`frame ${i} changed`)
  }
  if (scan.tornStart !== undefined) {
    if (check.tornStart === undefined) throw new Error('the rewritten log lost its torn tail')
    if (!bytes.subarray(check.tornStart).equals(buffer.subarray(scan.tornStart))) throw new Error('the torn tail changed')
  }
  return bytes
}

/** Rewrite the first line of an uncompressed log, leaving the rest byte for byte. */
function rewritePlainHeader(buffer: Buffer, expectedId: string, to: string): Buffer {
  const cut = buffer.indexOf(10)
  // A log whose header is the whole file (no trailing newline) is still a
  // header DSH reads; treat the missing newline as an empty body rather than
  // failing forever on a session nobody can otherwise repair.
  const headerText = cut < 0 ? buffer : buffer.subarray(0, cut)
  const header = JSON.parse(headerText.toString('utf8')) as Record<string, unknown>
  if (header.type !== 'session') throw new Error(`first record is not a Session header (type ${String(header.type)})`)
  if (header.id !== expectedId) throw new Error(`header id ${String(header.id)} does not match directory ${expectedId}`)
  if (typeof header.cwd !== 'string' || header.cwd.length === 0) throw new Error('header carries no cwd')
  const rewritten = { ...header, version: header.version ?? SESSION_FORMAT_VERSION, cwd: to }
  const body = cut < 0 ? Buffer.alloc(0) : buffer.subarray(cut + 1)
  return Buffer.concat([Buffer.from(`${JSON.stringify(rewritten)}\n`, 'utf8'), body])
}

/** The generation version of a canonical log filename, or undefined. */
function logVersion(name: string): number | undefined {
  const match = LOG_NAME.exec(name)
  if (match === null) return undefined
  if (match[1] === undefined) return 0
  const version = Number(match[1])
  return version === 0 ? undefined : version
}

/** Newest committed generation log in one session directory. */
function newestLog(names: string[]): { name: string, version: number } | undefined {
  let best: { name: string, version: number } | undefined
  for (const name of names) {
    const match = LOG_NAME.exec(name)
    if (match === null) continue
    // A version-zero tag is not canonical; the backend ignores such names.
    if (match[1] !== undefined && Number(match[1]) === 0) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    if (best === undefined || version > best.version) best = { name, version }
  }
  return best
}

/** Outcome of one relocation pass over the session store. */
export interface SessionRelocationSummary {
  /** Sessions whose header and directory now sit at the new root. */
  relocated: Array<{ id: string, from: string, to: string }>
  /** Live session ids left in place on purpose. */
  skippedLive: string[]
  /** Sessions that could not be moved, with the reason each failed. */
  failed: Array<{ id: string, reason: string }>
}

export interface RelocateOptions {
  /** DSH home holding the `sessions` store; defaults to the resolved home. */
  dshHome?: string
  /** Placeholder root the headers still name. */
  oldRoot: string
  /** Placeholder root the headers should name after the move. */
  newRoot: string
  /** Session ids with a live writer; their files are never touched. */
  liveSessionIds?: ReadonlySet<string>
}

/**
 * One relocation pass: move every stored session whose header sits under
 * `oldRoot` to `newRoot`.
 *
 * The session directory is renamed whole — atomic on one filesystem, and it
 * carries the older format generations and the session lock with it — then the
 * header is rewritten at the destination. Every step is idempotent: a run
 * that died after the rename but before the rewrite finds its destination on
 * the next run and finishes there; a run that died after the rewrite finds the
 * destination already correct and only removes the leftover source copy.
 *
 * A destination that belongs to a different session is never overwritten; the
 * clash is reported as a failure so the operator decides. Per-session failures
 * are collected, not thrown: a migration that already switched roots must not
 * be failed by one stuck file.
 */
export async function relocateSessions(options: RelocateOptions): Promise<SessionRelocationSummary> {
  const summary: SessionRelocationSummary = { relocated: [], skippedLive: [], failed: [] }
  if (!zstdAvailable()) {
    summary.failed.push({ id: '*', reason: 'this Node build has no zlib Zstandard API, so session headers cannot be rewritten' })
    return summary
  }
  const sessionsRoot = joinPath(options.dshHome ?? resolveDshHome(), 'sessions')
  let projects: string[]
  try {
    projects = await readdir(sessionsRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summary
    throw error
  }
  const live = options.liveSessionIds ?? new Set<string>()
  // A symlinked root is only `path.resolve`d in the config while DSH stores
  // canonical cwds, so match every spelling (see rootCandidateSpellings).
  const oldRoots = rootCandidateSpellings(options.oldRoot)
  const touchedProjects = new Set<string>()
  for (const project of projects) {
    const projectDir = joinPath(sessionsRoot, project)
    let entries: string[]
    try {
      entries = await readdir(projectDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = joinPath(projectDir, entry)
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      // Remove staging files a crashed run left behind: DSH ignores them but
      // they look like real logs and would accumulate. Only a temp whose owner
      // process is gone is removed — another live process may be mid-move.
      const temps = names.filter(name => /\.relocate-\d+\.tmp$/.test(name))
      for (const name of temps) {
        const pid = Number(/\.relocate-(\d+)\.tmp$/.exec(name)![1])
        if (pid === process.pid || !isProcessAlive(pid)) await rm(joinPath(dir, name), { force: true }).catch(() => undefined)
      }
      names = names.filter(name => !/\.relocate-\d+\.tmp$/.test(name))
      const log = newestLog(names)
      // A directory without a committed generation is not a session; the
      // backend ignores it too.
      if (log === undefined) continue
      const moved = await relocateSession(
        { sessionsRoot, projectDir, dir, entry, logName: log.name, options, oldRoots, live, summary },
      )
      if (moved) touchedProjects.add(projectDir)
    }
  }
  for (const projectDir of touchedProjects) {
    try {
      if ((await readdir(projectDir)).length === 0) await rm(projectDir, { recursive: true, force: false })
    } catch {
      // A project directory that cannot be inspected is left for the operator.
    }
  }
  return summary
}

interface RelocateContext {
  sessionsRoot: string
  projectDir: string
  dir: string
  entry: string
  logName: string
  options: RelocateOptions
  /** Every accepted spelling of `options.oldRoot`. */
  oldRoots: readonly string[]
  live: ReadonlySet<string>
  summary: SessionRelocationSummary
}

/** Relocate one session directory; every failure is recorded on the summary. */
async function relocateSession(context: RelocateContext): Promise<boolean> {
  const { sessionsRoot, projectDir, dir, entry, logName, options, oldRoots, live, summary } = context
  const fail = (id: string, reason: string): false => {
    summary.failed.push({ id, reason })
    return false
  }
  const logPath = joinPath(dir, logName)
  let size: number
  try {
    size = (await stat(logPath)).size
  } catch (error) {
    return fail(entry, `unreadable log: ${text(error)}`)
  }
  let head: { header: Record<string, unknown>, headerEnd: number, compression: boolean }
  try {
    head = await readLogHeader(logPath, size)
  } catch (error) {
    return fail(entry, `unreadable header: ${text(error)}`)
  }
  const header = head.header
  const cwd = header.cwd
  if (header.type !== 'session' || typeof cwd !== 'string' || cwd.length === 0) return false
  if (!sitsUnder(cwd, oldRoots)) return false
  const id = typeof header.id === 'string' ? header.id : ''
  if (id.length === 0) return fail(entry, 'header carries no id')
  if (encodeSegment(id) !== entry) return fail(id, `directory name ${entry} does not match encodeSegment(id) ${encodeSegment(id)}`)
  const to = mapPlaceholderCwd(cwd, oldRoots, options.newRoot)
  const destDir = joinPath(sessionsRoot, projectKey(to), encodeSegment(id))
  // Layout drift guard: the directory this log sits in is named by DSH's own
  // encoder, so it must be either the project key of the header's cwd or — for
  // a run that renamed the directory but died before rewriting the header —
  // the project key of the destination. Anything else means the encoders
  // diverged and any destination computed here would be wrong: stop loudly.
  const here = basename(projectDir)
  const expectedProject = projectKey(cwd)
  if (here !== expectedProject && here !== projectKey(to)) {
    return fail(id, `project directory ${here} matches neither projectKey(cwd) ${expectedProject} nor projectKey(newCwd): the layout encoder drifted`)
  }
  if (live.has(id)) {
    summary.skippedLive.push(id)
    return false
  }
  if (resolvePath(dir) === resolvePath(destDir)) {
    // Renamed by an earlier run that died before the rewrite: finish it here.
    if (!(await rewriteLogAt(destDir, logName, id, to, head.compression, summary))) return false
    summary.relocated.push({ id, from: cwd, to })
    return true
  }
  let destExists = false
  try {
    destExists = (await stat(destDir)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail(id, text(error))
  }
  if (destExists) {
    return reconcileExistingDestination({ ...context, destDir, id, from: cwd, to })
  }
  return moveAndRewrite({ ...context, destDir, id, from: cwd, to, compression: head.compression })
}

/**
 * Move the session directory and rewrite its header, without ever exposing a
 * log that sits in one project directory while its header names another.
 *
 * DSH's `list()` rejects the WHOLE store when any newest log's path disagrees
 * with `projectKey(header.cwd)` (a plain error, not a skippable corruption).
 * So every step that can fail — reading, the size ceiling, the frame scan, and
 * the in-memory rewrite with its self-verification — runs BEFORE the directory
 * is touched; a failure there leaves the session exactly as it was. Only then
 * is the directory renamed and the precomputed bytes promoted with a single
 * atomic rename. If that final rename fails the move is rolled back.
 */
async function moveAndRewrite(context: RelocateContext & { destDir: string, id: string, from: string, to: string, compression: boolean }): Promise<boolean> {
  const { destDir, dir, id, to, from, logName, summary, compression } = context
  const fail = (reason: string): false => {
    summary.failed.push({ id, reason })
    return false
  }
  const sourceLog = joinPath(dir, logName)
  // 1) All fallible work, with the directory still in place. The header probe
  // already proved the log is structurally readable; the full read and the
  // in-memory rewrite are the remaining fallible steps.
  let rewritten: Buffer
  let srcMode: number | undefined
  try {
    const info = await stat(sourceLog)
    if (info.size > MAX_REWRITE_BYTES) throw new Error(`the log is ${info.size} bytes, above the ${MAX_REWRITE_BYTES}-byte rewrite ceiling`)
    srcMode = info.mode & 0o777
    const bytes = await readFile(sourceLog)
    rewritten = rewriteHeader(bytes, id, to, compression)
  } catch (error) {
    return fail(`refusing to move the session: ${text(error)}`)
  }
  // 2) Stage the rewritten bytes next to the log. The dotted suffix is not a
  // committed generation name, so DSH ignores it if this process dies here.
  // Keep the original file's mode: a fresh file would be created world-readable
  // (session logs are 0600) and several users may share the machine.
  const staged = `${logName}.relocate-${process.pid}.tmp`
  try {
    // Create already restricted (0600) and widen to the source mode only after
    // the bytes land, so the file is never world-readable mid-write.
    await writeFile(joinPath(dir, staged), rewritten, { mode: 0o600 })
    if (srcMode !== undefined) await chmod(joinPath(dir, staged), srcMode)
  } catch (error) {
    await rm(joinPath(dir, staged)).catch(() => undefined)
    return fail(`could not stage the rewritten log: ${text(error)}`)
  }
  // 3) Move the whole directory (older generations and the session lock ride
  // along), then 4) promote the staged bytes over the old-header newest log in
  // one atomic rename.
  try {
    await mkdir(dirname(destDir), { recursive: true })
    await rename(dir, destDir)
  } catch (error) {
    await rm(joinPath(dir, staged)).catch(() => undefined)
    return fail(`could not move the session directory: ${text(error)}`)
  }
  try {
    await rename(joinPath(destDir, staged), joinPath(destDir, logName))
  } catch (error) {
    let rolledBack = true
    try {
      await rename(destDir, dir)
      // The staged file moved WITH the directory, so after the rollback it is
      // under `dir` again (not `destDir`).
      await rm(joinPath(dir, staged)).catch(() => undefined)
    } catch {
      rolledBack = false
    }
    return fail(`could not publish the rewritten log${rolledBack ? ' (the move was rolled back)' : ` (ROLLBACK FAILED — the session directory is left at ${destDir} with its header still naming the old root)`}: ${text(error)}`)
  }
  summary.relocated.push({ id, from, to })
  return true
}

/**
 * Finish or refuse when a directory already exists at the destination.
 *
 * The destination is authoritative when it already carries this session with
 * the new cwd (an earlier run completed the rewrite and died before removing
 * its source): the source is a stale copy and is removed. A destination whose
 * header still names the old root was renamed but never rewritten — finish it
 * in place. Anything else is reported instead of guessed at, so a clash never
 * silently overwrites a log.
 */
async function reconcileExistingDestination(context: RelocateContext & { destDir: string, id: string, from: string, to: string }): Promise<boolean> {
  const { destDir, dir, id, from, to, summary } = context
  const fail = (reason: string): false => {
    summary.failed.push({ id, reason })
    return false
  }
  let names: string[]
  try {
    names = await readdir(destDir)
  } catch (error) {
    return fail(`unreadable destination: ${text(error)}`)
  }
  const destLog = newestLog(names)
  if (destLog === undefined) return fail('the destination holds no committed generation to reconcile with')
  // Reconciling across differing generations would rewrite the older one and
  // discard the newer; refuse instead of guessing.
  const sourceVersion = logVersion(context.logName)
  if (sourceVersion === undefined || destLog.version !== sourceVersion) {
    return fail(`the destination holds generation v${destLog.version}, the source v${String(sourceVersion)}; refusing an automatic reconcile across generations`)
  }
  const destPath = joinPath(destDir, destLog.name)
  let destHeader: Record<string, unknown>
  let size: number
  try {
    size = (await stat(destPath)).size
    destHeader = (await readLogHeader(destPath, size)).header
  } catch (error) {
    return fail(`unreadable destination header: ${text(error)}`)
  }
  if (destHeader.id !== id) {
    return fail(`the destination already holds session ${String(destHeader.id)}; refusing to overwrite it`)
  }
  if (destHeader.cwd === to) {
    // Completed by an earlier run; only the stale source remains. Report the
    // move (so the emptied old project directory is cleaned up) but do NOT
    // count it as relocated again: the earlier run already counted it, and the
    // UI would otherwise show one session twice across two runs.
    try {
      await rm(dir, { recursive: true, force: false })
      return true
    } catch (error) {
      return fail(`the destination is already correct, but the stale source could not be removed: ${text(error)}`)
    }
  }
  if (destHeader.cwd === from) {
    // Renamed earlier and the rewrite never ran: finish it in place, then drop
    // the stale source. A stuck source is reported but the session is already
    // correct, so the next run's reconcile branch removes it.
    const compression = destLog.name.endsWith('.zstd')
    if (!(await rewriteLogAt(destDir, destLog.name, id, to, compression, summary))) return false
    try {
      await rm(dir, { recursive: true, force: false })
    } catch (error) {
      summary.failed.push({ id, reason: `the session was repaired at its destination, but the stale source could not be removed: ${text(error)}` })
    }
    summary.relocated.push({ id, from, to })
    return true
  }
  return fail(`the destination header names ${String(destHeader.cwd)}, which is neither the old nor the new root; refusing to touch it`)
}

/**
 * Rewrite the newest log's header inside its directory and prove the result.
 *
 * The file is read whole (bounded by {@link MAX_REWRITE_BYTES}), rewritten in
 * memory, published through a temp file, and read back — the same
 * self-verification before commitment the backend applies to its own writes.
 */
async function rewriteLogAt(
  dir: string,
  logName: string,
  expectedId: string,
  to: string,
  compression: boolean,
  summary: SessionRelocationSummary,
): Promise<boolean> {
  const path = joinPath(dir, logName)
  try {
    const size = (await stat(path)).size
    if (size > MAX_REWRITE_BYTES) throw new Error(`the log is ${size} bytes, above the ${MAX_REWRITE_BYTES}-byte rewrite ceiling`)
    const bytes = await readFile(path)
    const rewritten = rewriteHeader(bytes, expectedId, to, compression)
    await publish(path, rewritten)
    // Read the published log back and prove it: header decodes with the moved
    // identity, complete-frame count and torn-tail state are unchanged.
    const published = await readFile(path)
    const back = (await readLogHeader(path, published.length)).header
    if (back.id !== expectedId) throw new Error(`the published log reads back with id ${String(back.id)}`)
    if (back.cwd !== to) throw new Error(`the published log reads back with cwd ${String(back.cwd)}`)
    if (compression) {
      const before = scanLogFrames(bytes)
      const after = scanLogFrames(published)
      if (after.frames.length !== before.frames.length) throw new Error('the published log lost complete frames')
      if ((after.tornStart === undefined) !== (before.tornStart === undefined)) throw new Error('the published log changed the torn tail state')
    } else {
      // Plaintext: the bytes past the first newline must be unchanged.
      const beforeCut = bytes.indexOf(10)
      const afterCut = published.indexOf(10)
      if (beforeCut < 0 || afterCut < 0 || !published.subarray(afterCut + 1).equals(bytes.subarray(beforeCut + 1))) {
        throw new Error('the published plaintext log changed its event body')
      }
    }
    return true
  } catch (error) {
    summary.failed.push({ id: expectedId, reason: `could not rewrite the header at ${path}: ${text(error)}` })
    return false
  }
}

/** Write bytes through a same-directory temp file, then rename over the target. */
async function publish(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Preserve the mode of the file being replaced; a new temp file would
  // otherwise be world-readable where session logs are 0600.
  let mode: number | undefined
  try {
    mode = (await stat(path)).mode & 0o777
  } catch {
    mode = undefined
  }
  const temp = `${path}.relocate-${process.pid}.tmp`
  await writeFile(temp, bytes, { mode: 0o600 })
  if (mode !== undefined) await chmod(temp, mode)
  await rename(temp, path)
}

/**
 * Whether a stored session log still exists for `id` at `cwd`.
 *
 * Used to decide that a queued membership can never be restored (the session
 * was deleted) without depending on routing: an operator editing the root in
 * the generic settings editor changes routing but not the files, and dropping a
 * pending entry then would lose the only record of a session that still needs
 * its group back.
 */
export async function sessionLogExists(dshHome: string, cwd: string, id: string): Promise<boolean> {
  const segment = encodeSegment(id)
  const sessionsRoot = joinPath(dshHome, 'sessions')
  // Fast path: the spelling the path was recorded with.
  try {
    if (newestLog(await readdir(joinPath(sessionsRoot, projectKey(cwd), segment))) !== undefined) return true
  } catch {
    // Fall through to the full search.
  }
  // A symlinked root makes the recorded path's `projectKey` name a different
  // folder than the one the log actually lives in, and `realpath` cannot
  // recover the lexical spelling. Session ids are unique, so look the segment
  // up across every project directory instead of trusting the path.
  let projects: string[]
  try {
    projects = await readdir(sessionsRoot)
  } catch {
    return false
  }
  for (const project of projects) {
    try {
      if (newestLog(await readdir(joinPath(sessionsRoot, project, segment))) !== undefined) return true
    } catch {
      // Not in this project directory; keep looking.
    }
  }
  return false
}

/** Whether a pid still exists on this host (used to decide a temp file is orphaned). */
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
