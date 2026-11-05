/**
 * A fake `ctx.fs` + fake SFTP pool for the official-tool integration test.
 *
 * The official `@deepseek-ai/dsh-tool-fs` and `dsh-tool-str-replace-editor`
 * packages (from the global DSH 0.2.2 install) only ever talk to the Harness
 * filesystem seam (`ctx.fs.resolve/stat/readText/writeText/patchText/...`).
 * `installRemoteFs` patches that seam so placeholder paths are served from a
 * fake SFTP pool. This harness builds the seam, the pool, and the observation
 * hooks the spec asserts against.
 *
 * It deliberately keeps a real-looking *local* backend behind the patch: any
 * path that is NOT a remote placeholder is delegated to it, and it reads/writes
 * a same-named decoy file. That is what makes the `str_replace_editor` bug
 * observable — if a bare remote absolute path fell through to the local
 * filesystem, the decoy would be read or changed.
 *
 * This file owns ONLY this harness. It must not import or change production
 * behaviour; it reads the plugin's `installRemoteFs` and `router` helpers.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { posix } from 'node:path'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { HostConfig } from '../../src/config.ts'
import { installRemoteFs, type RemoteAccess } from '../../src/remote-fs.ts'
import { clearSupersededRoots, mapRemoteToLocal, setRemoteRootOverride } from '../../src/router.ts'
import { SshFailure, type ExecResult, type SftpAttrs } from '../../src/ssh-pool.ts'

/**
 * One stable placeholder root for the whole process. `apply()` calls
 * `applyRemoteRootOverride()`, which resets the *override* to `null`; keeping
 * the root in `DSH_SSH_REMOTE_ROOT` (as remote-fs.spec.ts does) means the
 * default resolver still lands here after that reset. `node --test` runs each
 * spec file in its own process, so this env var cannot leak to other suites.
 */
export const ROOT = mkdtempSync(path.join(tmpdir(), 'dsh-official-tools-'))
process.env.DSH_SSH_REMOTE_ROOT = ROOT
setRemoteRootOverride(null)
clearSupersededRoots()

export const HOST_ID = 'host1'
export const REMOTE_ROOT = '/srv/app'
/** The placeholder directory the remote workspace is opened on. */
export const remoteCwd = mapRemoteToLocal(HOST_ID, REMOTE_ROOT)!

/** Workspace-relative placeholder spelling, e.g. `placeholder('a.ts')`. */
export function placeholder(...extra: string[]): string {
  return path.join(remoteCwd, ...extra)
}

/** Whole-remote-path placeholder spelling (what the editor shadow produces). */
export function absolutePlaceholder(remotePath: string): string {
  return mapRemoteToLocal(HOST_ID, remotePath)!
}

export const POLICY = {
  mode: 'workspace-write',
  workspaceRoot: remoteCwd,
  sessionId: 'session-1',
} as unknown as SandboxExecutionPolicy

const STRONG_STAT = '65024:12345:9:2026-01-01 00:00:00.123456789 +0000'

function result(code: number, stdout = '', stderr = ''): ExecResult {
  return { code, signal: null, stdout, stderr, timedOut: false, stdoutTruncated: false, stderrTruncated: false }
}

export interface WriteCall {
  command: string
  stdin?: string
}

interface Observations {
  localResolveCalls: string[]
  localStatCalls: string[]
  localReadCalls: string[]
  localWrites: string[]
  decoyReads: number
  decoyWrites: number
  decoyContent: string
  decoyFile: string
  files: Map<string, string>
  attrs: Map<string, SftpAttrs | undefined>
  commands: string[]
  writes: WriteCall[]
  poolPaths: string[]
  /** Every path handed to the PATCHED `ctx.fs.resolve` (what official tools call). */
  resolveCalls: string[]
}

/**
 * A minimal local filesystem backend. It implements every `REQUIRED` method of
 * `installRemoteFs` plus the three optional 0.2.2 mutation methods (so the
 * patch routes remote targets through the fake pool), `processPath`, and
 * `sandboxMode` (so the official tools resolve a policy to stamp on writes).
 */
class LocalFs {
  readonly sandboxMode = 'workspace-write'
  constructor(private readonly log: Observations) {}

  processPath(target: any): string { return String(target?.targetKey) }

  async resolve(requested: string, _opts?: any): Promise<any> {
    this.log.localResolveCalls.push(requested)
    return { targetKey: FsTargetKey(requested), displayPath: requested }
  }
  async lstat(): Promise<undefined> { return undefined }
  async stat(target?: any): Promise<any> {
    this.log.localStatCalls.push(String(target?.targetKey))
    return { type: 'file', version: 'decoy-version', size: this.log.decoyContent.length }
  }
  async listDir(): Promise<any[]> { return [] }
  async readText(target?: any): Promise<string> {
    this.log.localReadCalls.push(String(target?.targetKey))
    this.log.decoyReads += 1
    return readFileSync(this.log.decoyFile, 'utf8')
  }
  async streamText(): Promise<AsyncIterable<string>> { return (async function* () {})() }
  async readBytes(): Promise<Uint8Array> { return new Uint8Array() }
  async readByteRange(): Promise<Uint8Array> { return new Uint8Array() }
  async writeText(_target?: any, content?: any): Promise<any> {
    this.log.localWrites.push(String(content))
    this.log.decoyWrites += 1
    writeFileSync(this.log.decoyFile, String(content))
    return { version: 'decoy', before: null, after: String(content) }
  }
  async editText(): Promise<any> { return { version: 'decoy' } }
  async patchText(): Promise<any> { this.log.decoyWrites += 1; return { version: 'decoy', before: '', after: '' } }
  async deleteFile(): Promise<any> { this.log.decoyWrites += 1; return { before: '' } }
  async moveFile(): Promise<any> { this.log.decoyWrites += 1; return { sourceDeleted: true, sourceBefore: '', destination: { operation: 'create', before: null, after: '' } } }
  contains(): boolean { return true }
  async watch(): Promise<() => Promise<void>> { return async () => undefined }
}

export interface Harness {
  /** The patched `ctx.fs` to provide as the Cordis `fs` service. */
  fs: any
  backend: any
  access: RemoteAccess
  files: Map<string, string>
  attrs: Map<string, SftpAttrs | undefined>
  /** Every remote shell command the fake pool was asked to run. */
  commands: string[]
  /** Every write/delete/move exec with its stdin (the published content). */
  writes: WriteCall[]
  /** Every path passed to the fake SFTP pool's read/stat/realpath methods. */
  poolPaths: string[]
  /** Every path passed to the PATCHED `ctx.fs.resolve` (official-tool calls). */
  resolveCalls: string[]
  /** Paths the PATCH resolved by delegating to the LOCAL provider (bug signal). */
  localResolveCalls: string[]
  localStatCalls: string[]
  localReadCalls: string[]
  localWrites: string[]
  decoyReads(): number
  decoyWrites(): number
  decoyFile: string
  decoyContent: string
  /** The plain context installRemoteFs was called on (offers `fs` + logger). */
  ctx: { get(name: string): unknown, logger: { warn(message: string): void } }
  setFile(remotePath: string, content: string, attrsOverride?: SftpAttrs): void
  /** Register one remote directory and its direct children (for editor `view`). */
  setDir(remotePath: string, entries: ReadonlyArray<{ name: string, type: 'file' | 'directory' | 'symlink' | 'other', size?: number, mtime?: number }>): void
  /** Override the next matching remote command result (undefined = default success). */
  setExecOverride(fn: ((command: string, stdin?: string) => ExecResult | undefined) | undefined): void
  getFile(remotePath: string): string | undefined
  removeFile(remotePath: string): void
  /** Clear all observation buffers so one tool call can be measured in isolation. */
  reset(): void
  /** Restore the local backend (undo installRemoteFs). */
  remove(): void
}

export function createHarness(): Harness {
  const decoyDir = mkdtempSync(path.join(tmpdir(), 'dsh-official-decoy-'))
  const decoyFile = path.join(decoyDir, 'a.ts')
  const decoyContent = 'DECOY LOCAL CONTENT — this file must never be read or changed\nsecond decoy line\n'

  const log: Observations = {
    localResolveCalls: [],
    localStatCalls: [],
    localReadCalls: [],
    localWrites: [],
    decoyReads: 0,
    decoyWrites: 0,
    decoyContent,
    decoyFile,
    files: new Map<string, string>(),
    attrs: new Map<string, SftpAttrs | undefined>(),
    commands: [],
    writes: [],
    poolPaths: [],
    resolveCalls: [],
  }
  writeFileSync(decoyFile, decoyContent)

  const backend = new LocalFs(log) as any

  const key = (remotePath: string): string => posix.normalize(remotePath)
  const seen = (remotePath: string): void => { log.poolPaths.push(key(remotePath)) }
  const getContent = (remotePath: string): string | undefined => log.files.get(key(remotePath))

  // A write script carries its new content on stdin; it is the only exec with a
  // stdin. The plugin re-stats the target immediately after committing to verify
  // the write, so the very next sftpAttrs must publish that content into the
  // in-memory tree. This mirrors a real host where the file now exists.
  const state: { pendingWrite: string | undefined, execOverride: ((command: string, stdin?: string) => ExecResult | undefined) | undefined } = {
    pendingWrite: undefined,
    execOverride: undefined,
  }
  const dirs = new Map<string, Array<{ name: string, type: 'file' | 'directory' | 'symlink' | 'other', size?: number, mtime?: number }>>()

  const pool = {
    async sftpRealpath(_host: any, _secret: any, remotePath: string): Promise<string> {
      seen(remotePath)
      return key(remotePath)
    },
    async sftpAttrs(_host: any, _secret: any, remotePath: string, _follow: boolean): Promise<SftpAttrs | undefined> {
      seen(remotePath)
      const normalized = key(remotePath)
      if (state.pendingWrite !== undefined) {
        log.files.set(normalized, state.pendingWrite)
        log.attrs.delete(normalized)
        state.pendingWrite = undefined
      }
      if (log.attrs.has(normalized)) return log.attrs.get(normalized)
      if (dirs.has(normalized)) return { type: 'directory', size: 0, mtime: 7 }
      const content = log.files.get(normalized)
      if (content === undefined) return undefined
      return { type: 'file', size: Buffer.byteLength(content), mtime: 7, mode: 0o644 }
    },
    async sftpReadLink(): Promise<string> { throw new SshFailure('Failure', 'sftp-readlink') },
    async sftpProbeDir(_host: any, _secret: any, remotePath: string): Promise<void> { seen(remotePath) },
    async sftpReadDir(_host: any, _secret: any, remotePath: string): Promise<any[]> {
      seen(remotePath)
      return (dirs.get(key(remotePath)) ?? []).map(entry => ({ name: entry.name, type: entry.type, size: entry.size ?? 0, mtime: entry.mtime ?? 7 }))
    },
    async sftpRead(_host: any, _secret: any, remotePath: string): Promise<Buffer> {
      seen(remotePath)
      const content = getContent(remotePath)
      if (content === undefined) throw new SshFailure('Failure', 'sftp-read')
      return Buffer.from(content)
    },
    async sftpReadAt(): Promise<Buffer> { return Buffer.alloc(0) },
    async *sftpReadChunks(_host: any, _secret: any, remotePath: string): AsyncGenerator<Buffer> {
      seen(remotePath)
      const content = getContent(remotePath)
      if (content !== undefined) yield Buffer.from(content)
    },
    async exec(
      _host: any, _secret: any, command: string, _timeout: number,
      _signal?: AbortSignal, stdin?: string | Buffer,
    ): Promise<ExecResult> {
      log.commands.push(command)
      log.writes.push({ command, stdin: typeof stdin === 'string' ? stdin : undefined })
      // Only write scripts carry stdin. The next sftpAttrs publishes it.
      if (typeof stdin === 'string') state.pendingWrite = stdin
      // `stat -c ...` is the high-resolution version probe; everything else is
      // a write/delete/move script (or an embedded guard) that succeeds.
      if (command.startsWith('stat ')) return result(0, STRONG_STAT)
      const override = state.execOverride?.(command, typeof stdin === 'string' ? stdin : undefined)
      if (override !== undefined) return override
      return result(0)
    },
  }

  const access = {
    requireHost: () => ({ id: HOST_ID } as HostConfig),
    async secret() { return {} },
    allowsRemoteSession: () => true,
    workspaceRootsOf: () => [REMOTE_ROOT],
    async statusOf() {
      return {
        sandbox: { available: true, reason: 'ok' },
        sandboxTool: 'bwrap',
        roots: { workspaceRoot: REMOTE_ROOT, tmp: '/tmp', userTmp: '/tmp' },
        os: 'linux', ripgrep: 'system', ripgrepPath: '/usr/bin/rg', install: null,
      }
    },
    pool,
  } as unknown as RemoteAccess

  const ctx = {
    get(name: string): unknown {
      if (name === 'fs') return backend
      throw new Error(`unexpected service ${name}`)
    },
    logger: { warn(_message: string) {} },
  }

  const remove = installRemoteFs(ctx, access)
  assert.equal(typeof remove, 'function', 'installRemoteFs must patch the fake fs')

  // Spy on the PATCHED resolve: these are the exact paths the official tools
  // hand to `ctx.fs.resolve`. The internal local delegation is recorded by the
  // backend's own `resolve` (localResolveCalls), so the two never overlap.
  const patchedResolve = backend.resolve
  backend.resolve = function (requested: string, opts?: any): Promise<any> {
    log.resolveCalls.push(requested)
    return patchedResolve.call(this, requested, opts)
  }

  return {
    fs: backend,
    backend,
    access,
    files: log.files,
    attrs: log.attrs,
    commands: log.commands,
    writes: log.writes,
    poolPaths: log.poolPaths,
    resolveCalls: log.resolveCalls,
    localResolveCalls: log.localResolveCalls,
    localStatCalls: log.localStatCalls,
    localReadCalls: log.localReadCalls,
    localWrites: log.localWrites,
    decoyReads: () => log.decoyReads,
    decoyWrites: () => log.decoyWrites,
    decoyFile,
    decoyContent,
    ctx,
    setFile(remotePath: string, content: string, attrsOverride?: SftpAttrs): void {
      const normalized = key(remotePath)
      log.files.set(normalized, content)
      if (attrsOverride !== undefined) log.attrs.set(normalized, attrsOverride)
      else log.attrs.delete(normalized)
    },
    setDir(remotePath: string, entries: ReadonlyArray<{ name: string, type: 'file' | 'directory' | 'symlink' | 'other', size?: number, mtime?: number }>): void {
      dirs.set(key(remotePath), [...entries])
    },
    setExecOverride(fn: ((command: string, stdin?: string) => ExecResult | undefined) | undefined): void {
      state.execOverride = fn
    },
    getFile: getContent,
    removeFile(remotePath: string): void {
      log.files.delete(key(remotePath))
      log.attrs.delete(key(remotePath))
    },
    reset(): void {
      log.localResolveCalls.length = 0
      log.localStatCalls.length = 0
      log.localReadCalls.length = 0
      log.localWrites.length = 0
      log.decoyReads = 0
      log.decoyWrites = 0
      log.commands.length = 0
      log.writes.length = 0
      log.poolPaths.length = 0
      log.resolveCalls.length = 0
      state.pendingWrite = undefined
    },
    remove: remove!,
  }
}
