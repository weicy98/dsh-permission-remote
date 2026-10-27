import { createRequire } from 'node:module'
import { posix } from 'node:path'
import { FsError } from '@deepseek-ai/dsh-fs'
import {
  SandboxUnavailableError,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  type SandboxMode,
} from '@deepseek-ai/dsh-sandbox'
import type { HostConfig } from './config.ts'
import { distroInstallFor, parseOsRelease, type DistroInstall } from './install-commands.ts'
import {
  bwrapProfileArgs,
  bwrapProbeArgv,
  fileWriteAllowed,
  seatbeltProbeArgv,
  seatbeltProfileArgs,
  type RemoteFileRoots,
} from './profile.ts'
import { hostFactsCommand, parseHostFacts, probeOutcome, ripgrepPackage, type ProbeOutcome } from './probe.ts'
import { resolveRemotePath, toModelPath, type RemoteRoute } from './router.ts'
import { shJoin } from './shell-quote.ts'
import { SshPool, type ExecResult, type SecretMaterial } from './ssh-pool.ts'

const require = createRequire(import.meta.url)

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
  readonly signal?: AbortSignal
}

export interface ToolHost {
  readonly pool: SshPool
  readonly hostOf: (hostId: string) => HostConfig | undefined
  readonly secretOf: (host: HostConfig) => Promise<SecretMaterial>
  readonly statusOf: (host: HostConfig) => Promise<RunnerStatus>
  readonly resolveMode: (exec: ToolExec, requested: string | undefined, justification: string | undefined, toolName: string, subject: string) => Promise<SandboxMode>
  readonly jobs?: { start(spec: unknown): string }
}

const denialMarker = sandboxDenialMarker
const hintMarker = escalationHintMarker

export async function probeHost(pool: SshPool, host: HostConfig, secret: SecretMaterial): Promise<RunnerStatus> {
  const uname = await pool.exec(host, secret, hostFactsCommand(), 20_000)
  const facts = parseHostFacts(uname.stdout)
  const { os, arch } = facts
  const tmp = await canonicalRemotePath(pool, host, secret, facts.tmp)
  const userTmp = await canonicalRemotePath(pool, host, secret, facts.userTmp)
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
    if (requested === undefined && justification === undefined) return standing
    if (requested === undefined || justification === undefined) {
      throw new Error('sandbox_permissions and justification must be sent together')
    }
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
  const tmp = await canonicalRemotePath(pool, host, secret, status.roots.tmp)
  const userTmp = await canonicalRemotePath(pool, host, secret, status.roots.userTmp)
  return { workspaceRoot, tmp, userTmp }
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
  const argv = commandArgv(status, mode, route.remoteCwd, workdir, command)
  const result = await hostApi.pool.exec(host, secret, argv, timeoutMs)
  const denied = mode !== 'danger-full-access' && result.code !== 0 && /read-only file system|operation not permitted|permission denied/i.test(result.stderr)
  return {
    kind: 'foreground',
    cwd,
    exitCode: result.timedOut ? null : result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: false,
    timeoutMs,
    stdout: { text: result.stdout, truncated: false },
    stderr: { text: denied ? '' : result.stderr, truncated: false },
    ...mode === 'danger-full-access' && !status.sandbox.available
      ? { sandbox: { mode, denied: false, enforcement: 'partial' } }
      : { sandbox: { mode, denied, enforcement: status.sandbox.available ? 'full' : 'partial' } },
  }
}

function commandArgv(status: RunnerStatus, mode: SandboxMode, workspaceRoot: string, workdir: string, command: string): string {
  const inner = ['bash', '-lc', command]
  if (mode === 'danger-full-access' || !status.sandbox.available) {
    return `cd ${shJoin([workdir])} && ${shJoin(inner)}`
  }
  if (status.sandboxTool === 'bwrap') {
    const profile = bwrapProfileArgs(mode, workspaceRoot) ?? []
    return shJoin(['bwrap', ...profile, '--chdir', workdir, '--', ...inner])
  }
  const roots = mode === 'workspace-write' ? [workspaceRoot, status.roots.tmp, status.roots.userTmp] : []
  const profile = seatbeltProfileArgs(mode, roots) ?? []
  return `cd ${shJoin([workdir])} && ${shJoin(['sandbox-exec', ...profile, '--', ...inner])}`
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
  const argv = commandArgv(status, mode, route.remoteCwd, workdir, command)
  const reaped = status.sandbox.available && status.sandboxTool === 'bwrap' && mode !== 'danger-full-access'
  const note = reaped ? '' : '\n[dsh-permission-remote] stopping this job closes its SSH channel; descendant processes may survive when no sandbox runner is wrapping the command'
  const id = jobs.start({
    kind: 'bash',
    label: command,
    owner: exec.agent?.session?.id,
    toolCall: exec.callId === undefined ? undefined : { callId: exec.callId },
    run: () => {
      let opened: { close(): void } | undefined
      let cancelled = false
      const done = hostApi.pool.open(host, secret, argv, 0).then(commandHandle => {
        opened = commandHandle
        if (cancelled) commandHandle.close()
        return commandHandle.done
      }).then(result => ({
        status: result.timedOut || result.signal === 'KILL' ? 'killed' as const : 'completed' as const,
        detail: result.timedOut ? 'timed out' : result.signal === 'KILL' ? 'cancelled' : `exit code: ${result.code ?? 'null'}`,
        result: `${result.stdout}${result.stderr}${note}`,
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

export async function runRead(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const remotePath = resolveRemotePath(String(args.file_path ?? ''), route.remoteCwd, route.placeholderCwd)
  const bytes = await hostApi.pool.sftpRead(host, secret, remotePath)
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
  const real = await safeRealpath(hostApi.pool, host, secret, remotePath)
  const roots = await rootsFor({ ...status, roots: { ...status.roots, workspaceRoot: route.remoteCwd } }, route.remoteCwd, hostApi.pool, host, secret)
  if (!fileWriteAllowed(mode, real, roots)) {
    throw new FsError(`${denialMarker(mode)}\n${hintMarker('operation')}`, 'FS_SANDBOX_DENIED')
  }
  let before: string | null = null
  try {
    before = (await hostApi.pool.sftpRead(host, secret, real)).toString('utf8')
  } catch {
    before = null
  }
  const content = String(args.content ?? '')
  const dir = posix.dirname(real)
  await hostApi.pool.exec(host, secret, `mkdir -p ${shJoin([dir])}`, 15_000)
  const tmp = `${real}.${process.pid}.tmp`
  await hostApi.pool.sftpWrite(host, secret, tmp, content)
  await hostApi.pool.exec(host, secret, `mv -f ${shJoin([tmp, real])}`, 15_000)
  return {
    path: toModelPath(real, route),
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
  const real = await safeRealpath(hostApi.pool, host, secret, remotePath)
  const roots = await rootsFor({ ...status, roots: { ...status.roots, workspaceRoot: route.remoteCwd } }, route.remoteCwd, hostApi.pool, host, secret)
  if (!fileWriteAllowed(mode, real, roots)) {
    throw new FsError(`${denialMarker(mode)}\n${hintMarker('operation')}`, 'FS_SANDBOX_DENIED')
  }
  const before = (await hostApi.pool.sftpRead(host, secret, real)).toString('utf8')
  const oldString = String(args.old_string ?? '')
  const newString = String(args.new_string ?? '')
  const replaceAll = args.replace_all === true
  const count = before.split(oldString).length - 1
  if (count === 0) throw new Error(`old_string was not found in ${toModelPath(real, route)}`)
  if (!replaceAll && count !== 1) throw new Error(`old_string matched ${count} times; pass replace_all or include more context`)
  const after = replaceAll ? before.replaceAll(oldString, newString) : before.replace(oldString, newString)
  const tmp = `${real}.${process.pid}.tmp`
  await hostApi.pool.sftpWrite(host, secret, tmp, after)
  await hostApi.pool.exec(host, secret, `mv -f ${shJoin([tmp, real])}`, 15_000)
  return { path: toModelPath(real, route), before, after }
}

export async function runReadImage(
  hostApi: ToolHost,
  route: RemoteRoute,
  args: Record<string, unknown>,
  save: (data: Buffer, name: string) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const remotePath = resolveRemotePath(String(args.file_path ?? ''), route.remoteCwd, route.placeholderCwd)
  const data = await hostApi.pool.sftpRead(host, secret, remotePath)
  const image = await save(data, posix.basename(remotePath))
  return { path: toModelPath(remotePath, route), image }
}

export async function runGlob(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const status = await hostApi.statusOf(host)
  if (status.ripgrepPath.length === 0) throw new Error('ripgrep is not available on this remote host')
  const base = typeof args.path === 'string'
    ? resolveRemotePath(args.path, route.remoteCwd, route.placeholderCwd)
    : route.remoteCwd
  const pattern = String(args.pattern ?? '')
  const command = `cd ${shJoin([base])} && ${shJoin([status.ripgrepPath, '--files', '--hidden', '--iglob', pattern, '--glob', '!.git/**', '--sort', 'modified'])}`
  const result = await hostApi.pool.exec(host, secret, command, 30_000)
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || 'glob failed')
  const paths = result.stdout.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const absolute = posix.isAbsolute(line) ? line : posix.join(base, line)
    return toModelPath(absolute, route)
  })
  return { root: toModelPath(base, route), paths }
}

export async function runGrep(hostApi: ToolHost, route: RemoteRoute, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const host = requireHost(hostApi, route.hostId)
  const secret = await hostApi.secretOf(host)
  const status = await hostApi.statusOf(host)
  if (status.ripgrepPath.length === 0) throw new Error('ripgrep is not available on this remote host')
  const base = typeof args.path === 'string'
    ? resolveRemotePath(args.path, route.remoteCwd, route.placeholderCwd)
    : route.remoteCwd
  const argv = [status.ripgrepPath, '--json', '-n', '--heading', String(args.pattern ?? '')]
  if (typeof args.include === 'string' && args.include.length > 0) argv.push('--glob', args.include)
  argv.push(base)
  const result = await hostApi.pool.exec(host, secret, shJoin(argv), 30_000)
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || 'grep failed')
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

async function safeRealpath(pool: SshPool, host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string> {
  try {
    return await pool.sftpRealpath(host, secret, remotePath)
  } catch {
    return posix.normalize(remotePath)
  }
}

function requireHost(hostApi: ToolHost, hostId: string): HostConfig {
  const host = hostApi.hostOf(hostId)
  if (host === undefined) throw new Error(`SSH host ${hostId} is not configured`)
  return host
}
