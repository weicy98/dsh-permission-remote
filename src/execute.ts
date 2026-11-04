import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, posix } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { FsError } from '@deepseek-ai/dsh-fs'
import { dshCachePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  SandboxUnavailableError,
  WIDER_MODES,
  approveEscalation,
  validateEscalationArgs,
  type SandboxMode,
} from '@deepseek-ai/dsh-sandbox'
import type { HostConfig } from './config.ts'
import { distroInstallFor, parseOsRelease, type DistroInstall } from './install-commands.ts'
import { remoteRoots } from './remote-write.ts'
import {
  bwrapProfileArgs,
  bwrapProbeArgv,
  fileWritableRoots,
  globArgv,
  grepArgv,
  sandboxDenied,
  seatbeltBashCommand,
  seatbeltProbeArgv,
  type RemoteFileRoots,
} from './profile.ts'
import {
  hostFactsCommand,
  outputBlock,
  parseHostFacts,
  probeOutcome,
  type HostFacts,
  ripgrepPackage,
  systemRipgrepCommand,
  systemRipgrepPath,
  type ProbeOutcome,
} from './probe.ts'
import { rgPlatformOf } from './rg-fetch.ts'
import { mapRemoteToLocal, resolveRemotePath, toModelPath, workspaceBinding, type RemoteRoute } from './router.ts'
import { loginEnvApply } from './login-env.ts'
import { shJoin } from './shell-quote.ts'
import { SshPool, isSftpMissing, type ExecResult, type SecretMaterial } from './ssh-pool.ts'

const require = createRequire(import.meta.url)
const READ_CAP = 1024 * 1024
const IMAGE_CAP = 8 * 1024 * 1024

export interface RunnerStatus {
  readonly os: 'linux' | 'darwin' | 'other'
  readonly sandbox: ProbeOutcome
  readonly sandboxTool: 'bwrap' | 'sandbox-exec' | 'none'
  readonly ripgrep: 'uploaded' | 'system' | 'missing' | 'upload-failed'
  readonly ripgrepPath: string
  readonly roots: RemoteFileRoots
  readonly install: DistroInstall | null
}

export interface ToolExec {
  readonly agent?: {
    readonly id?: string
    readonly session?: { readonly id?: string, readonly header?: { readonly cwd?: string } }
  }
  readonly callId?: string
  readonly rootCallId?: string
  readonly signal?: AbortSignal
}

/** A remote action named on the approval card, in both interface languages. */
export interface ApprovalDetail {
  readonly en: string
  readonly zh: string
}

export interface ToolHost {
  readonly pool: SshPool
  readonly hostOf: (hostId: string) => HostConfig | undefined
  readonly secretOf: (host: HostConfig) => Promise<SecretMaterial>
  readonly statusOf: (host: HostConfig) => Promise<RunnerStatus>
  /**
   * Register a remote directory as a DSH workspace, returning the placeholder
   * path and the title it ended up with. The ops tools expose it; the workspace
   * runners do not need it.
   */
  readonly createWorkspace?: (host: HostConfig, remotePath: string, title?: string, signal?: AbortSignal) => Promise<{ path: string, remotePath: string, title: string, created: boolean }>
  readonly resolveMode: (exec: ToolExec, requested: string | undefined, justification: string | undefined, toolName: string, subject: string, detail?: ApprovalDetail) => Promise<SandboxMode>
  /** Captured Bash startup exports for this host. Empty when the capture failed or timed out. */
  readonly loginEnvOf?: (host: HostConfig, signal?: AbortSignal) => Promise<string>
  readonly jobs?: {
    start(spec: {
      kind: string
      label: string
      owner?: string
      toolCall?: { callId: string, rootCallId: string }
      run: (job: { append(text: string, options?: { channel?: 'stdout' | 'stderr' }): void }) => { cancel(): void, done: Promise<unknown> }
    }): string
  }
}

/** Remote kernel and machine type, without the rest of a full probe. */
export async function remoteFacts(pool: SshPool, host: HostConfig, secret: SecretMaterial): Promise<HostFacts> {
  const uname = await pool.exec(host, secret, hostFactsCommand(), 20_000)
  return parseHostFacts(uname.stdout)
}

export async function probeHost(
  pool: SshPool,
  host: HostConfig,
  secret: SecretMaterial,
  resolveBinary: (pkg: string, platform?: string) => string | null = (pkg, platform) => resolveRgBinary(pkg, platform),
): Promise<RunnerStatus> {
  const uname = await pool.exec(host, secret, hostFactsCommand(), 20_000)
  const facts = parseHostFacts(uname.stdout)
  const { os, arch } = facts
  const tmp = await existingRemotePath(pool, host, secret, facts.tmp)
  const userTmp = await existingRemotePath(pool, host, secret, facts.userTmp)
  const home = facts.home
  const roots: RemoteFileRoots = { workspaceRoot: '/', tmp, userTmp }
  let sandbox: ProbeOutcome = { available: false, reason: 'missing' }
  let sandboxTool: RunnerStatus['sandboxTool'] = 'none'
  if (os === 'linux') {
    sandboxTool = 'bwrap'
    const probe = await pool.exec(host, secret, shJoin(bwrapProbeArgv()), 20_000)
    sandbox = probeOutcome(probe.timedOut ? null : probe.code, probe.timedOut, probe.stderr)
  } else if (os === 'darwin') {
    sandboxTool = 'sandbox-exec'
    const probe = await pool.exec(host, secret, shJoin(seatbeltProbeArgv()), 20_000)
    sandbox = probeOutcome(probe.timedOut ? null : probe.code, probe.timedOut, probe.stderr)
  }
  const rgRemote = home.length > 0 ? `${home}/.dsh-permission-remote/rg` : ''
  const system = await pool.exec(host, secret, systemRipgrepCommand(), 10_000)
  let ripgrep: RunnerStatus['ripgrep'] = 'missing'
  let ripgrepPath = ''
  const systemPath = systemRipgrepPath(system.stdout)
  if (!system.timedOut && system.code === 0 && systemPath.length > 0) {
    ripgrep = 'system'
    ripgrepPath = systemPath
  } else if (rgRemote.length > 0) {
    const pkg = ripgrepPackage(os, arch)
    const local = pkg === null ? null : resolveBinary(pkg, rgPlatformOf(os, arch) ?? undefined)
    if (local !== null) {
      // A failed upload must not take the whole probe down: the sandbox
      // verdict is still useful, and `upload-failed` tells the operator the
      // binary exists but the remote refused it.
      try {
        await pool.sftpUpload(host, secret, local, rgRemote)
        const check = await pool.exec(host, secret, `${shJoin([rgRemote])} --version`, 15_000)
        if (!check.timedOut && check.code === 0) {
          ripgrep = 'uploaded'
          ripgrepPath = rgRemote
        } else {
          ripgrep = 'upload-failed'
        }
      } catch {
        ripgrep = 'upload-failed'
      }
    } else {
      // Another control host may already have placed the binary. This machine
      // has nothing to upload (a Windows DSH has no Linux package), and the
      // placed file is not on PATH, so `command -v rg` cannot see it.
      try {
        const check = await pool.exec(host, secret, `${shJoin([rgRemote])} --version`, 15_000)
        if (!check.timedOut && check.code === 0) {
          ripgrep = 'uploaded'
          ripgrepPath = rgRemote
        }
      } catch {
        // A missing file or a dropped channel leaves ripgrep missing. The
        // sandbox verdict above still stands.
      }
    }
  }
  let install: DistroInstall | null = null
  if (os === 'linux') {
    const release = await pool.exec(host, secret, 'cat /etc/os-release', 10_000)
    install = distroInstallFor(parseOsRelease(release.stdout))
  }
  return { os, sandbox, sandboxTool, ripgrep, ripgrepPath, roots, install }
}

export async function installBubblewrap(pool: SshPool, host: HostConfig, secret: SecretMaterial, status: RunnerStatus): Promise<ExecResult> {
  if (status.install === null) {
    throw new Error('this remote has no supported package manager; use the manual command for your distro')
  }
  return pool.exec(host, secret, status.install.auto, 180_000)
}

/**
 * A ripgrep binary for the remote platform.
 *
 * A package manager only installs the platform package matching this host, so a
 * Windows machine managing a Linux remote resolves nothing. The install button
 * caches the downloaded binary instead, and that copy is used when resolution
 * fails. The installed package still wins: an environment that already worked
 * keeps behaving the same way.
 */
export function resolveRgBinary(pkg: string, platform?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    return require.resolve(`${pkg}/bin/rg`)
  } catch {
    if (platform === undefined) return null
    for (const candidate of rgCachePaths(platform, env)) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }
}

/**
 * Candidate cache paths for one remote platform, newest layout first.
 *
 * `<DSH_HOME>/cache` is the harness cache root. The older layout put the binary
 * under `<DSH_HOME>/remote`, which is also the remote-workspace placeholder
 * namespace, so that spelling is only read for binaries downloaded before the
 * move and is never written to again.
 */
export function rgCachePaths(platform: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = resolveDshHome(undefined, env)
  return [
    dshCachePath({ dshHome: home }, 'ripgrep', platform, 'rg'),
    join(home, 'remote', 'ripgrep', platform, 'rg'),
  ]
}

/** Where a downloaded binary for one remote platform is cached. */
export function rgCachePath(platform: string, env: NodeJS.ProcessEnv = process.env): string {
  return rgCachePaths(platform, env)[0]!
}

/**
 * Store a fetched binary and make it executable; returns the cached path.
 *
 * The write is atomic so a probe running at the same moment (or a second
 * install for the same platform) never uploads a half-written file.
 */
export async function cacheRgBinary(platform: string, binary: Buffer, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const target = rgCachePath(platform, env)
  // `writeFileAtomic` creates the parent directory at `dirMode` and renames the
  // finished temp file onto the target, so a concurrent probe never uploads a
  // partially written binary.
  await writeFileAtomic(target, binary, { mode: 0o755, dirMode: 0o700 })
  return target
}

export async function effectiveMode(host: ToolHost, exec: ToolExec, args: { sandbox_permissions?: string, justification?: string }, toolName: string, subject: string, detail?: ApprovalDetail): Promise<SandboxMode> {
  return host.resolveMode(exec, args.sandbox_permissions, args.justification, toolName, subject, detail)
}


const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

export function buildResolveMode(ctx: {
  sandboxPolicy: { resolve(request?: { session?: object, mode?: SandboxMode }): { mode: SandboxMode } }
  get(name: string): unknown
}): ToolHost['resolveMode'] {
  return async (exec, requested, justification, toolName, subject, detail) => {
    const session = exec.agent?.session
    const standing = ctx.sandboxPolicy.resolve(session === undefined ? {} : { session }).mode
    validateEscalationArgs(requested, justification)
    if (requested === undefined || justification === undefined) return standing
    if (!SANDBOX_MODES.includes(requested as SandboxMode)) {
      throw new Error(`sandbox_permissions "${requested}" is not a sandbox mode`)
    }
    // A known narrower mode is not an escalation. Approving a downgrade throws
    // and would fail a danger-full-access session that needs no approval.
    if (requested === standing) return standing
    if (!(WIDER_MODES[standing] ?? []).includes(requested as SandboxMode)) return standing
    const approved = await approveEscalation({
      requestedMode: requested,
      justification,
      effectiveMode: standing,
      subject,
    }, {
      approver: presentOpsDetail(ctx.get('approval') as Parameters<typeof approveEscalation>[1]['approver'], detail),
      agent: exec.agent,
      callId: exec.callId ?? '',
      toolName,
      signal: exec.signal,
    })
    return approved
  }
}

/** The approval card's fixed sentence does not name the remote action. */
function presentOpsDetail(
  approver: Parameters<typeof approveEscalation>[1]['approver'],
  detail: ApprovalDetail | undefined,
): Parameters<typeof approveEscalation>[1]['approver'] {
  if (approver === undefined || detail === undefined) return approver
  const en = detail.en.trim()
  const zh = detail.zh.trim()
  if (en.length === 0 && zh.length === 0) return approver
  return {
    request: req => approver.request({
      ...req,
      displayReason: {
        en: appendLine(req.displayReason?.en ?? req.reason, en),
        zh: appendLine(req.displayReason?.zh ?? req.displayReason?.en ?? req.reason, zh.length > 0 ? zh : en),
      },
    }),
  }
}

function appendLine(base: string, line: string): string {
  return line.length === 0 ? base : `${base}\n${line}`
}

function rootsFor(status: RunnerStatus, workspace: string, pool: SshPool, host: HostConfig, secret: SecretMaterial): Promise<RemoteFileRoots> {
  return remoteRoots(status, workspace, pool, host, secret)
}

/**
 * Writable root for workspace-write.
 *
 * Header on that host: the workspace encoded in the header, so `cd /` does not
 * bind `/`. Header not on that host: the live directory. There is no grant to pin.
 */
export function sandboxWorkspaceRoot(route: RemoteRoute, exec: ToolExec): string {
  const opened = workspaceBinding(exec.agent?.session?.header?.cwd)
  if (opened !== null && opened.hostId === route.hostId) return opened.remotePath
  return route.remoteCwd
}

function sandboxRoots(hostApi: ToolHost, route: RemoteRoute, exec: ToolExec, status: RunnerStatus, host: HostConfig, secret: SecretMaterial): Promise<RemoteFileRoots> {
  return rootsFor(status, sandboxWorkspaceRoot(route, exec), hostApi.pool, host, secret)
}

/**
 * A temp root that is not on disk becomes `''`, so the file profile does not
 * `--bind` it. A transient SFTP failure keeps the normalized path instead of
 * silently revoking write access to the temp directories.
 */
async function existingRemotePath(pool: SshPool, host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string> {
  if (remotePath.trim().length === 0) return ''
  try {
    return await pool.sftpRealpath(host, secret, remotePath)
  } catch (error) {
    if (isSftpMissing(error)) return ''
    return posix.normalize(remotePath)
  }
}

export async function runBash(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>, exec: ToolExec): Promise<Record<string, unknown>> {
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const status = await hostApi.statusOf(host)
  const mode = await effectiveMode(hostApi, exec, args as { sandbox_permissions?: string, justification?: string }, 'bash', 'command')
  const command = String(args.command ?? '')
  const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 60_000
  const workdir = typeof args.workdir === 'string'
    ? resolveRemotePath(args.workdir, route.remoteCwd, route.placeholderCwd)
    : route.remoteCwd
  const cwd = toModelPath(workdir, route)
  if (args.run_in_background === true) {
    return startBackground(hostApi, host, secret, status, route, command, workdir, cwd, mode, exec)
  }
  if (mode !== 'danger-full-access' && !status.sandbox.available) {
    throw new SandboxUnavailableError(mode, 'remote sandbox probe failed')
  }
  throwIfAborted(exec.signal)
  const roots = await sandboxRoots(hostApi, route, exec, status, host, secret)
  const argv = commandArgv(status, mode, roots, workdir, command, await bashSnapshot(hostApi, host, exec.signal))
  const result = await hostApi.pool.exec(host, secret, argv, timeoutMs, exec.signal)
  const denied = mode !== 'danger-full-access' && sandboxDenied(result.code, result.stderr)
  return {
    kind: 'foreground',
    cwd,
    exitCode: result.timedOut ? null : result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: exec.signal?.aborted === true,
    timeoutMs,
    stdout: { text: capturedText(result.stdout, result.stdoutTruncated), truncated: result.stdoutTruncated },
    stderr: { text: capturedText(result.stderr, result.stderrTruncated), truncated: result.stderrTruncated },
    ...mode === 'danger-full-access' && !status.sandbox.available
      ? { sandbox: { mode, denied: false, enforcement: 'partial' } }
      : { sandbox: { mode, denied, enforcement: status.sandbox.available ? 'full' : 'partial' } },
  }
}

async function bashSnapshot(hostApi: ToolHost, host: HostConfig, signal?: AbortSignal): Promise<string> {
  if (host.loginEnv !== true || hostApi.loginEnvOf === undefined) return ''
  return hostApi.loginEnvOf(host, signal)
}

function commandArgv(status: RunnerStatus, mode: SandboxMode, roots: RemoteFileRoots, workdir: string, command: string, snapshot: string): string {
  // The snapshot is the bash -c body, so bwrap and seatbelt still confine the command.
  // Startup files were read once, on their own, and are not sourced again here.
  const body = snapshot.length > 0 ? loginEnvApply(snapshot, command, workdir) : command
  const inner = ['bash', '-c', body]
  if (mode === 'danger-full-access' || !status.sandbox.available) {
    return `cd ${shJoin([workdir])} && ${shJoin(inner)}`
  }
  if (status.sandboxTool === 'bwrap') {
    const profile = bwrapProfileArgs(mode, roots.workspaceRoot) ?? []
    return shJoin(['bwrap', ...profile, '--chdir', workdir, '--', ...inner])
  }
  const writable = mode === 'workspace-write' ? fileWritableRoots(mode, roots) : []
  return seatbeltBashCommand(mode, writable, workdir, body)
}

export interface BackgroundOutcome {
  readonly status: 'completed' | 'killed'
  readonly detail: string
}

/**
 * Finish a background job. Output already reached the ring chunk by chunk, so
 * the outcome carries only status: repeating the captured text as `result`
 * would make `job_output` print it twice, because the model read is
 * `delta + result`. The note is appended exactly once.
 */
export function finishBackground(result: ExecResult, note: string, append: (text: string) => void): BackgroundOutcome {
  if (note.length > 0) append(note)
  return {
    status: result.timedOut || result.signal === 'KILL' ? 'killed' : 'completed',
    detail: result.timedOut ? 'timed out' : result.signal === 'KILL' ? 'cancelled' : `exit code: ${result.code ?? 'null'}`,
  }
}

async function startBackground(
  hostApi: ToolHost,
  host: HostConfig,
  secret: SecretMaterial,
  status: RunnerStatus,
  route: RemoteRoute,
  command: string,
  workdir: string,
  cwd: string,
  mode: SandboxMode,
  exec: ToolExec,
): Promise<Record<string, unknown>> {
  const jobs = hostApi.jobs
  if (jobs === undefined || typeof jobs.start !== 'function') {
    throw new Error('background jobs unavailable: load the jobs service')
  }
  if (mode !== 'danger-full-access' && !status.sandbox.available) {
    throw new SandboxUnavailableError(mode, 'remote sandbox probe failed')
  }
  const roots = await sandboxRoots(hostApi, route, exec, status, host, secret)
  const argv = commandArgv(status, mode, roots, workdir, command, await bashSnapshot(hostApi, host, exec.signal))
  const reaped = status.sandbox.available && status.sandboxTool === 'bwrap' && mode !== 'danger-full-access'
  const note = reaped ? '' : '\n[dsh-permission-remote] stopping this job closes its SSH channel; descendant processes may survive when no sandbox runner is wrapping the command'
  const id = jobs.start({
    kind: 'bash',
    label: command,
    owner: exec.agent?.session?.id,
    toolCall: exec.callId === undefined ? undefined : {
      callId: exec.callId,
      rootCallId: exec.rootCallId ?? exec.callId,
    },
    run: (job) => {
      let opened: { close(): void } | undefined
      let cancelled = false
      const done = hostApi.pool.open(host, secret, argv, 0, exec.signal, undefined, chunk => {
        job.append(chunk.text, { channel: chunk.stream })
      }).then(commandHandle => {
        opened = commandHandle
        if (cancelled || exec.signal?.aborted === true) commandHandle.close()
        return commandHandle.done
      }).then(result => finishBackground(result, note, text => job.append(text)))
        .catch((error: unknown) => ({
          status: 'failed' as const,
          detail: error instanceof Error ? error.message : String(error),
        }))
      return {
        cancel: () => {
          cancelled = true
          opened?.close()
        },
        done,
      }
    },
  })
  return { kind: 'background', jobId: id, cwd }
}

export async function runReadImage(
  hostApi: ToolHost,
  route: RemoteRoute,
  args: Record<string, unknown>,
  save: (data: Buffer, name: string) => Promise<Record<string, unknown>>,
  exec?: ToolExec,
): Promise<Record<string, unknown>> {
  throwIfAborted(exec?.signal)
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const remotePath = resolveRemotePath(String(args.file_path ?? ''), route.remoteCwd, route.placeholderCwd)
  const data = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, IMAGE_CAP, exec?.signal), exec?.signal)
  const image = await save(data, posix.basename(remotePath))
  return { path: toModelPath(remotePath, route), image }
}

/**
 * One remote file copied to its placeholder path, for a tool that can
 * only read the local filesystem.
 *
 * `present` resolves its arguments with `ctx.fs` and `stat`s the result, then
 * the delivery card opens that same local path. On a remote session both look
 * inside the placeholder tree, which only holds directories, so a real
 * remote file was reported as "file not found" and no delivery ever landed.
 * The event itself carries strings only, so the honest fix is a real local copy
 * at the path the model already uses — not a rewritten path that would point
 * the card at a file nobody can open.
 */
export interface StagedFile {
  /** The placeholder path the delivery should name and the card should open. */
  readonly path: string
  /** Byte size of the copy. */
  readonly bytes: number
}

/**
 * Refuse a single file above this size. A card that opens a silently truncated
 * copy is worse than saying the copy is too large.
 */
const PRESENT_CAP = 32 * 1024 * 1024

/**
 * Placeholder paths this process wrote a delivery copy to.
 *
 * A delivery card resolves its path when the user opens it, with no time limit,
 * so a per-session cleanup would break a card that is still on screen. The only
 * safe moment is plugin unload, and even then the copies are best-effort: the
 * removal never touches a path this process did not stage, so a real local file
 * that happens to share the spelling is left alone.
 */
const stagedPlaceholders = new Set<string>()
/** Bumped when unloading starts, so a copy that lands afterwards is removed too. */
let stagedEpoch = 0

async function removeStagedCopies(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map(async target => {
    try {
      await rm(target, { force: true })
    } catch {
      // A copy the user already removed, or a directory that was never ours.
    }
  }))
}

/**
 * Delete delivery copies this process staged. Best-effort per path: one
 * failure must not stop the rest, because this runs during teardown.
 *
 * With no list, every staged path is removed and a write that is still in
 * flight deletes its file instead of publishing it. A list removes only those
 * paths, so one caller cannot wipe copies another caller still has on screen.
 */
export async function clearStagedPresentFiles(only?: readonly string[]): Promise<void> {
  if (only !== undefined) {
    const paths = only.filter(target => stagedPlaceholders.delete(target))
    await removeStagedCopies(paths)
    return
  }
  stagedEpoch += 1
  while (stagedPlaceholders.size > 0) {
    const paths = [...stagedPlaceholders]
    for (const target of paths) stagedPlaceholders.delete(target)
    await removeStagedCopies(paths)
  }
}

/**
 * Copy remote files into their placeholder directories so the local
 * `present` tool and the card that opens its paths find real files.
 *
 * Everything is checked on the remote first: a missing path, a directory, or a
 * file over {@link PRESENT_CAP} refuses the whole call and names the remote path
 * the model can act on. Bytes land through `writeFileAtomic`, so a reader never
 * observes a partial copy, and each delivery rewrites the file — the event
 * records only the path, so a later delivery of an updated file has to land
 * newest content at that same path.
 */
export async function stagePresentFiles(
  hostApi: ToolHost,
  route: RemoteRoute,
  files: ReadonlyArray<{ path: string }>,
  exec?: ToolExec,
): Promise<StagedFile[]> {
  throwIfAborted(exec?.signal)
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const staged: StagedFile[] = []
  for (const file of files) {
    const requested = String(file.path ?? '').trim()
    if (requested.length === 0) throw new FsError('Cannot present a file: the path is empty', 'FS_NOT_FOUND')
    const remotePath = resolveRemotePath(requested, route.remoteCwd, route.placeholderCwd)
    const ticket = stagedEpoch
    let info: { isDirectory: boolean, size: number, type?: string }
    try {
      // `sftpStat` follows the final link, so it cannot tell a symlink from a
      // real file. Use `lstat` where the pool provides it; the stat fallback is
      // only for older test doubles.
      if (typeof hostApi.pool.sftpAttrs === 'function') {
        const attrs = await withSignal(hostApi.pool.sftpAttrs(host, secret, remotePath, false), exec?.signal)
        if (attrs === undefined) throw new FsError(`no file at the remote path ${remotePath}`, 'FS_NOT_FOUND')
        info = { isDirectory: attrs.type === 'directory', size: attrs.size, type: attrs.type }
      } else {
        info = await withSignal(hostApi.pool.sftpStat(host, secret, remotePath), exec?.signal)
      }
    } catch (error) {
      if (exec?.signal?.aborted === true) throw error
      // A missing file is the model's path to fix; a dropped connection,
      // permission denial, or SFTP fault is not. Telling it "no file" when the
      // host is unreachable would send it hunting for a path that exists.
      const message = error instanceof Error ? error.message : String(error)
      if (isSftpMissing(error)) throw new FsError(`Cannot present ${requested}: no file at the remote path ${remotePath}`, 'FS_NOT_FOUND')
      if (error instanceof FsError) throw error
      throw new Error(`Cannot present ${requested}: the remote host could not stat ${remotePath}: ${message}`)
    }
    if (info.isDirectory) {
      throw new FsError(`Cannot present ${requested}: the remote path ${remotePath} is a directory, not a file`, 'FS_NOT_REGULAR_FILE')
    }
    if (info.type !== undefined && info.type !== 'file') {
      throw new FsError(`Cannot present ${requested}: the remote path ${remotePath} is not a regular file`, 'FS_NOT_REGULAR_FILE')
    }
    if (info.size > PRESENT_CAP) {
      throw new FsError(`Cannot present ${requested}: the remote file is ${info.size} bytes, over the ${PRESENT_CAP} byte delivery limit`, 'FS_TOO_LARGE')
    }
    let data: Buffer
    try {
      data = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, PRESENT_CAP, exec?.signal), exec?.signal)
    } catch (error) {
      if (exec?.signal?.aborted === true) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (/over the .*byte limit/i.test(message)) {
        throw new FsError(`Cannot present ${requested}: the remote file is over the ${PRESENT_CAP} byte delivery limit`, 'FS_TOO_LARGE')
      }
      throw error
    }
    // The placeholder spelling every other remote tool returns, so the model
    // sees one path for one file whichever tool produced it.
    const placeholder = toModelPath(remotePath, route)
    await withSignal(writeFileAtomic(placeholder, data, { mode: 0o600, dirMode: 0o700 }), exec?.signal)
    // Unload may have started while this file was being fetched or written.
    // Its snapshot does not include this path, so leaving the bytes here would
    // outlive the plugin. A path that was not written is not removed.
    if (ticket !== stagedEpoch) {
      await rm(placeholder, { force: true })
      throw new Error(`Cannot present ${requested}: the plugin is unloading`)
    }
    stagedPlaceholders.add(placeholder)
    staged.push({ path: placeholder, bytes: data.length })
  }
  return staged
}

export async function runGlob(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>, exec?: ToolExec): Promise<Record<string, unknown>> {
  throwIfAborted(exec?.signal)
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const status = await hostApi.statusOf(host)
  if (status.ripgrepPath.length === 0) throw new Error('ripgrep is not available on this remote host; click "Install ripgrep" on its host row in the SSH settings, or install ripgrep on the remote so rg is on PATH')
  const base = typeof args.path === 'string'
    ? resolveRemotePath(args.path, route.remoteCwd, route.placeholderCwd)
    : route.remoteCwd
  const pattern = String(args.pattern ?? '')
  const command = withSearchMarkers(`cd ${shJoin([base])} && ${shJoin(globArgv(status.ripgrepPath, pattern))}`)
  const result = await hostApi.pool.exec(host, secret, command, 30_000, exec?.signal)
  throwIfRgFailed(result, exec?.signal, 'glob')
  const paths = searchOutputLines(result.stdout).map(line => {
    const absolute = posix.isAbsolute(line) ? line : posix.join(base, line)
    return toModelPath(absolute, route)
  })
  return { root: toModelPath(base, route), paths }
}

export async function runGrep(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>, exec?: ToolExec): Promise<Record<string, unknown>> {
  throwIfAborted(exec?.signal)
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const status = await hostApi.statusOf(host)
  if (status.ripgrepPath.length === 0) throw new Error('ripgrep is not available on this remote host; click "Install ripgrep" on its host row in the SSH settings, or install ripgrep on the remote so rg is on PATH')
  const base = typeof args.path === 'string'
    ? resolveRemotePath(args.path, route.remoteCwd, route.placeholderCwd)
    : route.remoteCwd
  const argv = grepArgv(status.ripgrepPath, String(args.pattern ?? ''), base, typeof args.include === 'string' ? args.include : undefined)
  const result = await hostApi.pool.exec(host, secret, shJoin(argv), 30_000, exec?.signal)
  throwIfRgFailed(result, exec?.signal, 'grep')
  const matches: Array<{ path: string, lineNumber: number, line: string }> = []
  for (const row of result.stdout.split('\n')) {
    if (row.trim().length === 0) continue
    let parsed: { type?: string, data?: { path?: { text?: string }, line_number?: number, lines?: { text?: string } } }
    try {
      parsed = JSON.parse(row) as typeof parsed
    } catch {
      continue
    }
    if (parsed.type !== 'match') continue
    const absolute = parsed.data?.path?.text ?? ''
    matches.push({
      path: toModelPath(absolute, route),
      lineNumber: parsed.data?.line_number ?? 0,
      line: (parsed.data?.lines?.text ?? '').replace(/\n$/, ''),
    })
  }
  return { matches }
}

export async function runWorkingDirectory(
  hostApi: ToolHost,
  route: RemoteRoute,
  args: Record<string, unknown>,
  exec: ToolExec,
  setDirectory: (directory: string) => Promise<string>,
  // `sftpRealpath` follows links, so the confirmed directory can sit outside the
  // tree the caller already allowed. Reject that before creating a placeholder.
  allow?: (remote: string, local: string) => void,
): Promise<{ cwd: string, remote: string }> {
  if (args.cd === undefined || args.cd === '') return { cwd: route.placeholderCwd, remote: route.remoteCwd }
  const requested = resolveRemotePath(String(args.cd), route.remoteCwd, route.placeholderCwd)
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  let remote: string
  try {
    remote = await hostApi.pool.sftpRealpath(host, secret, requested)
  } catch {
    throw new Error(`directory does not exist on the remote host: ${requested}`)
  }
  const local = mapRemoteToLocal(route.hostId, remote)
  if (local === null) throw new Error('remote directory cannot be mapped to a workspace path')
  allow?.(remote, local)
  await mkdir(local, { recursive: true })
  if (exec.agent === undefined) throw new Error('working_directory requires an agent Session')
  const cwd = await setDirectory(local)
  return { cwd, remote }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError()
}

/** Login-shell noise around `rg --files` is outside this block. */
const SEARCH_BEGIN = '__DSH_SEARCH_BEGIN__'
const SEARCH_END = '__DSH_SEARCH_END__'

function withSearchMarkers(body: string): string {
  return `printf '%s\\n' '${SEARCH_BEGIN}'; ${body}; status=$?; printf '%s\\n' '${SEARCH_END}'; exit $status`
}

function searchOutputLines(stdout: string): string[] {
  return outputBlock(stdout, SEARCH_BEGIN, SEARCH_END).map(line => line.trim()).filter(line => line.length > 0)
}

function throwIfRgFailed(result: ExecResult, signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted === true) throw abortError()
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `${label} failed`)
}

function abortError(): Error {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  return error
}

/** Stop waiting when the tool call is cancelled. The underlying transfer may still finish. */
export function withSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (signal === undefined) return work
  return new Promise((resolve, reject) => {
    const fail = () => reject(abortError())
    signal.addEventListener('abort', fail, { once: true })
    // `.finally` would forward every rejection into a second promise nobody
    // observes; dsh exits on an unhandled rejection. Detach on both outcomes.
    const detach = () => signal.removeEventListener('abort', fail)
    work.then(resolve, reject).then(detach, detach)
  })
}

export function capturedText(text: string, truncated: boolean): string {
  if (!truncated) return text
  return `${text}\n[output truncated]`
}

function requireHost(hostApi: ToolHost, hostId: string): HostConfig {
  const host = hostApi.hostOf(hostId)
  if (host === undefined) throw new Error(`SSH host ${hostId} is not configured`)
  return host
}
