/**
 * Shared low-level remote file mutation helpers.
 *
 * The remote filesystem backend needs the same created-path resolution,
 * remote writable roots, and atomic commit script as the other remote file
 * surfaces. Keeping one copy here prevents the fs layer and the ops layer from
 * drifting in symlink handling or sandbox arguments.
 */
import { createHash, randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { FsError, type FsVersion, type FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { SandboxUnavailableError, type SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { HostConfig } from './config.ts'
import { composeCreatedPath } from './contain.ts'
import {
  atomicWriteScript,
  bwrapFileProfileArgs,
  fileWritableRoots,
  sandboxDenied,
  seatbeltBashCommand,
  type RemoteFileRoots,
} from './profile.ts'
import { shJoin } from './shell-quote.ts'
import { isSftpMissing, type ExecResult, type SshPool, type SecretMaterial } from './ssh-pool.ts'
import type { RunnerStatus } from './execute.ts'

/** Resolve a possibly-not-yet-existing remote path through its nearest real ancestor. */
export async function resolveCreatedPath(
  pool: SshPool,
  host: HostConfig,
  secret: SecretMaterial,
  lexicalPath: string,
): Promise<string> {
  let cursor = posix.normalize(lexicalPath)
  const missing: string[] = []
  while (true) {
    try {
      const real = await pool.sftpRealpath(host, secret, cursor)
      return composeCreatedPath(real, missing)
    } catch (error) {
      if (!isSftpMissing(error)) {
        // A transport failure must not be guessed into a lexical path.
        throw error
      }
      if (cursor === '/') return composeCreatedPath('/', missing)
      missing.unshift(posix.basename(cursor))
      const parent = posix.dirname(cursor)
      if (parent === cursor) return composeCreatedPath(cursor, missing)
      cursor = parent
    }
  }
}

/**
 * Structured remote version evidence. `base` always comes from SFTP; `strong`
 * is high-resolution stat output when the remote host supports it; `hash` is a
 * bounded content digest used when stat has no nanosecond precision. Keeping
 * the components separate lets callers compare like with like instead of
 * comparing unrelated token strings.
 */
export interface RemoteVersion {
  readonly base: string
  readonly strong?: string
  readonly hash?: string
  readonly generation?: number
}

/** Encode a version descriptor as the opaque `FsVersion` string. */
export function remoteVersionToken(version: RemoteVersion): FsVersion {
  return `v1|${version.base}|${version.strong ?? ''}|${version.hash ?? ''}|${version.generation ?? ''}` as FsVersion
}

/** Parse the token produced by {@link remoteVersionToken}; old/foreign tokens return undefined. */
export function parseRemoteVersion(value: FsVersion | string): RemoteVersion | undefined {
  const parts = String(value).split('|')
  if (parts.length !== 5 || parts[0] !== 'v1') return undefined
  const base = parts[1] ?? ''
  if (base.length === 0) return undefined
  const generation = parts[4] === '' ? undefined : Number(parts[4])
  return {
    base,
    ...(parts[2] === '' ? {} : { strong: parts[2] }),
    ...(parts[3] === '' ? {} : { hash: parts[3] }),
    ...(generation !== undefined && Number.isSafeInteger(generation) ? { generation } : {}),
  }
}

/** Version evidence collected from one remote file. */
export interface RemoteVersionEvidence {
  /** High-resolution stat output (device/inode/size/nanosecond mtime). */
  readonly strong?: string
  /** Complete-content digest used when the host has no nanosecond stat. */
  readonly hash?: string
}

export interface RemoteVersionProbeOptions {
  /** Allow a complete-content SHA-256 fallback when stat has no nanosecond precision. */
  readonly hash?: boolean
  /** Upper bound for the hash fallback; oversize files stay unversioned and fail closed. */
  readonly maxHashBytes?: number
}

const VERSION_HASH_MAX_BYTES = 32 * 1024 * 1024

/**
 * Collect remote version evidence.
 *
 * GNU/Linux `stat -c` provides nanosecond mtime. BSD `stat -f` may only provide
 * seconds; that is not strong evidence. Callers that need a guarded write must
 * either get strong evidence or request a complete-content hash. The hash reads
 * the whole file through a signal-aware iterator; a partial prefix is never
 * accepted as a version because that would silently weaken the stale guard.
 */
export async function remoteVersionEvidence(
  pool: SshPool,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  signal?: AbortSignal,
  options: RemoteVersionProbeOptions = {},
): Promise<RemoteVersionEvidence> {
  if (typeof pool.exec === 'function') {
    const quoted = shJoin([remotePath])
    const command = `stat -c '%d:%i:%s:%y' -- ${quoted} 2>/dev/null || stat -f '%d:%i:%z:%m' ${quoted} 2>/dev/null`
    try {
      const result = await pool.exec(host, secret, command, 10_000, signal)
      if (result.code === 0) {
        const line = result.stdout.trim().split('\n')[0]?.trim() ?? ''
        // Seconds-only output is not strong: no fractional mtime.
        if (line.length > 0 && /\d+\.\d+/.test(line)) return { strong: line }
      }
    } catch (error) {
      if (signal?.aborted === true) throw error
      // Fall through to the hash only when the caller explicitly asked for it.
    }
  }
  if (options.hash !== true) return {}
  const limit = options.maxHashBytes ?? VERSION_HASH_MAX_BYTES
  const digest = createHash('sha256')
  let total = 0
  try {
    for await (const chunk of pool.sftpReadChunks(host, secret, remotePath, signal)) {
      if (signal?.aborted === true) throw new Error('aborted')
      total += chunk.length
      if (total > limit) return {}
      digest.update(chunk)
    }
    return { hash: digest.digest('hex') }
  } catch (error) {
    if (signal?.aborted === true) throw error
    return {}
  }
}

/** Canonical remote roots for the file sandbox. */
export async function remoteRoots(
  status: RunnerStatus,
  workspace: string,
  pool: SshPool,
  host: HostConfig,
  secret: SecretMaterial,
  strict = false,
): Promise<RemoteFileRoots> {
  let workspaceRoot = posix.normalize(workspace)
  try {
    workspaceRoot = await pool.sftpRealpath(host, secret, workspace)
  } catch (error) {
    if (strict && !isSftpMissing(error)) throw error
    // A missing workspace stays lexical; fileWriteAllowed still derives its
    // roots from this value and the remote sandbox rejects the missing bind.
  }
  return { workspaceRoot, tmp: status.roots.tmp, userTmp: status.roots.userTmp }
}

function fileCommand(status: RunnerStatus, mode: SandboxMode, roots: RemoteFileRoots, script: string): string {
  if (status.sandboxTool === 'bwrap') {
    const profile = bwrapFileProfileArgs(mode, roots) ?? []
    return shJoin(['bwrap', ...profile, '--chdir', roots.workspaceRoot, '--', 'bash', '-c', script])
  }
  const writable = mode === 'workspace-write' ? fileWritableRoots(mode, roots) : []
  return seatbeltBashCommand(mode, writable, roots.workspaceRoot, script)
}

/**
 * Build the remote-side check for an intent. The check runs while the target
 * lock is held, immediately before the temp file is renamed into place.
 */
function writeGuardScript(target: string, intent: FsWriteIntent | undefined): string {
  if (intent === undefined) return ''
  const quoted = shJoin([target])
  if (intent.kind === 'createIfAbsent') {
    return `if [ -e ${quoted} ] || [ -L ${quoted} ]; then echo 'remote target already exists' >&2; exit 23; fi`
  }
  const version = parseRemoteVersion(intent.version)
  if (version?.strong !== undefined) {
    const expected = shJoin([version.strong])
    return `actual=$(stat -c '%d:%i:%s:%y' -- ${quoted} 2>/dev/null || stat -f '%d:%i:%z:%m' ${quoted} 2>/dev/null || true); if [ "$actual" != ${expected} ]; then echo 'remote file version changed' >&2; exit 24; fi`
  }
  if (version?.hash !== undefined) {
    const expected = shJoin([version.hash])
    return `actual=$( (sha256sum ${quoted} 2>/dev/null || shasum -a 256 ${quoted} 2>/dev/null) | awk '{print $1}' ); if [ "$actual" != ${expected} ]; then echo 'remote file version changed' >&2; exit 24; fi`
  }
  return `echo 'remote write requires strong or hash version evidence' >&2; exit 25`
}

/**
 * A cooperative lock shared by remote writers.
 *
 * The lock lives in the probed temp root when possible, not in the target
 * directory: a persisted lock file would otherwise show up in the remote file
 * tree. The target path is hashed so unrelated files do not serialize each
 * other, and the same path on the same host maps to the same lock.
 */
function lockScript(target: string, lockRoot: string): string {
  const digest = createHash('sha256').update(target).digest('hex').slice(0, 32)
  const lock = posix.join(lockRoot, `.dsh-permission-remote-${digest}.lock`)
  const lockQuoted = shJoin([lock])
  const lockDirQuoted = shJoin([`${lock}.d`])
  return `if command -v flock >/dev/null 2>&1; then exec 9>${lockQuoted}; flock -x 9; else count=0; while ! mkdir ${lockDirQuoted} 2>/dev/null; do count=$((count + 1)); if [ "$count" -gt 200 ]; then echo 'remote write lock timeout' >&2; exit 75; fi; sleep 0.05; done; trap 'rmdir ${lockDirQuoted} 2>/dev/null || true' EXIT; fi`
}

/**
 * Map a failed remote commit command to the typed filesystem error the local
 * backend would raise.
 *
 * Both `commitRemoteText` and `commitRemoteDelete` run under the same guard
 * script and the same sandbox wrapper, so their exit codes mean the same
 * thing. Keeping one mapper here stops the two call sites from drifting when a
 * new code is added. Codes 23/26/27 are only emitted by one of them, and an
 * unused branch is harmless for the other.
 */
function mapRemoteCommitFailure(result: ExecResult, mode: SandboxMode, action: 'write' | 'delete'): never {
  const stderr = result.stderr.trim()
  if (sandboxDenied(result.code, result.stderr)) {
    throw new FsError(`[sandbox: ${mode}] remote ${action} denied: ${stderr || 'sandbox denied'}`, 'FS_SANDBOX_DENIED')
  }
  // Distinct exit codes let a race that happens after the local pre-check
  // surface as the same typed error as the equivalent local backend.
  if (result.code === 23 || /remote target already exists/i.test(stderr)) {
    throw new FsError(stderr || 'remote target already exists', 'FS_NOT_OBSERVED')
  }
  if (result.code === 24 || /remote file version changed/i.test(stderr)) {
    throw new FsError(stderr || 'remote file version changed', 'FS_STALE_VERSION')
  }
  if (result.code === 25 || /requires strong or hash version evidence/i.test(stderr)) {
    throw new FsError(stderr || `remote ${action} requires strong or hash version evidence`, 'FS_IO_ERROR')
  }
  // A vanished delete target is an error, not a silent success (no `rm -f`).
  if (result.code === 26 || /disappeared or is not a regular file/i.test(stderr)) {
    throw new FsError(stderr || 'remote delete target disappeared', 'FS_IO_ERROR')
  }
  if (result.code === 27 || /is a directory/i.test(stderr)) {
    throw new FsError(stderr || 'remote delete target is a directory', 'FS_NOT_REGULAR_FILE')
  }
  if (/permission denied/i.test(stderr)) {
    throw new FsError(stderr || `remote ${action} permission denied`, 'FS_PERMISSION_DENIED')
  }
  throw new Error(stderr || `remote ${action} failed`)
}

/** Atomically write UTF-8 content through a temp file in the target directory. */
export async function commitRemoteText(
  pool: SshPool,
  host: HostConfig,
  secret: SecretMaterial,
  status: RunnerStatus,
  mode: SandboxMode,
  roots: RemoteFileRoots,
  target: string,
  content: string,
  signal?: AbortSignal,
  fileMode?: number,
  intent?: FsWriteIntent,
): Promise<void> {
  if (signal?.aborted === true) throw new FsError('aborted', 'FS_ABORTED')
  if (mode !== 'danger-full-access' && !status.sandbox.available) {
    throw new SandboxUnavailableError(mode, 'remote sandbox probe failed')
  }
  const directory = posix.dirname(target)
  const temp = posix.join(directory, `.dsh-permission-remote-${randomBytes(8).toString('hex')}`)
  const atomic = atomicWriteScript(directory, temp, target, fileMode, { noClobber: intent?.kind === 'createIfAbsent' })
  const lockRoot = status.roots.userTmp || status.roots.tmp || directory
  const script = `set -e\nmkdir -p ${shJoin([directory])}\n${lockScript(target, lockRoot)}\n${writeGuardScript(target, intent)}\n${atomic}`
  const wrapped = mode === 'danger-full-access'
    ? script
    : fileCommand(status, mode, roots, script)
  const result = await pool.exec(host, secret, wrapped, 20_000, signal, content)
  if (result.code !== 0) mapRemoteCommitFailure(result, mode, 'write')
}

/**
 * Remove one remote UTF-8 file without following a final symlink.
 *
 * `rm` (never `rm -f`) is deliberate: a target that disappeared between the
 * lstat pre-check and this command must surface as FS_IO_ERROR, exactly like
 * the local backend's `removeFile`. The type check, the version guard and the
 * removal all run under one cooperative lock, so a concurrent writer cannot
 * slip a different file in between them. Delete uses the same sandbox fence as
 * a write, so it obeys the session's Permissions mode and workspace roots.
 */
export async function commitRemoteDelete(
  pool: SshPool,
  host: HostConfig,
  secret: SecretMaterial,
  status: RunnerStatus,
  mode: SandboxMode,
  roots: RemoteFileRoots,
  target: string,
  signal?: AbortSignal,
  expected?: { version: FsVersion },
): Promise<void> {
  if (signal?.aborted === true) throw new FsError('aborted', 'FS_ABORTED')
  if (mode !== 'danger-full-access' && !status.sandbox.available) {
    throw new SandboxUnavailableError(mode, 'remote sandbox probe failed')
  }
  const quoted = shJoin([target])
  const intent: FsWriteIntent | undefined = expected === undefined
    ? undefined
    : { kind: 'replaceIfVersion', version: expected.version }
  const lockRoot = status.roots.userTmp || status.roots.tmp || posix.dirname(target)
  const script = [
    'set -e',
    lockScript(target, lockRoot),
    writeGuardScript(target, intent),
    `if [ -d ${quoted} ]; then echo 'remote delete target is a directory' >&2; exit 27; fi`,
    `if [ -L ${quoted} ] || [ ! -f ${quoted} ]; then echo 'remote delete target disappeared or is not a regular file' >&2; exit 26; fi`,
    `rm -- ${quoted}`,
  ].filter(line => line.length > 0).join('\n')
  const wrapped = mode === 'danger-full-access'
    ? script
    : fileCommand(status, mode, roots, script)
  const result = await pool.exec(host, secret, wrapped, 20_000, signal)
  if (result.code !== 0) mapRemoteCommitFailure(result, mode, 'delete')
}
