import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
  sandboxDenied,
  seatbeltBashCommand,
  seatbeltProbeArgv,
  type RemoteFileRoots,
} from './profile.ts'
import {
  hostFactsCommand,
  nodeProbeCommand,
  parseHostFacts,
  parseNodeProbe,
  PTC_MIN_NODE_MAJOR,
  probeOutcome,
  type HostFacts,
  ripgrepPackage,
  systemRipgrepCommand,
  systemRipgrepPath,
  type ProbeOutcome,
} from './probe.ts'
import { rgPlatformOf } from './rg-fetch.ts'
import { mapRemoteToLocal, resolveRemotePath, toModelPath, workspaceBinding, type RemoteRoute } from './router.ts'
import { HARD_MAX_BYTES, type PendingSnapshot, type PresentCache } from './present-cache.ts'
import { loginEnvApply } from './login-env.ts'
import { shJoin } from './shell-quote.ts'
import { SshPool, isSftpMissing, type ExecResult, type SecretMaterial } from './ssh-pool.ts'

const require = createRequire(import.meta.url)
const READ_CAP = 1024 * 1024

export type RemoteNodeStatus =
  | { readonly available: true, readonly path: string, readonly version: string, readonly major: number }
  | { readonly available: false, readonly reason: 'missing' | 'old', readonly version?: string }

export interface RunnerStatus {
  readonly os: 'linux' | 'darwin' | 'other'
  readonly sandbox: ProbeOutcome
  readonly sandboxTool: 'bwrap' | 'sandbox-exec' | 'none'
  readonly ripgrep: 'uploaded' | 'system' | 'missing' | 'upload-failed'
  readonly ripgrepPath: string
  readonly roots: RemoteFileRoots
  readonly home: string
  readonly node?: RemoteNodeStatus
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
  /**
   * Absolute remote path of the published snapshot, or `''` when this command
   * should keep the SSH environment. Empty covers a failed capture and a
   * publish that did not land a file.
   */
  readonly loginEnvFileOf?: (host: HostConfig, signal?: AbortSignal) => Promise<string>
  /** Drop cached remote attributes after a bash process on this host has exited. */
  readonly forgetHostAttrs?: (hostId: string) => void
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
  const node = await probeNode(pool, host, secret)
  return { os, sandbox, sandboxTool, ripgrep, ripgrepPath, roots, home, node, install }
}

/** Probe remote Node without uploading anything; upload is lazy in the PTC wrapper. */
export async function probeNode(pool: SshPool, host: HostConfig, secret: SecretMaterial): Promise<RemoteNodeStatus> {
  const probed = await pool.exec(host, secret, nodeProbeCommand(), 10_000)
  if (probed.timedOut || probed.code !== 0) return { available: false, reason: 'missing' }
  const parsed = parseNodeProbe(probed.stdout)
  if (parsed === null) return { available: false, reason: 'missing' }
  if (parsed.major < PTC_MIN_NODE_MAJOR) return { available: false, reason: 'old', version: parsed.version }
  return { available: true, path: parsed.path, version: parsed.version, major: parsed.major }
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
  const argv = commandArgv(status, mode, roots, workdir, command, await bashEnvFile(hostApi, host, exec.signal))
  let result: Awaited<ReturnType<SshPool['exec']>>
  try {
    result = await hostApi.pool.exec(host, secret, argv, timeoutMs, exec.signal)
  } finally {
    hostApi.forgetHostAttrs?.(route.hostId)
  }
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

async function bashEnvFile(hostApi: ToolHost, host: HostConfig, signal?: AbortSignal): Promise<string> {
  if (host.loginEnv !== true || hostApi.loginEnvFileOf === undefined) return ''
  return hostApi.loginEnvFileOf(host, signal)
}

function commandArgv(status: RunnerStatus, mode: SandboxMode, roots: RemoteFileRoots, workdir: string, command: string, envFile: string): string {
  // The file is sourced inside the bash -c body, so bwrap and seatbelt still confine the command.
  // Startup files were read once, on their own, and are not sourced again here.
  const body = envFile.length > 0 ? loginEnvApply(envFile, command, workdir) : command
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
  const argv = commandArgv(status, mode, roots, workdir, command, await bashEnvFile(hostApi, host, exec.signal))
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
        .then(outcome => {
          hostApi.forgetHostAttrs?.(route.hostId)
          return outcome
        })
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


/**
 * One remote file copied into the local delivery cache, for a tool that can
 * only read the local filesystem.
 *
 * `present` resolves its arguments with `ctx.fs` and `stat`s the result, then
 * the delivery card opens that same local path. On a remote session both look
 * inside the placeholder tree, which only holds directories, so a real
 * remote file was reported as "file not found" and no delivery ever landed.
 * The event itself carries strings only, so the honest fix is a real local copy
 * — not a rewritten path that would point the card at a file nobody can open.
 */
export interface StagedFile {
  /**
   * The path the delivery names and the card opens.
   *
   * A snapshot path under the delivery cache in the normal case, and the
   * placeholder path when the caller passed no cache (or the cache could not be
   * proven readable, which makes the caller pass none).
   */
  readonly path: string
  /** Byte size of the copy. */
  readonly bytes: number
  /** SHA-256 of the bytes, lowercase hex. */
  readonly hash: string
  /** True when these exact bytes were already staged, so nothing was rewritten. */
  readonly reused: boolean
  /**
   * The remote absolute path the copy came from.
   *
   * The caller hands the official tool {@link path} but has to give the model
   * the placeholder spelling the other file tools use, and only the resolved
   * remote path can produce that.
   */
  readonly remotePath: string
}

/** What a caller may constrain about one delivery batch. */
export interface PresentStageOptions {
  /**
   * Byte ceiling for one file.
   *
   * `0` means the operator asked for no transfer limit. The snapshot still
   * needs one (see {@link HARD_MAX_BYTES}): this is a model-callable write to
   * the user's own disk with no approval gate of its own.
   */
  readonly maxBytes: number
  /** Where to stage. Omitted means the placeholder path, for hosts that cannot open a snapshot. */
  readonly cache?: PresentCache
}

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
 * Copy remote files into the local delivery cache so the `present` tool and the
 * card that opens its paths find real files.
 *
 * Everything is checked on the remote first: a missing path, a directory, or a
 * file over the ceiling refuses the whole call and names the remote path the
 * model can act on. Then the bytes are streamed, not buffered — a delivery can
 * be up to {@link HARD_MAX_BYTES} and the whole point of the cache is to stop
 * holding that in memory.
 *
 * The batch is atomic in the only sense that matters to a card: nothing is
 * published until every file has been read completely. A failure on the third
 * file removes the two temps and leaves every already-published snapshot byte
 * for byte as it was. Nothing here rewrites an existing snapshot, because a card
 * recorded earlier may still be pointing at it.
 *
 * With no {@link PresentStageOptions.cache} the bytes land at the placeholder path
 * and are rewritten on every delivery, which is what the plugin did before the
 * cache existed. That path is kept for a host whose filesystem cannot resolve a
 * snapshot back (see `runPresent`), and for older callers.
 */
export async function stagePresentFiles(
  hostApi: ToolHost,
  route: RemoteRoute,
  files: ReadonlyArray<{ path: string }>,
  exec?: ToolExec,
  options?: PresentStageOptions,
): Promise<StagedFile[]> {
  throwIfAborted(exec?.signal)
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const cache = options?.cache
  const ceiling = presentCeiling(options?.maxBytes ?? 0)
  // A pending write per requested entry, in request order. The remote read
  // happens once per distinct remote path: `present` can name one file twice
  // through two spellings, and staging it twice would waste a transfer and,
  // worse, write two temps for the same bytes.
  const pending: Array<PendingSnapshot & { remotePath: string }> = []
  const staged = new Map<string, StagedFile>()
  /** Remote paths already read in this batch, so one file is transferred once. */
  const seen = new Set<string>()
  /** Fallback-mode reads, published only after the whole batch has been read. */
  const fallback: Array<{ remotePath: string, requested: string, data: Buffer }> = []
  // Captured before any read: an unload that starts while the bytes are in
  // flight must invalidate the whole batch, and the write only happens later.
  const ticket = stagedEpoch
  // Snapshots this batch created, so a rollback removes only its own work. A
  // reused path was already on disk and belongs to an earlier delivery.
  const created: string[] = []
  try {
    for (const file of files) {
      const requested = String(file.path ?? '').trim()
      if (requested.length === 0) throw new FsError('Cannot present a file: the path is empty', 'FS_NOT_FOUND')
      const remotePath = resolveRemotePath(requested, route.remoteCwd, route.placeholderCwd)
      // Deduplicated by the resolved remote path, not the spelling: a relative
      // path and the absolute path it resolves to name one file, and reading it
      // twice would waste a transfer and create two temps for the same bytes.
      if (seen.has(remotePath)) continue
      seen.add(remotePath)
      const info = await presentRemoteInfo(hostApi, host, secret, remotePath, requested, exec)
      if (info.size > ceiling.limit) throw presentTooLarge(requested, info.size, ceiling)
      if (cache === undefined) {
        // Buffered, not written: the batch must not leave a placeholder behind
        // when a later file fails. The bytes are published after the loop.
        const buffered = await readRemoteFile(hostApi, host, secret, remotePath, requested, ceiling, exec)
        fallback.push(buffered)
        continue
      }
      const snapshot = await stageIntoCache(cache, hostApi, host, secret, remotePath, requested, info.size, ceiling, exec)
      pending.push(snapshot)
    }
    // Placeholder mode writes only now that every file has been read, so the
    // all-or-nothing promise holds for it too. Each write is atomic on its own
    // (`writeFileAtomic`), but a batch is not: the loop below can still fail
    // halfway, and the copies it already wrote are removed by the catch.
    for (const item of fallback) {
      staged.set(item.remotePath, await writePlaceholder(route, item, ticket, exec))
    }
    // Publish only after every file has been read: a card must never be able to
    // name a snapshot from a batch that did not finish.
    for (const item of pending) {
      const ref = await cache!.publish(item)
      if (!ref.reused) created.push(ref.path)
      staged.set(item.remotePath, {
        path: ref.path,
        bytes: ref.bytes,
        hash: ref.hash,
        reused: ref.reused,
        remotePath: item.remotePath,
      })
    }
  } catch (error) {
    await Promise.all(pending.map(item => cache!.discard(item.temp)))
    // A published snapshot from this batch is new content nobody can reference
    // yet: the event is written only after the whole call succeeds. Remove just
    // those files; the hash directory may hold other names this batch did not
    // create, so it is never removed as a whole.
    await Promise.all(created.map(async path => { await rm(path, { force: true }) }))
    // A placeholder this batch wrote is equally unreferenced. `staged` only
    // holds entries written by the loop above, so nothing older is touched.
    await Promise.all([...staged.values()].map(async entry => { await rm(entry.path, { force: true }) }))
    throw error
  }
  // Rebuild in request order. `staged` is keyed by remote path, so a request
  // that named the same file twice gets the same entry twice instead of a
  // missing slot.
  return files.map(file => {
    const remotePath = resolveRemotePath(String(file.path ?? '').trim(), route.remoteCwd, route.placeholderCwd)
    const entry = staged.get(remotePath)
    if (entry === undefined) throw new FsError('Cannot present a file: the path is empty', 'FS_NOT_FOUND')
    return entry
  })
}

/**
 * The per-file byte ceiling, with where it came from.
 *
 * A configured transfer limit becomes the delivery limit, but only up to
 * {@link HARD_MAX_BYTES}: the setting's `0` means "no limit" for a stream to a
 * remote host, and this writes to the operator's own disk for a tool call that
 * carries no approval of its own. The two messages differ because an operator
 * who raised the setting needs to know the ceiling is not the number they set.
 */
function presentCeiling(configured: number): { limit: number, source: 'setting' | 'no-limit' | 'raised' } {
  if (configured > 0 && configured <= HARD_MAX_BYTES) return { limit: configured, source: 'setting' }
  // `0` is the operator asking for no transfer limit; a value above the ceiling
  // is them asking for more than a delivery will ever allow. They read
  // differently, so they are not one branch.
  if (configured <= 0) return { limit: HARD_MAX_BYTES, source: 'no-limit' }
  return { limit: HARD_MAX_BYTES, source: 'raised' }
}

function presentTooLarge(requested: string, size: number, ceiling: { limit: number, source: 'setting' | 'no-limit' | 'raised' }): FsError {
  const where = ceiling.source === 'setting'
    ? `${ceiling.limit} byte delivery limit`
    : ceiling.source === 'no-limit'
      ? `${ceiling.limit} byte snapshot limit (the transfer setting asks for no limit)`
      : `${ceiling.limit} byte snapshot limit (the transfer setting asks for more, which a delivery does not allow)`
  return new FsError(`Cannot present ${requested}: the remote file is ${size} bytes, over the ${where}`, 'FS_TOO_LARGE')
}

/**
 * The remote side of the verdict on one file.
 *
 * `sftpStat` follows the final link, so it cannot tell a symlink from a real
 * file. Use `lstat` where the pool provides it; the stat fallback is only for
 * older test doubles. A missing file is the model's path to fix; a dropped
 * connection, permission denial, or SFTP fault is not — telling it "no file"
 * when the host is unreachable would send it hunting for a path that exists.
 */
async function presentRemoteInfo(
  hostApi: ToolHost,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  requested: string,
  exec: ToolExec | undefined,
): Promise<{ isDirectory: boolean, size: number, type?: string }> {
  let info: { isDirectory: boolean, size: number, type?: string }
  try {
    if (typeof hostApi.pool.sftpAttrs === 'function') {
      const attrs = await withSignal(hostApi.pool.sftpAttrs(host, secret, remotePath, false), exec?.signal)
      if (attrs === undefined) throw new FsError(`no file at the remote path ${remotePath}`, 'FS_NOT_FOUND')
      info = { isDirectory: attrs.type === 'directory', size: attrs.size, type: attrs.type }
    } else {
      info = await withSignal(hostApi.pool.sftpStat(host, secret, remotePath), exec?.signal)
    }
  } catch (error) {
    if (exec?.signal?.aborted === true) throw error
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
  return info
}

/**
 * Stream one remote file into a cache temp file, hashing as it goes.
 *
 * The byte count is enforced on the bytes actually read, not only on the size
 * the stat reported: a file that grows between the two must not be pulled whole.
 * A truncated read is caught by comparing the total against that stat, which is
 * the one way to notice a file removed mid-read on a server that reports EOF
 * rather than an error.
 */
async function stageIntoCache(
  cache: PresentCache,
  hostApi: ToolHost,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  requested: string,
  expected: number,
  ceiling: { limit: number, source: 'setting' | 'no-limit' | 'raised' },
  exec: ToolExec | undefined,
): Promise<PendingSnapshot & { remotePath: string }> {
  const limit = ceiling.limit
  const { handle, temp } = await cache.createTemp()
  const hash = createHash('sha256')
  let bytes = 0
  try {
    const chunks = remoteChunks(hostApi, host, secret, remotePath, limit, exec?.signal)
    for await (const chunk of chunks) {
      throwIfAborted(exec?.signal)
      bytes += chunk.length
      if (bytes > limit) throw presentTooLarge(requested, bytes, ceiling)
      hash.update(chunk)
      await handle.write(chunk)
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    await cache.discard(temp)
    if (exec?.signal?.aborted === true) throw error
    const message = error instanceof Error ? error.message : String(error)
    // A read refused for size is reported the way the stat would have: the file
    // grew after the stat, and "over the limit" is the actionable answer.
    if (/over the .*byte limit/i.test(message)) throw presentTooLarge(requested, bytes, ceiling)
    throw error
  }
  await handle.close()
  if (bytes !== expected) {
    await cache.discard(temp)
    throw new Error(`Cannot present ${requested}: the remote file changed while it was being read (${expected} bytes reported, ${bytes} read)`)
  }
  const digest = hash.digest('hex')
  return {
    temp,
    target: cache.targetFor(digest, posix.basename(remotePath)),
    hash: digest,
    bytes,
    remotePath,
  }
}

/**
 * The remote bytes as chunks.
 *
 * `sftpReadChunks` streams; `sftpRead` is the whole-file fallback for a pool
 * written before chunks existed (and for a few test doubles). The fallback
 * passes the ceiling so the pool still refuses an oversized file.
 */
async function* remoteChunks(
  hostApi: ToolHost,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  limit: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer> {
  if (typeof hostApi.pool.sftpReadChunks === 'function') {
    for await (const chunk of hostApi.pool.sftpReadChunks(host, secret, remotePath, signal)) yield chunk
    return
  }
  const data = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, limit, signal), signal)
  if (data.length > 0) yield data
}

/**
 * The pre-snapshot behaviour: buffer the file and rewrite the placeholder path.
 *
 * Kept for a host whose filesystem cannot prove a snapshot survives the card's
 * round trip, and for callers that pass no cache deliberately. `writeFileAtomic`
 * means a reader never observes a partial copy, and the epoch check removes a
 * copy that landed after unloading started.
 */
async function readRemoteFile(
  hostApi: ToolHost,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  requested: string,
  ceiling: { limit: number, source: 'setting' | 'no-limit' | 'raised' },
  exec: ToolExec | undefined,
): Promise<{ remotePath: string, requested: string, data: Buffer }> {
  const limit = ceiling.limit
  try {
    const data = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, limit, exec?.signal), exec?.signal)
    return { remotePath, requested, data }
  } catch (error) {
    if (exec?.signal?.aborted === true) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/over the .*byte limit/i.test(message)) throw presentTooLarge(requested, limit, ceiling)
    throw error
  }
}

/**
 * Write one already-read file at its placeholder path.
 *
 * Split from the read so the batch reads everything before it writes anything:
 * a failure on the third file must not leave the first two behind. The write
 * itself is atomic through `writeFileAtomic`, so a reader never sees a partial
 * copy, and the epoch check removes a copy that landed after unloading started.
 */
async function writePlaceholder(
  route: RemoteRoute,
  item: { remotePath: string, requested: string, data: Buffer },
  ticket: number,
  exec: ToolExec | undefined,
): Promise<StagedFile> {
  // The placeholder spelling every other remote tool returns, so the model
  // sees one path for one file whichever tool produced it.
  const placeholder = toModelPath(item.remotePath, route)
  await withSignal(writeFileAtomic(placeholder, item.data, { mode: 0o600, dirMode: 0o700 }), exec?.signal)
  // Unload may have started while this file was being written. Its snapshot
  // does not include this path, so leaving the bytes here would outlive the
  // plugin. A path that was not written is not removed.
  if (ticket !== stagedEpoch) {
    await rm(placeholder, { force: true })
    throw new Error(`Cannot present ${item.requested}: the plugin is unloading`)
  }
  stagedPlaceholders.add(placeholder)
  return {
    path: placeholder,
    bytes: item.data.length,
    hash: createHash('sha256').update(item.data).digest('hex'),
    reused: false,
    remotePath: item.remotePath,
  }
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

export function abortError(): Error {
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
