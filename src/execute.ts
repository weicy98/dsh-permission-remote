import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import {
  SandboxUnavailableError,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
  type SandboxMode,
} from '@deepseek-ai/dsh-sandbox'
import type { HostConfig } from './config.ts'
import { distroInstallFor, parseOsRelease, type DistroInstall } from './install-commands.ts'
import { composeCreatedPath } from './contain.ts'
import {
  atomicWriteScript,
  bwrapFileProfileArgs,
  bwrapProfileArgs,
  bwrapProbeArgv,
  fileWritableRoots,
  fileWriteAllowed,
  globArgv,
  grepArgv,
  sandboxDenied,
  seatbeltBashCommand,
  seatbeltProbeArgv,
  type RemoteFileRoots,
} from './profile.ts'
import { hostFactsCommand, parseHostFacts, probeOutcome, ripgrepPackage, type ProbeOutcome } from './probe.ts'
import { mapRemoteToLocal, resolveRemotePath, toModelPath, type RemoteRoute } from './router.ts'
import { shJoin } from './shell-quote.ts'
import { SshPool, type ExecResult, type SecretMaterial } from './ssh-pool.ts'

const require = createRequire(import.meta.url)
const READ_CAP = 1024 * 1024
const IMAGE_CAP = 8 * 1024 * 1024

export interface RunnerStatus {
  readonly os: 'linux' | 'darwin' | 'other'
  readonly sandbox: ProbeOutcome
  readonly sandboxTool: 'bwrap' | 'sandbox-exec' | 'none'
  readonly ripgrep: 'uploaded' | 'system' | 'missing'
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

export interface ToolHost {
  readonly pool: SshPool
  readonly hostOf: (hostId: string) => HostConfig | undefined
  readonly secretOf: (host: HostConfig) => Promise<SecretMaterial>
  readonly statusOf: (host: HostConfig) => Promise<RunnerStatus>
  readonly resolveMode: (exec: ToolExec, requested: string | undefined, justification: string | undefined, toolName: string, subject: string) => Promise<SandboxMode>
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

const denialMarker = sandboxDenialMarker
const hintMarker = escalationHintMarker

export async function probeHost(pool: SshPool, host: HostConfig, secret: SecretMaterial): Promise<RunnerStatus> {
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
  const rgRemote = `${home}/.dsh-permission-remote/rg`
  const system = await pool.exec(host, secret, 'command -v rg', 10_000)
  let ripgrep: RunnerStatus['ripgrep'] = 'missing'
  let ripgrepPath = ''
  if (!system.timedOut && system.code === 0 && system.stdout.trim().length > 0) {
    ripgrep = 'system'
    ripgrepPath = system.stdout.trim().split('\n')[0] ?? 'rg'
  } else {
    const pkg = ripgrepPackage(os, arch)
    const local = pkg === null ? null : resolveRgBinary(pkg)
    if (local !== null) {
      await pool.sftpUpload(host, secret, local, rgRemote)
      const check = await pool.exec(host, secret, `${shJoin([rgRemote])} --version`, 15_000)
      if (check.code === 0) {
        ripgrep = 'uploaded'
        ripgrepPath = rgRemote
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

function resolveRgBinary(pkg: string): string | null {
  try {
    return require.resolve(`${pkg}/bin/rg`)
  } catch {
    return null
  }
}

export async function effectiveMode(host: ToolHost, exec: ToolExec, args: { sandbox_permissions?: string, justification?: string }, toolName: string, subject: string): Promise<SandboxMode> {
  return host.resolveMode(exec, args.sandbox_permissions, args.justification, toolName, subject)
}

export function buildResolveMode(ctx: {
  sandboxPolicy: { resolve(request?: { session?: object, mode?: SandboxMode }): { mode: SandboxMode } }
  get(name: string): unknown
}): ToolHost['resolveMode'] {
  return async (exec, requested, justification, toolName, subject) => {
    const session = exec.agent?.session
    const standing = ctx.sandboxPolicy.resolve(session === undefined ? {} : { session }).mode
    validateEscalationArgs(requested, justification)
    if (requested === undefined || justification === undefined) return standing
    const approved = await approveEscalation({
      requestedMode: requested,
      justification,
      effectiveMode: standing,
      subject,
    }, {
      approver: ctx.get('approval') as Parameters<typeof approveEscalation>[1]['approver'],
      agent: exec.agent,
      callId: exec.callId ?? '',
      toolName,
      signal: exec.signal,
    })
    return approved
  }
}

async function rootsFor(status: RunnerStatus, workspace: string, pool: SshPool, host: HostConfig, secret: SecretMaterial): Promise<RemoteFileRoots> {
  const workspaceRoot = await canonicalRemotePath(pool, host, secret, workspace)
  return { workspaceRoot, tmp: status.roots.tmp, userTmp: status.roots.userTmp }
}

const NOT_FOUND = /no such file|cannot find|not found|does not exist/i

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
    if (error instanceof Error && NOT_FOUND.test(error.message)) return ''
    return posix.normalize(remotePath)
  }
}

async function canonicalRemotePath(pool: SshPool, host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string> {
  try {
    return await pool.sftpRealpath(host, secret, remotePath)
  } catch {
    return posix.normalize(remotePath)
  }
}

export async function runBash(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>, exec: ToolExec): Promise<Record<string, unknown>> {
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const status = await hostApi.statusOf(host)
  const mode = await effectiveMode(hostApi, exec, args as { sandbox_permissions?: string, justification?: string }, 'bash', 'command')
  const command = String(args.command ?? '')
  const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : 60_000
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
  const roots = await rootsFor(status, route.remoteCwd, hostApi.pool, host, secret)
  const argv = commandArgv(status, mode, roots, workdir, command)
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

function commandArgv(status: RunnerStatus, mode: SandboxMode, roots: RemoteFileRoots, workdir: string, command: string): string {
  const inner = ['bash', '-c', command]
  if (mode === 'danger-full-access' || !status.sandbox.available) {
    return `cd ${shJoin([workdir])} && ${shJoin(inner)}`
  }
  if (status.sandboxTool === 'bwrap') {
    const profile = bwrapProfileArgs(mode, roots.workspaceRoot) ?? []
    return shJoin(['bwrap', ...profile, '--chdir', workdir, '--', ...inner])
  }
  const writable = mode === 'workspace-write' ? fileWritableRoots(mode, roots) : []
  return seatbeltBashCommand(mode, writable, workdir, command)
}

/** File writes bind the real temp directories. Bash keeps its private tmpfs. */
function fileCommand(status: RunnerStatus, mode: SandboxMode, roots: RemoteFileRoots, script: string): string {
  if (status.sandboxTool === 'bwrap') {
    const profile = bwrapFileProfileArgs(mode, roots) ?? []
    return shJoin(['bwrap', ...profile, '--chdir', roots.workspaceRoot, '--', 'bash', '-c', script])
  }
  const writable = mode === 'workspace-write' ? fileWritableRoots(mode, roots) : []
  return seatbeltBashCommand(mode, writable, roots.workspaceRoot, script)
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
  const roots = await rootsFor(status, route.remoteCwd, hostApi.pool, host, secret)
  const argv = commandArgv(status, mode, roots, workdir, command)
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

export async function runRead(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>, exec?: ToolExec): Promise<Record<string, unknown>> {
  throwIfAborted(exec?.signal)
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const remotePath = resolveRemotePath(String(args.file_path ?? ''), route.remoteCwd, route.placeholderCwd)
  const bytes = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, READ_CAP), exec?.signal)
  const text = bytes.toString('utf8')
  const all = text.split(/\n/)
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 1
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 2000
  const slice = all.slice(offset - 1, offset - 1 + limit)
  return {
    path: toModelPath(remotePath, route),
    offset,
    lines: slice.map((line, index) => ({ number: offset + index, text: line })),
    totalLines: all.length,
  }
}

export async function runWrite(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>, exec: ToolExec): Promise<Record<string, unknown>> {
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const status = await hostApi.statusOf(host)
  const mode = await effectiveMode(hostApi, exec, args as { sandbox_permissions?: string, justification?: string }, 'write', 'operation')
  const remotePath = resolveRemotePath(String(args.file_path ?? ''), route.remoteCwd, route.placeholderCwd)
  const roots = await rootsFor(status, route.remoteCwd, hostApi.pool, host, secret)
  const target = await resolveCreatedPath(hostApi.pool, host, secret, remotePath)
  if (!fileWriteAllowed(mode, target, roots)) {
    throw new FsError(`${denialMarker(mode)}\n${hintMarker('operation')}`, 'FS_SANDBOX_DENIED')
  }
  let before: string | null = null
  try {
    before = (await withSignal(hostApi.pool.sftpRead(host, secret, target, READ_CAP), exec.signal)).toString('utf8')
  } catch (error) {
    if (exec.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw error
    before = null
  }
  const content = String(args.content ?? '')
  await commitFile(hostApi, host, secret, status, mode, roots, target, content, exec.signal)
  return {
    path: toModelPath(target, route),
    operation: before === null ? 'create' : 'update',
    before,
    after: content,
  }
}

export async function runEdit(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>, exec: ToolExec): Promise<Record<string, unknown>> {
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const status = await hostApi.statusOf(host)
  const mode = await effectiveMode(hostApi, exec, args as { sandbox_permissions?: string, justification?: string }, 'edit', 'operation')
  const remotePath = resolveRemotePath(String(args.file_path ?? ''), route.remoteCwd, route.placeholderCwd)
  const roots = await rootsFor(status, route.remoteCwd, hostApi.pool, host, secret)
  const real = await resolveCreatedPath(hostApi.pool, host, secret, remotePath)
  if (!fileWriteAllowed(mode, real, roots)) {
    throw new FsError(`${denialMarker(mode)}\n${hintMarker('operation')}`, 'FS_SANDBOX_DENIED')
  }
  const before = (await withSignal(hostApi.pool.sftpRead(host, secret, real, READ_CAP), exec.signal)).toString('utf8')
  const oldString = String(args.old_string ?? '')
  const newString = String(args.new_string ?? '')
  const replaceAll = args.replace_all === true
  const count = before.split(oldString).length - 1
  if (count === 0) throw new Error(`old_string was not found in ${toModelPath(real, route)}`)
  if (!replaceAll && count !== 1) throw new Error(`old_string matched ${count} times; pass replace_all or include more context`)
  const after = replaceAll ? before.replaceAll(oldString, newString) : before.replace(oldString, newString)
  await commitFile(hostApi, host, secret, status, mode, roots, real, after, exec.signal)
  return { path: toModelPath(real, route), before, after }
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
  const data = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, IMAGE_CAP), exec?.signal)
  const image = await save(data, posix.basename(remotePath))
  return { path: toModelPath(remotePath, route), image }
}

export async function runGlob(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>, exec?: ToolExec): Promise<Record<string, unknown>> {
  throwIfAborted(exec?.signal)
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const status = await hostApi.statusOf(host)
  if (status.ripgrepPath.length === 0) throw new Error('ripgrep is not available on this remote host')
  const base = typeof args.path === 'string'
    ? resolveRemotePath(args.path, route.remoteCwd, route.placeholderCwd)
    : route.remoteCwd
  const pattern = String(args.pattern ?? '')
  const command = `cd ${shJoin([base])} && ${shJoin(globArgv(status.ripgrepPath, pattern))}`
  const result = await hostApi.pool.exec(host, secret, command, 30_000, exec?.signal)
  throwIfRgFailed(result, exec?.signal, 'glob')
  const paths = result.stdout.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
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
  if (status.ripgrepPath.length === 0) throw new Error('ripgrep is not available on this remote host')
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
): Promise<{ cwd: string }> {
  if (args.cd === undefined || args.cd === '') return { cwd: route.placeholderCwd }
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
  await mkdir(local, { recursive: true })
  if (exec.agent === undefined) throw new Error('working_directory requires an agent Session')
  const cwd = await setDirectory(local)
  return { cwd }
}

async function resolveCreatedPath(pool: SshPool, host: HostConfig, secret: SecretMaterial, lexicalPath: string): Promise<string> {
  let cursor = posix.normalize(lexicalPath)
  const missing: string[] = []
  while (true) {
    try {
      const real = await pool.sftpRealpath(host, secret, cursor)
      return composeCreatedPath(real, missing)
    } catch {
      if (cursor === '/') return composeCreatedPath('/', missing)
      missing.unshift(posix.basename(cursor))
      const parent = posix.dirname(cursor)
      if (parent === cursor) return composeCreatedPath(cursor, missing)
      cursor = parent
    }
  }
}

async function commitFile(
  hostApi: ToolHost,
  host: HostConfig,
  secret: SecretMaterial,
  status: RunnerStatus,
  mode: SandboxMode,
  roots: RemoteFileRoots,
  target: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  if (mode !== 'danger-full-access' && !status.sandbox.available) {
    throw new SandboxUnavailableError(mode, 'remote sandbox probe failed')
  }
  const directory = posix.dirname(target)
  const tmp = posix.join(directory, `.dsh-permission-remote-${randomBytes(8).toString('hex')}`)
  const script = atomicWriteScript(directory, tmp, target)
  const wrapped = mode === 'danger-full-access'
    ? script
    : fileCommand(status, mode, roots, script)
  const result = await hostApi.pool.exec(host, secret, wrapped, 20_000, signal, content)
  if (result.code !== 0) throw new Error(result.stderr || 'remote write failed')
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError()
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
function withSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (signal === undefined) return work
  return new Promise((resolve, reject) => {
    const fail = () => reject(abortError())
    signal.addEventListener('abort', fail, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', fail))
  })
}

function capturedText(text: string, truncated: boolean): string {
  if (!truncated) return text
  return `${text}\n[output truncated]`
}

function requireHost(hostApi: ToolHost, hostId: string): HostConfig {
  const host = hostApi.hostOf(hostId)
  if (host === undefined) throw new Error(`SSH host ${hostId} is not configured`)
  return host
}
