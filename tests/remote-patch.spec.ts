/**
 * Remote implementations of the DSH 0.2.2 patch mutations.
 *
 * These tests exercise `ctx.fs` exactly as `apply_patch` does: add/update go
 * through writeText/patchText, delete through deleteFile and move through
 * moveFile. A fake SFTP pool records the remote shell scripts instead of
 * dialing a host, so the sandbox fence, `rm` (not `rm -f`) and version guards
 * are all observable.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { posix } from 'node:path'
import test from 'node:test'
import { FsError, FsTargetKey, type FsDeleteOutcome, type FsEditOutcome, type FsMoveOutcome, type FsTarget, type FsVersion, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { HostConfig } from '../src/config.ts'
import type { PatchHunk } from '../src/patch-hunks.ts'
import { installRemoteFs, type RemoteAccess } from '../src/remote-fs.ts'
import { remoteVersionToken, parseRemoteVersion } from '../src/remote-write.ts'
import { clearSupersededRoots, encodeRemotePath, mapRemoteToLocal, setRemoteRootOverride } from '../src/router.ts'
import { SshFailure, type ExecResult, type SftpAttrs } from '../src/ssh-pool.ts'

const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-patch-'))
process.env.DSH_SSH_REMOTE_ROOT = root
setRemoteRootOverride(null)
clearSupersededRoots()

const REMOTE = '/home/me/project'
const POLICY = {
  mode: 'workspace-write',
  workspaceRoot: placeholder(),
  sessionId: 'session-1',
} as unknown as SandboxExecutionPolicy

function placeholder(...extra: string[]): string {
  return path.join(root, 'lo', encodeRemotePath(REMOTE), ...extra)
}

function result(code: number, stdout = '', stderr = ''): ExecResult {
  return { code, signal: null, stdout, stderr, timedOut: false, stdoutTruncated: false, stderrTruncated: false }
}

const STRONG_STAT = '65024:12345:9:2026-01-01 00:00:00.123456789 +0000'

/** One hunk that replaces the line `beta` with `BETA`. */
const HUNKS: readonly PatchHunk[] = [
  { lineNumber: 1, oldLines: ['beta'], newLines: ['BETA'], isEndOfFile: false },
]

interface HarnessOptions {
  /** Model a provider that does not implement the optional mutation methods. */
  withoutOptionalMutations?: boolean
  /** Override the outcome of one remote command (used for failure injection). */
  execResult?: (command: string) => ExecResult
  /** Paths the fake remote should report as existing after a successful write. */
  publishPaths?: readonly string[]
  /** Apply `publishPaths` even when the command exits non-zero (simulates mv-then-chmod failure). */
  mutateOnFailure?: boolean
}

interface Harness {
  fs: RemoteSurface
  backend: Backend
  files: Map<string, string>
  attrs: Map<string, SftpAttrs | undefined>
  commands: string[]
  writes: Array<{ command: string, stdin?: string }>
  setFile(remotePath: string, content: string, attrs?: SftpAttrs): void
  setSymlink(linkPath: string, targetPath: string, linkMode?: number): void
  remove(): void
}

interface RemoteSurface {
  resolve(requested: string, opts?: { cwd?: string, signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<{ version: FsVersion, type: string, size: number } | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  writeText(target: FsTarget, content: string, expected?: unknown, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
  patchText(target: FsTarget, hunks: readonly PatchHunk[], expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsEditOutcome>
  deleteFile(target: FsTarget, expected?: { version: FsVersion }, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsDeleteOutcome>
  moveFile(source: FsTarget, destination: FsTarget, options: { hunks?: readonly PatchHunk[], expectedSource?: { version: FsVersion }, expectedDestination?: unknown }, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<FsMoveOutcome>
  contains(parent: FsTarget, child: FsTarget): boolean
}

class Backend {
  readonly sandboxMode = 'workspace-write'
  patches: string[] = []
  deletes: string[] = []
  moves: string[] = []
  writes: string[] = []
  processPath(target: FsTarget): string { return String(target.targetKey) }
  async resolve(requested: string): Promise<FsTarget> { return { targetKey: FsTargetKey(requested), displayPath: requested } }
  async lstat(): Promise<undefined> { return undefined }
  async stat(): Promise<undefined> { return undefined }
  async listDir(): Promise<[]> { return [] }
  async readText(): Promise<string> { return '' }
  async streamText(): Promise<AsyncIterable<string>> { return (async function* () {})() }
  async readBytes(): Promise<Uint8Array> { return new Uint8Array() }
  async readByteRange(): Promise<Uint8Array> { return new Uint8Array() }
  async writeText(target?: FsTarget): Promise<unknown> { this.writes.push(String(target?.targetKey)); return 'local-write' }
  async editText(): Promise<unknown> { return 'local-edit' }
  async patchText(target?: FsTarget): Promise<unknown> { this.patches.push(String(target?.targetKey)); return 'local-patch' }
  async deleteFile(target?: FsTarget): Promise<unknown> { this.deletes.push(String(target?.targetKey)); return 'local-delete' }
  async moveFile(source?: FsTarget, destination?: FsTarget): Promise<unknown> {
    this.moves.push(`${String(source?.targetKey)}->${String(destination?.targetKey)}`)
    return 'local-move'
  }
  contains(): boolean { return true }
  async watch(): Promise<() => Promise<void>> { return async () => undefined }
}

function createHarness(options: HarnessOptions = {}): Harness {
  const backend = new Backend()
  if (options.withoutOptionalMutations === true) {
    for (const key of ['patchText', 'deleteFile', 'moveFile'] as const) {
      Reflect.deleteProperty(backend, key)
      Reflect.deleteProperty(Object.getPrototypeOf(backend) as object, key)
    }
  }
  const files = new Map<string, string>()
  const attrs = new Map<string, SftpAttrs | undefined>()
  const symlinks = new Map<string, { target: string, mode: number }>()
  const published = new Set<string>()
  const commands: string[] = []
  const writes: Array<{ command: string, stdin?: string }> = []
  const pool = {
    async sftpRealpath(_host: HostConfig, _secret: unknown, remotePath: string): Promise<string> {
      let cursor = posix.normalize(remotePath)
      // Resolve a final-component link the way `realpath` does.
      for (let depth = 0; depth < 8; depth += 1) {
        const next = symlinks.get(cursor)
        if (next === undefined) break
        cursor = posix.normalize(next.target)
      }
      return cursor
    },
    async sftpAttrs(_host: HostConfig, _secret: unknown, remotePath: string, follow: boolean): Promise<SftpAttrs | undefined> {
      const key = posix.normalize(remotePath)
      const link = symlinks.get(key)
      if (link !== undefined) {
        if (!follow) return { type: 'symlink', size: 0, mtime: 7, mode: link.mode }
        return pool.sftpAttrs(_host, _secret, link.target, true)
      }
      if (attrs.has(key)) return attrs.get(key)
      const content = files.get(key)
      if (content === undefined && !published.has(key)) return undefined
      return { type: 'file', size: Buffer.byteLength(content ?? ''), mtime: 7, mode: 0o644 }
    },
    async sftpReadLink(): Promise<string> { throw new SshFailure('Failure', 'sftp-readlink') },
    async sftpProbeDir(): Promise<void> { throw new SshFailure('Failure', 'sftp-probedir') },
    async sftpReadDir(): Promise<[]> { return [] },
    async sftpRead(_host: HostConfig, _secret: unknown, remotePath: string): Promise<Buffer> {
      const content = files.get(posix.normalize(remotePath))
      if (content === undefined) throw new SshFailure('Failure', 'sftp-read')
      return Buffer.from(content)
    },
    async sftpReadAt(): Promise<Buffer> { return Buffer.alloc(0) },
    async *sftpReadChunks(_host: HostConfig, _secret: unknown, remotePath: string): AsyncGenerator<Buffer> {
      const content = files.get(posix.normalize(remotePath))
      if (content !== undefined) yield Buffer.from(content)
    },
    async exec(_host: HostConfig, _secret: unknown, command: string, _timeout: number, _signal?: AbortSignal, stdin?: string | Buffer): Promise<ExecResult> {
      commands.push(command)
      writes.push({ command, stdin: typeof stdin === 'string' ? stdin : undefined })
      if (command.startsWith('stat ')) return result(0, STRONG_STAT)
      const outcome = options.execResult?.(command) ?? result(0)
      // Emulate the atomic publication so the post-write stat sees the file.
      // A delete script carries `rm --` and publishes nothing. `mutateOnFailure`
      // models a command that changed the file and then failed.
      if (typeof stdin === 'string' && !command.includes('rm -- ') && (outcome.code === 0 || options.mutateOnFailure === true)) {
        for (const path of options.publishPaths ?? []) {
          const key = posix.normalize(path)
          files.set(key, stdin)
          published.add(key)
        }
      }
      return outcome
    },
  }
  const access: RemoteAccess = {
    requireHost: () => ({ id: 'lo' } as HostConfig),
    async secret() { return {} },
    allowsRemoteSession: () => true,
    workspaceRootsOf: () => [REMOTE],
    async statusOf() {
      return {
        sandbox: { available: true, reason: 'ok' },
        sandboxTool: 'bwrap',
        roots: { workspaceRoot: REMOTE, tmp: '/tmp', userTmp: '/tmp' },
        home: '/home/dev',
        os: 'linux', ripgrep: 'system', ripgrepPath: '/usr/bin/rg', install: null,
      }
    },
    pool,
  }
  const ctx = {
    get(name: string) {
      if (name === 'fs') return backend
      throw new Error(name)
    },
    logger: { warn() {} },
  }
  const remove = installRemoteFs(ctx, access)
  assert.equal(typeof remove, 'function')
  return {
    fs: backend as unknown as RemoteSurface,
    backend,
    files,
    attrs,
    commands,
    writes,
    setFile(remotePath: string, content: string, attrsOverride?: SftpAttrs) {
      const key = posix.normalize(remotePath)
      files.set(key, content)
      if (attrsOverride !== undefined) attrs.set(key, attrsOverride)
      else attrs.delete(key)
    },
    setSymlink(linkPath: string, targetPath: string, linkMode = 0o120777) {
      symlinks.set(posix.normalize(linkPath), { target: posix.normalize(targetPath), mode: linkMode })
    },
    remove: remove!,
  }
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof FsError)
  return error.code
}

test('patchText applies hunks on the remote host and returns before/after', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const target = await h.fs.resolve(placeholder('a.ts'))
  const outcome = await h.fs.patchText(target, HUNKS, undefined, undefined, POLICY)
  assert.deepEqual(outcome.before, 'alpha\nbeta\n')
  assert.deepEqual(outcome.after, 'alpha\nBETA\n')
  assert.equal(typeof outcome.version, 'string')
  assert.deepEqual(h.backend.patches, [], 'the local provider must never patch a remote target')
  assert.ok(h.writes.some(entry => entry.stdin === 'alpha\nBETA\n'), 'the patched text must be sent to the remote host')
  h.remove()
})

test('patchText keeps CRLF line endings on the remote file', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/a.ts`, 'alpha\r\nbeta\r\n')
  const target = await h.fs.resolve(placeholder('a.ts'))
  const outcome = await h.fs.patchText(target, HUNKS, undefined, undefined, POLICY)
  assert.equal(outcome.before, 'alpha\nbeta\n')
  assert.equal(outcome.after, 'alpha\nBETA\n')
  assert.ok(h.writes.some(entry => entry.stdin === 'alpha\r\nBETA\r\n'), 'commit must restore the original line endings')
  h.remove()
})

test('patchText reports a hunk mismatch without writing anything', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const target = await h.fs.resolve(placeholder('a.ts'))
  const missing: readonly PatchHunk[] = [
    { lineNumber: 4, oldLines: ['not present'], newLines: ['x'], isEndOfFile: false },
  ]
  await assert.rejects(
    () => h.fs.patchText(target, missing, undefined, undefined, POLICY),
    (error: unknown) => {
      assert.equal(codeOf(error), 'FS_PATCH_MISMATCH')
      assert.match((error as Error).message, /hunk at patch line 4/)
      return true
    },
  )
  assert.equal(h.writes.filter(entry => !entry.command.startsWith('stat ')).length, 0)
  h.remove()
})

test('patchText refuses binary content and a stale observed version', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/a.ts`, 'alpha\n\u0000beta\n')
  const binary = await h.fs.resolve(placeholder('a.ts'))
  await assert.rejects(
    () => h.fs.patchText(binary, HUNKS, undefined, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_NOT_TEXT',
  )
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const target = await h.fs.resolve(placeholder('a.ts'))
  const stale = remoteVersionToken({ base: 'other', strong: 'different' })
  await assert.rejects(
    () => h.fs.patchText(target, HUNKS, { version: stale }, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_STALE_VERSION',
  )
  h.remove()
})

test('a mutation keeps ctx.fs.contains usable for the written path', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const parent = await h.fs.resolve(placeholder())
  const target = await h.fs.resolve(placeholder('a.ts'))
  assert.equal(h.fs.contains(parent, target), true)
  await h.fs.patchText(target, HUNKS, undefined, undefined, POLICY)
  // containsRemote fails closed when either identity is missing; a mutation
  // must not turn a just-written path into "not contained".
  assert.equal(h.fs.contains(parent, target), true)
  h.remove()
})

test('patchText keeps the version generation monotonic across mutations', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const target = await h.fs.resolve(placeholder('a.ts'))
  const first = await h.fs.patchText(target, HUNKS, undefined, undefined, POLICY)
  const second = await h.fs.patchText(target, HUNKS, undefined, undefined, POLICY)
  const firstGeneration = parseRemoteVersion(first.version)?.generation
  const secondGeneration = parseRemoteVersion(second.version)?.generation
  // `bumpVersion` documents that the counter must never be reset by a
  // mutation: a reset would let a later write reuse an older generation and
  // compare equal to a stale token.
  assert.equal(typeof firstGeneration, 'number')
  assert.equal(typeof secondGeneration, 'number')
  assert.ok(
    (secondGeneration as number) > (firstGeneration as number),
    `generation must grow across mutations, got ${firstGeneration} then ${secondGeneration}`,
  )
  h.remove()
})

test('deleteFile removes remotely with rm --, never rm -f, and returns the diff basis', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const target = await h.fs.resolve(placeholder('a.ts'))
  const outcome = await h.fs.deleteFile(target, undefined, undefined, POLICY)
  assert.equal(outcome.before, 'alpha\nbeta\n')
  assert.deepEqual(h.backend.deletes, [], 'the local provider must never delete a remote target')
  const deleteScript = h.commands.find(command => command.includes('rm -- '))
  assert.ok(deleteScript, 'a delete script must run on the remote host')
  assert.ok(!h.commands.some(command => command.includes('rm -f ')), 'rm -f would hide a vanished target')
  h.remove()
})

test('deleteFile maps a target that disappeared between check and rm to FS_IO_ERROR', async () => {
  const h = createHarness({
    execResult: command => command.includes('rm -- ')
      ? result(26, '', 'remote delete target disappeared or is not a regular file')
      : result(0),
  })
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const target = await h.fs.resolve(placeholder('a.ts'))
  await assert.rejects(
    () => h.fs.deleteFile(target, undefined, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_IO_ERROR',
  )
  h.remove()
})

test('deleteFile refuses a symlink, a directory and a stale version', async () => {
  const h = createHarness()
  const link = await h.fs.resolve(placeholder('link.ts'))
  h.setFile(`${REMOTE}/link.ts`, 'x', { type: 'symlink', size: 1, mtime: 7 })
  await assert.rejects(
    () => h.fs.deleteFile(link, undefined, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_PERMISSION_DENIED',
  )
  const dir = await h.fs.resolve(placeholder('dir'))
  h.setFile(`${REMOTE}/dir`, 'x', { type: 'directory', size: 1, mtime: 7 })
  await assert.rejects(
    () => h.fs.deleteFile(dir, undefined, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_NOT_REGULAR_FILE',
  )
  const file = await h.fs.resolve(placeholder('a.ts'))
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  await assert.rejects(
    () => h.fs.deleteFile(file, { version: remoteVersionToken({ base: 'other', strong: 'x' }) }, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_STALE_VERSION',
  )
  h.remove()
})

test('moveFile publishes the destination and removes the source', async () => {
  const h = createHarness({ publishPaths: [`${REMOTE}/b.ts`] })
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const source = await h.fs.resolve(placeholder('a.ts'))
  const destination = await h.fs.resolve(placeholder('b.ts'))
  const outcome = await h.fs.moveFile(source, destination, {}, undefined, POLICY)
  assert.equal(outcome.sourceDeleted, true)
  assert.equal(outcome.sourceBefore, 'alpha\nbeta\n')
  assert.equal(outcome.destination.operation, 'create')
  assert.equal(outcome.destination.before, null)
  assert.equal(outcome.destination.after, 'alpha\nbeta\n')
  assert.deepEqual(h.backend.moves, [], 'the local provider must never move a remote target')
  assert.ok(h.writes.some(entry => entry.stdin === 'alpha\nbeta\n'), 'the destination content is written remotely')
  assert.ok(h.commands.some(command => command.includes('rm -- ')), 'the source is removed remotely')
  h.remove()
})

test('moveFile applies hunks before publishing the destination', async () => {
  const h = createHarness({ publishPaths: [`${REMOTE}/b.ts`] })
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const source = await h.fs.resolve(placeholder('a.ts'))
  const destination = await h.fs.resolve(placeholder('b.ts'))
  const outcome = await h.fs.moveFile(source, destination, { hunks: HUNKS }, undefined, POLICY)
  assert.equal(outcome.destination.after, 'alpha\nBETA\n')
  assert.ok(h.writes.some(entry => entry.stdin === 'alpha\nBETA\n'))
  h.remove()
})

test('moveFile keeps the published destination when source removal fails', async () => {
  const h = createHarness({
    publishPaths: [`${REMOTE}/b.ts`],
    execResult: command => command.includes('rm -- ')
      ? result(26, '', 'remote delete target disappeared or is not a regular file')
      : result(0),
  })
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const source = await h.fs.resolve(placeholder('a.ts'))
  const destination = await h.fs.resolve(placeholder('b.ts'))
  const outcome = await h.fs.moveFile(source, destination, {}, undefined, POLICY)
  assert.equal(outcome.sourceDeleted, false)
  if (outcome.sourceDeleted) throw new Error('unreachable')
  assert.equal(outcome.sourceFailure.code, 'FS_IO_ERROR')
  assert.match(outcome.sourceFailure.message, /disappeared/)
  assert.equal(outcome.destination.after, 'alpha\nbeta\n', 'the destination is not rolled back')
  h.remove()
})

test('moveFile refuses two spellings that name the same remote file', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  // The workspace-relative spelling and the whole-path spelling are different
  // target keys but the same remote file. A move would publish the destination
  // and then delete the source — destroying the file.
  const source = await h.fs.resolve(placeholder('a.ts'))
  const destination = await h.fs.resolve(mapRemoteToLocal('lo', `${REMOTE}/a.ts`)!)
  assert.notEqual(String(source.targetKey), String(destination.targetKey))
  await assert.rejects(
    () => h.fs.moveFile(source, destination, {}, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_SAME_TARGET',
  )
  assert.equal(h.writes.filter(entry => !entry.command.startsWith('stat ')).length, 0, 'nothing may be written')
  assert.equal(h.commands.some(command => command.includes('rm -- ')), false, 'the file must not be deleted')
  h.remove()
})

test('moveFile rejects same target, mixed local/remote and missing policy', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const remote = await h.fs.resolve(placeholder('a.ts'))
  const remoteB = await h.fs.resolve(placeholder('b.ts'))
  const local: FsTarget = { targetKey: FsTargetKey('/tmp/local'), displayPath: '/tmp/local' }
  await assert.rejects(
    () => h.fs.moveFile(remote, remote, {}, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_SAME_TARGET',
  )
  await assert.rejects(
    () => h.fs.moveFile(local, remoteB, {}, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_SANDBOX_DENIED',
  )
  await assert.rejects(
    () => h.fs.moveFile(remote, remoteB, {}, undefined, undefined),
    (error: unknown) => codeOf(error) === 'FS_SANDBOX_DENIED',
  )
  // A local target still reaches the mounted provider's own implementation.
  await h.fs.moveFile(local, { targetKey: FsTargetKey('/tmp/local2'), displayPath: '/tmp/local2' }, {}, undefined, POLICY)
  assert.equal(h.backend.moves.length, 1)
  h.remove()
})

test('patchText follows a final symlink like the local backend while delete and move refuse it', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/real.ts`, 'alpha\nbeta\n', { type: 'file', size: 11, mtime: 7, mode: 0o644 })
  // Real SFTP lstat reports a symlink mode with S_IFLNK set. Passing that to
  // `chmod` would strip it to 0777 on the target file.
  h.setSymlink(`${REMOTE}/link.ts`, `${REMOTE}/real.ts`, 0o120777)
  const link = await h.fs.resolve(placeholder('link.ts'))
  const outcome = await h.fs.patchText(link, HUNKS, undefined, undefined, POLICY)
  assert.equal(outcome.after, 'alpha\nBETA\n')
  const chmod = h.commands.filter(command => command.includes('chmod '))
  assert.ok(chmod.length > 0, 'the commit must restore the target file mode')
  assert.ok(chmod.every(command => /chmod 644 /.test(command)), `expected chmod 644, got ${JSON.stringify(chmod)}`)
  assert.ok(!chmod.some(command => /chmod 777 /.test(command)), 'the symlink mode must never reach chmod')
  assert.deepEqual(h.backend.patches, [], 'the remote patch must not go through the local provider')
  // Delete and move keep refusing the link itself: `rm` on its resolved target
  // would remove a different path than the one the patch named.
  const forDelete = await h.fs.resolve(placeholder('link.ts'))
  await assert.rejects(
    () => h.fs.deleteFile(forDelete, undefined, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_PERMISSION_DENIED',
  )
  const forMove = await h.fs.resolve(placeholder('link.ts'))
  const moveDestination = await h.fs.resolve(placeholder('b.ts'))
  await assert.rejects(
    () => h.fs.moveFile(forMove, moveDestination, {}, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_PERMISSION_DENIED',
  )
  h.remove()
})

test('a failed commit drops the stat cache so the caller can tell unknown from failed', async () => {
  const h = createHarness({
    publishPaths: [`${REMOTE}/a.ts`],
    mutateOnFailure: true,
    execResult: () => result(1, '', 'remote write failed after rename'),
  })
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const target = await h.fs.resolve(placeholder('a.ts'))
  const before = await h.fs.stat(target)
  assert.ok(before)
  await assert.rejects(
    () => h.fs.writeText(target, 'gamma\n', undefined, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_IO_ERROR',
  )
  // The command changed the file and then failed. A cached pre-write stat would
  // make apply_patch's `unchanged` report "failed"; it must see the new state.
  const after = await h.fs.stat(target)
  assert.ok(after)
  assert.notEqual(after.version, before.version, 'the attribute cache must be dropped after an uncertain failure')
  h.remove()
})

test('moveFile enforces both the source and the destination version guard', async () => {
  const h = createHarness({ publishPaths: [`${REMOTE}/b.ts`] })
  h.setFile(`${REMOTE}/a.ts`, 'alpha\n')
  const stale = remoteVersionToken({ base: 'other', strong: 'different' })
  const source = await h.fs.resolve(placeholder('a.ts'))
  const destination = await h.fs.resolve(placeholder('b.ts'))
  await assert.rejects(
    () => h.fs.moveFile(source, destination, { expectedSource: { version: stale } }, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_STALE_VERSION',
  )
  h.setFile(`${REMOTE}/b.ts`, 'bee\n')
  const sourceAgain = await h.fs.resolve(placeholder('a.ts'))
  const destinationAgain = await h.fs.resolve(placeholder('b.ts'))
  await assert.rejects(
    () => h.fs.moveFile(sourceAgain, destinationAgain, {
      expectedDestination: { kind: 'replaceIfVersion', version: stale },
    }, undefined, POLICY),
    (error: unknown) => codeOf(error) === 'FS_STALE_VERSION',
  )
  assert.equal(h.commands.some(command => command.includes('rm -- ')), false, 'a refused move must not delete the source')
  h.remove()
})

test('danger-full-access commits without a sandbox wrapper, workspace-write wraps them', async () => {
  const full = createHarness({ publishPaths: [`${REMOTE}/b.ts`] })
  full.setFile(`${REMOTE}/a.ts`, 'alpha\n')
  const fullPolicy = { ...POLICY, mode: 'danger-full-access' } as unknown as SandboxExecutionPolicy
  await full.fs.moveFile(await full.fs.resolve(placeholder('a.ts')), await full.fs.resolve(placeholder('b.ts')), {}, undefined, fullPolicy)
  assert.ok(full.commands.length > 0)
  assert.equal(full.commands.some(command => command.includes('bwrap') || command.includes('sandbox-exec')), false)
  full.remove()

  const confined = createHarness()
  confined.setFile(`${REMOTE}/a.ts`, 'alpha\n')
  await confined.fs.deleteFile(await confined.fs.resolve(placeholder('a.ts')), undefined, undefined, POLICY)
  assert.ok(confined.commands.some(command => command.includes('bwrap')), 'workspace-write must run the delete inside the sandbox')
  confined.remove()
})

test('a read-only session refuses every patch mutation', async () => {
  const h = createHarness()
  h.setFile(`${REMOTE}/a.ts`, 'alpha\nbeta\n')
  const target = await h.fs.resolve(placeholder('a.ts'))
  const other = await h.fs.resolve(placeholder('b.ts'))
  const readOnly = { ...POLICY, mode: 'read-only' } as unknown as SandboxExecutionPolicy
  for (const run of [
    () => h.fs.patchText(target, HUNKS, undefined, undefined, readOnly),
    () => h.fs.deleteFile(target, undefined, undefined, readOnly),
    () => h.fs.moveFile(target, other, {}, undefined, readOnly),
  ]) {
    await assert.rejects(run, (error: unknown) => codeOf(error) === 'FS_SANDBOX_DENIED')
  }
  assert.equal(h.writes.filter(entry => !entry.command.startsWith('stat ')).length, 0)
  h.remove()
})

test('local targets still delegate to the provider, and old hosts keep the refusal', async () => {
  const h = createHarness()
  const local: FsTarget = { targetKey: FsTargetKey('/tmp/local'), displayPath: '/tmp/local' }
  await h.fs.patchText(local, HUNKS, undefined, undefined, POLICY)
  await h.fs.deleteFile(local, undefined, undefined, POLICY)
  assert.equal(h.backend.patches.length, 1)
  assert.equal(h.backend.deletes.length, 1)
  h.remove()

  const old = createHarness({ withoutOptionalMutations: true })
  // A provider with none of the 0.2.2 methods has nothing to wrap: the tool
  // layer sees a missing method instead of a refusal that would claim this
  // plugin blocked a call it never received.
  assert.equal((old.backend as unknown as { patchText?: unknown }).patchText, undefined)
  assert.equal((old.backend as unknown as { deleteFile?: unknown }).deleteFile, undefined)
  assert.equal((old.backend as unknown as { moveFile?: unknown }).moveFile, undefined)
  old.remove()
})
