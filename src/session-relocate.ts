import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join as joinPath, resolve as resolvePath, sep } from 'node:path'
import { constants as zconst, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * Relocate stored sessions after a remote-root migration.
 *
 * `Core.changeRemoteRoot` copies the placeholder tree and re-registers every
 * workspace at the new root, but each Session's header keeps naming the old
 * root. DSH derives a Session's storage location from that `cwd`
 * (`<sessions>/<projectKey(cwd)>/<id>/`), so every older Session would end up
 * in a directory its own header contradicts, and the workspace service would
 * filter it from membership — the sidebar shows it under "ungrouped" and
 * opening it fails with "header id and cwd identify" corruption.
 *
 * The repair is the one DSH itself would have to do: rewrite only the header
 * frame (or first line) so the `cwd` names the new placeholder, keep every
 * event frame byte for byte (history must keep reading exactly as written),
 * move the directory to the project key the new `cwd` implies, and let the
 * caller re-attach the id to the workspace registered at the new path.
 *
 * The layout mirrors `@deepseek-ai/dsh-session-persistence-jsonl`; the
 * persistence service exposes no path or rename operation, so the file surgery
 * happens here. Sessions that are currently live are skipped — their writer
 * owns the file — and keep working through the superseded-root routing until
 * they are closed and the operator saves the root again.
 */

const ZSTD_MAGIC = 0xfd2fb528
const SESSION_FORMAT_VERSION = 4
const CHECKSUM_OPTIONS = { params: { [zconst.ZSTD_c_checksumFlag]: 1 } }
const LOG_NAME = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/

/** Whether this Node build can rewrite a Zstandard header frame. */
export function zstdAvailable(): boolean {
  return typeof zstdCompressSync === 'function' && typeof zstdDecompressSync === 'function'
}

/**
 * Encode one Session id as a single safe path segment.
 *
 * Kept verbatim against `@deepseek-ai/dsh-session-persistence-jsonl`; a
 * divergence would move a log to a directory DSH does not look in.
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

/** Whether `cwd` is the root itself or a path inside it, on either separator. */
function sitsUnder(cwd: string, root: string): boolean {
  const trimmed = root.replace(/[\\/]+$/, '')
  if (cwd === trimmed) return true
  if (!cwd.startsWith(trimmed)) return false
  const next = cwd[trimmed.length] ?? ''
  return next === '/' || next === '\\'
}

/** The session's placeholder path moved from `oldRoot` to `newRoot`. */
export function mapPlaceholderCwd(cwd: string, oldRoot: string, newRoot: string): string {
  const trimmedOld = oldRoot.replace(/[\\/]+$/, '')
  const rest = cwd.slice(trimmedOld.length).replace(/^[\\/]+/, '')
  const trimmedNew = newRoot.replace(/[\\/]+$/, '')
  return rest.length === 0 ? trimmedNew : `${trimmedNew}/${rest}`
}

/** Split a log into complete Zstandard frames without decompressing them. */
function scanFrames(buffer: Buffer): Array<{ start: number, end: number }> {
  const frames: Array<{ start: number, end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) throw new Error(`torn frame header at byte ${offset}`)
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) throw new Error(`torn frame header at byte ${start}`)
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
    if (buffer.length - offset < remainingHeaderBytes) throw new Error(`torn frame header at byte ${start}`)
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) throw new Error(`torn block header at byte ${offset}`)
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
      if (buffer.length - offset < 4) throw new Error(`torn frame checksum at byte ${offset}`)
      offset += 4
    }
    if (offset > buffer.length) throw new Error(`frame at byte ${start} runs past the end of the file`)
    frames.push({ start, end: offset })
  }
  return frames
}

/** Parse a decompressed frame into its non-empty JSONL records. */
function records(plaintext: Buffer): unknown[] {
  const out: unknown[] = []
  for (const line of plaintext.toString('utf8').split('\n')) {
    if (line.trim().length === 0) continue
    out.push(JSON.parse(line))
  }
  return out
}

/**
 * Rewrite only the header of a log and leave every other frame untouched.
 *
 * The event frames are opaque on purpose: they are committed history, and the
 * old placeholder path inside messages must keep reading exactly as written.
 * The result is proven before it is returned — frame count unchanged, header
 * reads back with the new cwd, every following frame byte-identical.
 */
function rewriteHeader(buffer: Buffer, expectedId: string, to: string): Buffer {
  const frames = scanFrames(buffer)
  if (frames.length === 0) throw new Error('log has no frames')
  const headerText = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end))
  if (headerText.length === 0 || headerText.indexOf(10) !== headerText.length - 1) {
    throw new Error('first frame is not exactly one header line')
  }
  const header = JSON.parse(headerText.subarray(0, -1).toString('utf8')) as Record<string, unknown>
  if (header.type !== 'session') throw new Error(`first record is not a Session header (type ${String(header.type)})`)
  if (header.id !== expectedId) throw new Error(`header id ${String(header.id)} does not match directory ${expectedId}`)
  if (typeof header.cwd !== 'string' || header.cwd.length === 0) throw new Error('header carries no cwd')
  const rewritten = { ...header, version: header.version ?? SESSION_FORMAT_VERSION, cwd: to }
  const frame = zstdCompressSync(Buffer.from(`${JSON.stringify(rewritten)}\n`, 'utf8'), CHECKSUM_OPTIONS)
  const bytes = Buffer.concat([frame, buffer.subarray(frames[0].end)])
  const check = scanFrames(bytes)
  if (check.length !== frames.length) throw new Error(`frame count changed: ${frames.length} → ${check.length}`)
  const back = JSON.parse(zstdDecompressSync(bytes.subarray(check[0].start, check[0].end)).subarray(0, -1).toString('utf8')) as Record<string, unknown>
  if (back.cwd !== to) throw new Error('rewritten header does not read back with the new cwd')
  for (let i = 1; i < frames.length; i += 1) {
    const before = buffer.subarray(frames[i].start, frames[i].end)
    const after = bytes.subarray(check[i].start, check[i].end)
    if (before.length !== after.length || !before.equals(after)) throw new Error(`frame ${i} changed`)
  }
  return bytes
}

/** The same repair for an uncompressed log. */
function rewritePlainHeader(buffer: Buffer, expectedId: string, to: string): Buffer {
  const text = buffer.toString('utf8')
  const cut = text.indexOf('\n')
  if (cut < 0) throw new Error('log has no newline after the header')
  const header = JSON.parse(text.slice(0, cut)) as Record<string, unknown>
  if (header.type !== 'session') throw new Error('first record is not a Session header')
  if (header.id !== expectedId) throw new Error(`header id ${String(header.id)} does not match directory ${expectedId}`)
  return Buffer.from(`${JSON.stringify({ ...header, cwd: to })}\n${text.slice(cut + 1)}`, 'utf8')
}

/** Newest generation log in one session directory, as `name` plus version. */
function newestLog(dir: string, names: string[]): { name: string, version: number } | undefined {
  let best: { name: string, version: number } | undefined
  for (const name of names) {
    const match = LOG_NAME.exec(name)
    if (match === null) continue
    const version = Number(match[1])
    if (best === undefined || version > best.version) best = { name, version }
  }
  return best
}

/** Read a session header without assuming a compression. */
function readHeader(bytes: Buffer, name: string): Record<string, unknown> {
  if (name.endsWith('.zstd')) {
    const frames = scanFrames(bytes)
    return JSON.parse(zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end)).subarray(0, -1).toString('utf8')) as Record<string, unknown>
  }
  return JSON.parse(bytes.toString('utf8').split('\n')[0]) as Record<string, unknown>
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
 * Move every stored session whose header sits under `oldRoot` to `newRoot`.
 *
 * Per-session failures are collected, not thrown: a migration that already
 * switched roots must not be failed by one stuck file, and the remaining rows
 * are reported so the operator hears about them. An old project directory is
 * removed only once it holds nothing, so a directory with foreign entries is
 * left alone.
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
  const touchedOldProjects = new Set<string>()
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
      const log = newestLog(dir, names)
      if (log === undefined) continue
      let bytes: Buffer
      let header: Record<string, unknown>
      try {
        bytes = await readFile(joinPath(dir, log.name))
        header = readHeader(bytes, log.name)
      } catch (error) {
        summary.failed.push({ id: entry, reason: `unreadable log: ${text(error)}` })
        continue
      }
      const cwd = header.cwd
      if (typeof cwd !== 'string' || !sitsUnder(cwd, options.oldRoot)) continue
      const id = typeof header.id === 'string' ? header.id : entry
      if (live.has(id)) {
        summary.skippedLive.push(id)
        continue
      }
      const to = mapPlaceholderCwd(cwd, options.oldRoot, options.newRoot)
      const targetDir = joinPath(sessionsRoot, projectKey(to), encodeSegment(id))
      try {
        if (resolvePath(dir) === resolvePath(targetDir)) continue
        if (await exists(joinPath(targetDir, log.name))) {
          throw new Error(`the destination already holds a log for ${id}`)
        }
        const rewritten = log.name.endsWith('.zstd')
          ? rewriteHeader(bytes, id, to)
          : rewritePlainHeader(bytes, id, to)
        await publish(joinPath(targetDir, log.name), rewritten)
        // Prove the move before the old copy disappears.
        const check = await readFile(joinPath(targetDir, log.name))
        const checkHeader = readHeader(check, log.name)
        if (checkHeader.id !== id || checkHeader.cwd !== to) throw new Error('the new log does not read back with the moved identity')
        if (log.name.endsWith('.zstd') && scanFrames(check).length !== scanFrames(bytes).length) throw new Error('the new log lost frames')
        await rm(dir, { recursive: true, force: false })
        touchedOldProjects.add(projectDir)
        summary.relocated.push({ id, from: cwd, to })
      } catch (error) {
        summary.failed.push({ id, reason: text(error) })
      }
    }
  }
  for (const projectDir of touchedOldProjects) {
    try {
      if ((await readdir(projectDir)).length === 0) await rm(projectDir, { recursive: true, force: false })
    } catch {
      // A project directory that cannot be inspected is left for the operator.
    }
  }
  return summary
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Write bytes through a same-directory temp file, then rename over the target. */
async function publish(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.relocate-${process.pid}.tmp`
  await writeFile(temp, bytes)
  await rename(temp, path)
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Records of one frame, exported for tests that assert on event history. */
export function frameRecords(plaintext: Buffer): unknown[] {
  return records(plaintext)
}

/** Frame scanner exported for tests that need byte ranges. */
export function scanLogFrames(buffer: Buffer): Array<{ start: number, end: number }> {
  return scanFrames(buffer)
}

export { sep }
