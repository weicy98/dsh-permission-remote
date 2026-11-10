import { randomBytes } from 'node:crypto'
import { lstat, open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { dirname as dirnameLocal, isAbsolute, posix } from 'node:path'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { HostConfig, OpsPolicy } from './config.ts'
import {
  abortError,
  capturedText,
  throwIfAborted,
  withSignal,
  type ApprovalDetail,
  type ToolExec,
  type ToolHost,
} from './execute.ts'
import { atomicWriteScript } from './profile.ts'
import { resolveCreatedPath } from './remote-write.ts'
import { normalizeRemoteDirectory } from './router.ts'
import { shJoin } from './shell-quote.ts'
import { isSftpMissing, type SecretMaterial } from './ssh-pool.ts'

const READ_CAP = 1024 * 1024
const HOME_BEGIN = '__DSH_OPS_HOME_BEGIN__'
const HOME_END = '__DSH_OPS_HOME_END__'

/**
 * Ceiling and deadline for one transfer, as configured on the settings page.
 * `0` means "no limit" for both. The bytes move one chunk at a time, so an
 * unlimited transfer does not hold the file in memory; it runs until the file
 * ends or the disk refuses another write.
 */
export interface OpsTransferLimits {
  /** Byte ceiling for one transfer; `0` means unlimited. */
  readonly maxBytes: number
  /** Abort deadline for one transfer; `0` means unlimited. */
  readonly timeoutMs: number
}

export const NO_TRANSFER_LIMITS: OpsTransferLimits = { maxBytes: 0, timeoutMs: 0 }

export interface OpsApprovalArgs {
  sandbox_permissions?: string
  justification?: string
}

export interface OpsHostView {
  readonly id: string
  readonly name: string
  readonly address: string
  readonly username: string
  readonly opsPolicy: OpsPolicy
  readonly trusted: boolean
}

/**
 * Resolve `selector` as a host id first, then a case-insensitive name, then a
 * unique address. A repeated name is an error: silently picking one would run
 * the command on the wrong machine.
 */
export function resolveOpsHost(hosts: readonly HostConfig[], selector: string): HostConfig {
  const query = selector.trim()
  if (query.length === 0) throw new Error('ssh host is required; call ssh_hosts for the configured hosts')
  const byId = hosts.find(item => item.id === query)
  if (byId !== undefined) return byId
  const byName = hosts.filter(item => item.name.trim().length > 0 && item.name.trim().toLowerCase() === query.toLowerCase())
  if (byName.length === 1) return byName[0]!
  if (byName.length > 1) throw new Error(`SSH host name "${query}" is ambiguous; use one of: ${byName.map(item => item.id).join(', ')}`)
  const byAddress = hosts.filter(item => item.host === query)
  if (byAddress.length === 1) return byAddress[0]!
  if (byAddress.length > 1) throw new Error(`SSH address "${query}" matches several hosts; use one of: ${byAddress.map(item => item.id).join(', ')}`)
  throw new Error(`unknown SSH host "${query}"; call ssh_hosts for the configured hosts`)
}

export function hostLabel(host: HostConfig): string {
  return host.name.trim().length > 0 ? `${host.name} (${host.host})` : host.host
}

function hostSubject(host: HostConfig, action: string): string {
  const name = host.name.trim().length > 0 ? `"${host.name}"` : ''
  return name.length > 0 ? `${action} on SSH host ${name}` : `${action} on SSH host ${host.host}`
}

export function opsHostView(host: HostConfig): OpsHostView {
  return {
    id: host.id,
    name: host.name,
    address: host.host,
    username: host.username,
    opsPolicy: host.opsPolicy,
    trusted: host.fingerprint.trim().length > 0,
  }
}

function opsEscalationHint(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions "danger-full-access" + justification; the approval prompt asks the user]`
}

export async function requireOps(
  hostApi: ToolHost,
  host: HostConfig,
  exec: ToolExec,
  args: OpsApprovalArgs,
  toolName: string,
  subject: string,
  detail?: ApprovalDetail,
): Promise<void> {
  if (host.opsPolicy === 'deny') throw new Error(`remote ops are disabled for SSH host ${hostLabel(host)}`)
  requireTrusted(host)
  if (host.opsPolicy === 'trust') return
  const requested = args.sandbox_permissions
  if (requested !== undefined && requested !== 'danger-full-access') {
    const standing = await hostApi.resolveMode(exec, undefined, undefined, toolName, subject)
    if (standing === 'danger-full-access') return
    throw new Error(`${sandboxDenialMarker(standing)}\n${opsEscalationHint(subject)}`)
  }
  const mode = await hostApi.resolveMode(exec, requested, args.justification, toolName, subject, detail)
  if (mode === 'danger-full-access') return
  throw new Error(`${sandboxDenialMarker(mode)}\n${opsEscalationHint(subject)}`)
}

/** The SSH pool rejects an untrusted host key with a terse verifier error. */
function requireTrusted(host: HostConfig): void {
  if (host.fingerprint.trim().length > 0) return
  throw new Error(`SSH host ${hostLabel(host)} is not trusted yet; open Settings → SSH hosts, test the connection, and trust its fingerprint first`)
}

function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

export async function runSshExec(hostApi: ToolHost, host: HostConfig, args: Record<string, unknown>, exec: ToolExec): Promise<Record<string, unknown>> {
  const command = String(args.command ?? '')
  if (command.trim().length === 0) throw new Error('command is required')
  const workdir = typeof args.workdir === 'string' ? args.workdir.trim() : ''
  if (workdir.length > 0 && !posix.isAbsolute(workdir)) throw new Error(`workdir must be an absolute remote path: ${workdir}`)
  const where = workdir.length > 0 ? ` (workdir ${clip(workdir, 80)})` : ''
  await requireOps(
    hostApi,
    host,
    exec,
    args as OpsApprovalArgs,
    'ssh_exec',
    hostSubject(host, 'remote command'),
    {
      en: `command on ${hostLabel(host)}: ${clip(command)}${where}`,
      zh: `在 ${hostLabel(host)} 上执行：${clip(command)}${where}`,
    },
  )
  const secret = await hostApi.secretOf(host)
  const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 60_000
  throwIfAborted(exec.signal)
  const inner = shJoin(['bash', '-lc', command])
  const wrapped = workdir.length > 0 ? `cd ${shJoin([workdir])} && ${inner}` : inner
  const result = await hostApi.pool.exec(host, secret, wrapped, timeoutMs, exec.signal)
  return {
    kind: 'foreground',
    host: opsHostView(host),
    workdir: workdir.length > 0 ? workdir : null,
    exitCode: result.timedOut ? null : result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: exec.signal?.aborted === true,
    timeoutMs,
    stdout: { text: capturedText(result.stdout, result.stdoutTruncated), truncated: result.stdoutTruncated },
    stderr: { text: capturedText(result.stderr, result.stderrTruncated), truncated: result.stderrTruncated },
  }
}

export function renderOpsExec(value: Record<string, unknown>): string {
  const host = value.host as OpsHostView | undefined
  const label = host === undefined ? 'remote host' : host.name || host.address
  const stdout = (value.stdout as { text?: string } | undefined)?.text ?? ''
  const stderr = (value.stderr as { text?: string } | undefined)?.text ?? ''
  const status = value.timedOut === true ? 'timed out' : `exit code: ${value.exitCode ?? 'null'}`
  const parts: string[] = []
  if (stdout.length > 0) parts.push(stdout)
  if (stderr.length > 0) parts.push(`[stderr]\n${stderr}`)
  const body = parts.join('\n')
  return body.length === 0 ? `[${label}: ${status}]` : `${body}\n[${label}: ${status}]`
}

export async function runSshRead(hostApi: ToolHost, host: HostConfig, args: Record<string, unknown>, exec?: ToolExec): Promise<Record<string, unknown>> {
  if (host.opsPolicy === 'deny') throw new Error(`remote ops are disabled for SSH host ${hostLabel(host)}`)
  requireTrusted(host)
  throwIfAborted(exec?.signal)
  const secret = await hostApi.secretOf(host)
  const remotePath = await resolveOpsPath(hostApi, host, secret, String(args.file_path ?? ''))
  const bytes = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, READ_CAP, exec?.signal), exec?.signal)
  const text = bytes.toString('utf8')
  const all = text.split(/\n/)
  const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : 1
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 2000
  const slice = all.slice(offset - 1, offset - 1 + limit)
  return {
    host: opsHostView(host),
    path: remotePath,
    offset,
    lines: slice.map((line, index) => ({ number: offset + index, text: line })),
    totalLines: all.length,
  }
}

export function renderOpsRead(value: Record<string, unknown>): string {
  const lines = Array.isArray(value.lines) ? value.lines as Array<{ number: number, text: string }> : []
  const total = typeof value.totalLines === 'number' ? value.totalLines : lines.length
  const body = lines.map(line => `${line.number}|${line.text}`).join('\n')
  const first = lines[0]?.number
  const last = lines[lines.length - 1]?.number
  const span = first === undefined || last === undefined ? 'none' : `${first}-${last}`
  const more = last !== undefined && last < total
  const page = `lines ${span} of ${total}${more ? '; more lines follow' : ''}`
  return body.length === 0 ? page : `${body}\n${page}`
}

/**
 * Register a remote directory as a DSH workspace.
 *
 * This only adds the sidebar workspace. It does not let this session enter
 * and does not return the local placeholder. Opening that workspace starts a
 * session on that machine, so an `ask` host still treats the registration
 * like a command: `danger-full-access`, or one approval. The filesystem root
 * is refused, because that one workspace would cover every path.
 *
 * The current session does not move. The user opens the new workspace from the list.
 */
export async function runSshWorkspace(hostApi: ToolHost, host: HostConfig, args: Record<string, unknown>, exec?: ToolExec): Promise<Record<string, unknown>> {
  throwIfAborted(exec?.signal)
  const requested = String(args.directory ?? '').trim()
  if (requested.length === 0) throw new Error('directory is required')
  if (!posix.isAbsolute(requested) && requested !== '~' && !requested.startsWith('~/')) {
    throw new Error(`directory must be an absolute remote path or start with "~/": ${requested}`)
  }
  if (posix.isAbsolute(requested)) refuseFilesystemRoot(requested, host)
  const create = hostApi.createWorkspace
  if (create === undefined) throw new Error('this build cannot register a workspace for an SSH host')
  await requireOps(
    hostApi,
    host,
    exec ?? {},
    args as OpsApprovalArgs,
    'ssh_workspace',
    hostSubject(host, 'remote workspace registration'),
    {
      en: `register workspace ${clip(requested)} on ${hostLabel(host)}. This adds a sidebar workspace the user can open onto that machine. This session does not enter it`,
      zh: `在 ${hostLabel(host)} 上注册工作区 ${clip(requested)}。侧栏会多出一个可打开的远端工作区，打开后的会话在那台机器上。这个会话不会进入`,
    },
  )
  throwIfAborted(exec?.signal)
  const secret = await hostApi.secretOf(host)
  const remotePath = await resolveOpsPath(hostApi, host, secret, requested, 'directory')
  refuseFilesystemRoot(remotePath, host)
  const title = typeof args.title === 'string' ? args.title : undefined
  const created = await create(host, remotePath, title, exec?.signal)
  return {
    host: opsHostView(host),
    remotePath: created.remotePath,
    title: created.title,
    // The registry reuses an existing row and keeps its title, so a caller that
    // passed one cannot assume it was applied.
    created: created.created,
  }
}

export function renderSshWorkspace(value: Record<string, unknown>): string {
  const host = value.host as OpsHostView | undefined
  const label = host === undefined ? 'remote host' : host.name || host.address
  const title = String(value.title ?? '')
  const path = String(value.remotePath ?? '')
  if (value.created === false) {
    return `workspace already registered: "${title}" for ${path} on ${label}; nothing changed, and the existing title was kept`
  }
  return `workspace added: "${title}" for ${path} on ${label}. This session stays here. Open the workspace from the list to start a session on that machine`
}

export async function runSshWrite(hostApi: ToolHost, host: HostConfig, args: Record<string, unknown>, exec: ToolExec): Promise<Record<string, unknown>> {
  const requestedRaw = String(args.file_path ?? '').trim()
  if (requestedRaw.length === 0) throw new Error('file_path is required')
  const content = String(args.content ?? '')
  await requireOps(
    hostApi,
    host,
    exec,
    args as OpsApprovalArgs,
    'ssh_write',
    hostSubject(host, 'remote file write'),
    {
      en: `write ${clip(requestedRaw)} on ${hostLabel(host)}`,
      zh: `在 ${hostLabel(host)} 上写入 ${clip(requestedRaw)}`,
    },
  )
  const secret = await hostApi.secretOf(host)
  const requested = await resolveOpsPath(hostApi, host, secret, requestedRaw)
  const target = await resolveCreatedPath(hostApi.pool, host, secret, requested)
  throwIfAborted(exec.signal)
  let before: string | null = null
  let mode: number | undefined
  try {
    const info = await withSignal(hostApi.pool.sftpStat(host, secret, target), exec.signal)
    if (info.isDirectory) throw new Error(`remote path is a directory: ${target}`)
    mode = info.mode
    before = (await withSignal(hostApi.pool.sftpRead(host, secret, target, READ_CAP, exec.signal), exec.signal)).toString('utf8')
  } catch (error) {
    if (exec.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw error
    if (!isRemoteMissing(error)) throw error
    before = null
    mode = undefined
  }
  const directory = posix.dirname(target)
  const tmp = posix.join(directory, `.dsh-permission-remote-${randomBytes(8).toString('hex')}`)
  const result = await hostApi.pool.exec(host, secret, atomicWriteScript(directory, tmp, target, mode), 20_000, exec.signal, content)
  if (result.code !== 0) throw new Error(result.stderr || 'remote write failed')
  return {
    host: opsHostView(host),
    path: target,
    operation: before === null ? 'create' : 'update',
    before,
    after: content,
  }
}

/**
 * Whether a remote error says the path is not there. A bare SFTP code reads the
 * same for a typo and for a moved directory, so workspace registration turns it
 * into a hint instead of forwarding it.
 *
 * The numeric SFTP status wins when there is one: servers localise the message,
 * so matching English text misses a `NO_SUCH_FILE` from a non-English sshd.
 */
export function isRemoteMissing(error: unknown): boolean {
  return isSftpMissing(error)
}

/** `/` covers every remote path, and a workspace-write bind of it replaces the read-only root. */
function refuseFilesystemRoot(remotePath: string, host: HostConfig): void {
  if (normalizeRemoteDirectory(remotePath) !== '/') return
  throw new Error(`refusing to register "/": a workspace rooted at the remote filesystem root covers every path on ${hostLabel(host)}`)
}

/** Absolute remote paths only. A leading `~/` expands against the remote home. */
async function resolveOpsPath(hostApi: ToolHost, host: HostConfig, secret: SecretMaterial, requested: string, field = 'file_path'): Promise<string> {
  const path = requested.trim()
  if (path.length === 0) throw new Error(`${field} is required`)
  if (posix.isAbsolute(path)) return posix.normalize(path)
  if (path === '~') return remoteHome(hostApi, host, secret)
  if (path.startsWith('~/')) {
    const home = await remoteHome(hostApi, host, secret)
    return posix.normalize(posix.join(home, path.slice(2)))
  }
  throw new Error(`${field} must be an absolute remote path or start with "~/": ${requested}`)
}

/**
 * A full probe uploads ripgrep and checks the sandbox, which ops does not
 * need. Login shells also print on stdout, so the home is the absolute path
 * between markers; anything else is not cached.
 */
const homes = new Map<string, Promise<string>>()

export function forgetOpsHost(hostId: string): void {
  homes.delete(hostId)
}

async function remoteHome(hostApi: ToolHost, host: HostConfig, secret: SecretMaterial): Promise<string> {
  const cached = homes.get(host.id)
  if (cached !== undefined) return cached
  const pending = (async () => {
    const command = `printf '%s\\n' ${shJoin([HOME_BEGIN])} "$HOME" ${shJoin([HOME_END])}`
    const result = await hostApi.pool.exec(host, secret, command, 10_000)
    const home = result.code === 0 ? parseRemoteHome(result.stdout) : undefined
    if (home === undefined) throw new Error('cannot resolve "~": the remote home directory is unknown')
    return home
  })()
  homes.set(host.id, pending)
  pending.catch(() => {
    if (homes.get(host.id) === pending) homes.delete(host.id)
  })
  return pending
}

function parseRemoteHome(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/)
  for (let index = 0; index < lines.length - 2; index += 1) {
    if (lines[index] !== HOME_BEGIN || lines[index + 2] !== HOME_END) continue
    const home = lines[index + 1] ?? ''
    if (posix.isAbsolute(home)) return home
  }
  return undefined
}

/* ------------------------------------------------------------------------- *
 * ssh_upload / ssh_download
 *
 * One file, either direction. Both are write-class ops: an upload replaces a
 * remote file and a download creates a local one, so an `ask` host needs the
 * session's danger-full-access or a one-shot approval.
 *
 * Symlink policy is the same on both ends: the final component must not be a
 * symbolic link. `resolveCreatedPath` would realpath a live symlink to its
 * target — and then `mv -f` would replace the link's referent, not the link —
 * so upload checks with `lstat` first and never follows the last component.
 * Intermediate directories are ordinary path components and may be links.
 * ------------------------------------------------------------------------- */



function transferDeadline(exec: ToolExec, limits: OpsTransferLimits): AbortSignal | undefined {
  if (limits.timeoutMs <= 0) return exec.signal
  const timeout = AbortSignal.timeout(limits.timeoutMs)
  return exec.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout])
}

/**
 * Name a timeout instead of forwarding a bare `AbortError`.
 *
 * A cancellation and this deadline both end as `AbortError`, and the model
 * cannot tell them apart. The caller's own signal is the discriminator: if it
 * did not abort, the deadline was the only thing that could have. A
 * cancellation therefore keeps its own error and a deadline is renamed.
 */
function transferAbortError(cancelSignal: AbortSignal | undefined, limits: OpsTransferLimits, error: unknown): unknown {
  if (limits.timeoutMs <= 0) return error
  if (!(error instanceof Error) || error.name !== 'AbortError') return error
  if (cancelSignal?.aborted === true) return error
  const timedOut = new Error(`transfer timed out after ${limits.timeoutMs} ms (the deadline is the "Transfer timeout" setting; 0 means unlimited)`)
  timedOut.name = 'TimeoutError'
  return timedOut
}

/** A local path is platform-native: Windows accepts `C:\x`, POSIX accepts `/x`. */
function requireLocalPath(value: unknown, field = 'local_path'): string {
  const requested = String(value ?? '').trim()
  if (requested.length === 0) throw new Error(`${field} is required`)
  if (!isAbsolute(requested)) {
    throw new Error(`${field} must be an absolute path on the machine running DSH: ${requested}`)
  }
  return requested
}

/**
 * Refuse a local path that is not a regular file, and one already over the ceiling.
 *
 * The size is only a pre-check. The stream counts the bytes it reads, so a
 * file that grows afterwards is still stopped without being buffered.
 */
async function assertLocalSource(path: string, maxBytes: number): Promise<void> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') throw new Error(`no such local file: ${path}`)
    throw new Error(`cannot read local file ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (info.isSymbolicLink()) throw new Error(`refusing to transfer a symbolic link: ${path}`)
  if (info.isDirectory()) throw new Error(`local path is a directory: ${path}`)
  if (!info.isFile()) throw new Error(`local path is not a regular file: ${path}`)
  if (maxBytes > 0 && info.size > maxBytes) {
    throw new Error(`local file is ${info.size} bytes, over the ${maxBytes} byte transfer ceiling`)
  }
}

/**
 * Classify the remote target without following the final component.
 *
 * A server that omits SSH_FILEXFER_ATTR_PERMISSIONS gets its type derived by
 * `attrsOf` (readlink, directory probe, then the login shell), so `other`
 * really means "FIFO/device/socket or unknowable" and must be refused. A
 * plain `stat` cannot make that distinction: its `type` stays `undefined`.
 */
async function remoteTargetOf(
  hostApi: ToolHost,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  follow: boolean,
  signal: AbortSignal | undefined,
): Promise<{ type: 'file' | 'directory' | 'symlink' | 'other', size: number, mode?: number } | undefined> {
  try {
    return await withSignal(hostApi.pool.sftpAttrs(host, secret, remotePath, follow), signal)
  } catch (error) {
    if (signal?.aborted === true) throw error
    if (isSftpMissing(error)) return undefined
    throw error
  }
}

/**
 * Race one transfer step against the deadline.
 *
 * `pool.exec` returns a promise that only settles when the channel does, and a
 * cancelled channel can still take up to two seconds to report. Racing the
 * deadline here means a timed-out transfer rejects promptly even if the step
 * itself never settles. A real cancellation keeps its own `AbortError`;
 * `transferAbortError` only renames the deadline case.
 */
async function withTransferDeadline<T>(
  work: Promise<T>,
  deadline: AbortSignal | undefined,
  cancelSignal: AbortSignal | undefined,
  limits: OpsTransferLimits,
): Promise<T> {
  if (deadline === undefined || limits.timeoutMs <= 0) {
    try {
      return await work
    } catch (error) {
      throw transferAbortError(cancelSignal, limits, error)
    }
  }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError())
    if (deadline.aborted) onAbort()
    else deadline.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } catch (error) {
    throw transferAbortError(cancelSignal, limits, error)
  } finally {
    if (onAbort !== undefined) deadline.removeEventListener('abort', onAbort)
    // The losing promise must not surface as an unhandled rejection.
    work.catch(() => undefined)
  }
}

/**
 * A bare `throwIfAborted(signal)` between transfer steps cannot tell the
 * deadline from a user cancellation: both abort the same combined signal, so a
 * timeout would surface as `AbortError` ("tool call aborted") and the model
 * would retry instead of raising the "Transfer timeout" setting. Every check
 * that runs while the deadline is live goes through here.
 */
function throwIfTransferAborted(
  signal: AbortSignal | undefined,
  cancelSignal: AbortSignal | undefined,
  limits: OpsTransferLimits,
): void {
  if (signal?.aborted !== true) return
  throw transferAbortError(cancelSignal, limits, abortError())
}

export async function runSshUpload(
  hostApi: ToolHost,
  host: HostConfig,
  args: Record<string, unknown>,
  exec: ToolExec,
  limits: OpsTransferLimits = NO_TRANSFER_LIMITS,
): Promise<Record<string, unknown>> {
  const localPath = requireLocalPath(args.local_path)
  const remoteRequest = String(args.remote_path ?? '').trim()
  if (remoteRequest.length === 0) throw new Error('remote_path is required')
  await requireOps(
    hostApi,
    host,
    exec,
    args as OpsApprovalArgs,
    'ssh_upload',
    hostSubject(host, 'remote file upload'),
    {
      en: `upload ${clip(localPath, 120)} to ${clip(remoteRequest, 120)} on ${hostLabel(host)}`,
      zh: `把 ${clip(localPath, 120)} 上传到 ${hostLabel(host)} 的 ${clip(remoteRequest, 120)}`,
    },
  )
  throwIfAborted(exec.signal)
  const signal = transferDeadline(exec, limits)
  await assertLocalSource(localPath, limits.maxBytes)
  const secret = await withTransferDeadline(hostApi.secretOf(host), signal, exec.signal, limits)
  throwIfTransferAborted(signal, exec.signal, limits)
  // `resolveOpsPath` runs the remote `$HOME` probe for `~/`; racing it here
  // makes a slow probe obey the transfer deadline. The probe itself cannot be
  // cancelled mid-flight, so it may finish in the background and stay cached.
  const remotePath = await withTransferDeadline(
    resolveOpsPath(hostApi, host, secret, remoteRequest, 'remote_path'),
    signal,
    exec.signal,
    limits,
  )
  // Same refusal as the download side: `/` is never a file, and the atomic
  // script would only report it as "remote path is a directory" after a
  // round trip. Naming the real problem here is clearer and symmetric.
  if (posix.normalize(remotePath) === '/') throw new Error('remote_path must name a file, not the filesystem root')
  const existing = await withTransferDeadline(
    remoteTargetOf(hostApi, host, secret, remotePath, false, signal),
    signal,
    exec.signal,
    limits,
  )
  if (existing !== undefined && existing.type !== 'file') {
    throw new Error(`remote path is not a regular file (${existing.type}): ${remotePath}`)
  }
  const directory = posix.dirname(remotePath)
  const tmp = posix.join(directory, `.dsh-permission-remote-${randomBytes(8).toString('hex')}`)
  const mkdir = await withTransferDeadline(
    hostApi.pool.exec(host, secret, `mkdir -p ${shJoin([directory])}`, limits.timeoutMs, signal),
    signal,
    exec.signal,
    limits,
  )
  if (mkdir.code !== 0) throw new Error(mkdir.stderr || 'remote upload failed')
  let bytes = 0
  try {
    bytes = await withTransferDeadline(
      hostApi.pool.sftpSendLocal(host, secret, localPath, tmp, { maxBytes: limits.maxBytes, signal }),
      signal,
      exec.signal,
      limits,
    )
    const bits = existing?.mode === undefined ? '' : ` && chmod ${(existing.mode & 0o7777).toString(8)} ${shJoin([remotePath])}`
    const moved = await withTransferDeadline(
      hostApi.pool.exec(host, secret, `mv -f ${shJoin([tmp, remotePath])}${bits}`, limits.timeoutMs, signal),
      signal,
      exec.signal,
      limits,
    )
    if (moved.code !== 0) throw new Error(moved.stderr || 'remote upload failed')
  } catch (error) {
    await hostApi.pool.exec(host, secret, `rm -f ${shJoin([tmp])}`, limits.timeoutMs, signal).catch(() => undefined)
    throw error
  }
  return {
    host: opsHostView(host),
    localPath,
    remotePath,
    bytes,
    operation: existing === undefined ? 'create' : 'update',
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs,
  }
}

export function renderOpsUpload(value: Record<string, unknown>): string {
  const host = value.host as OpsHostView | undefined
  const label = host === undefined ? 'remote host' : host.name || host.address
  const bytes = typeof value.bytes === 'number' ? value.bytes : 0
  const action = value.operation === 'update' ? 'updated' : 'created'
  const limits = transferLimitText(value)
  return `uploaded ${String(value.localPath ?? '')} → ${String(value.remotePath ?? '')} on ${label} (${bytes} bytes, ${action}${limits})`
}

export async function runSshDownload(
  hostApi: ToolHost,
  host: HostConfig,
  args: Record<string, unknown>,
  exec: ToolExec,
  limits: OpsTransferLimits = NO_TRANSFER_LIMITS,
): Promise<Record<string, unknown>> {
  const localPath = requireLocalPath(args.local_path)
  const remoteRequest = String(args.remote_path ?? '').trim()
  if (remoteRequest.length === 0) throw new Error('remote_path is required')
  await requireOps(
    hostApi,
    host,
    exec,
    args as OpsApprovalArgs,
    'ssh_download',
    hostSubject(host, 'remote file download'),
    {
      en: `download ${clip(remoteRequest, 120)} from ${hostLabel(host)} to ${clip(localPath, 120)}`,
      zh: `把 ${hostLabel(host)} 的 ${clip(remoteRequest, 120)} 下载到 ${clip(localPath, 120)}`,
    },
  )
  throwIfAborted(exec.signal)
  const signal = transferDeadline(exec, limits)
  const secret = await withTransferDeadline(hostApi.secretOf(host), signal, exec.signal, limits)
  // See the upload side: a `~/` home probe must not outlive the transfer
  // deadline just because it has no signal of its own.
  const remotePath = await withTransferDeadline(
    resolveOpsPath(hostApi, host, secret, remoteRequest, 'remote_path'),
    signal,
    exec.signal,
    limits,
  )
  if (posix.normalize(remotePath) === '/') throw new Error('remote_path must name a file, not the filesystem root')
  // Check the destination before pulling any bytes, so a bad local path fails
  // before a large read. It runs after the gate on purpose: a denied or
  // unapproved call must not probe the local filesystem either.
  await assertLocalTarget(localPath)
  const info = await withTransferDeadline(
    remoteTargetOf(hostApi, host, secret, remotePath, false, signal),
    signal,
    exec.signal,
    limits,
  )
  if (info === undefined) throw new Error(`no file at remote path: ${remotePath}`)
  if (info.type !== 'file') {
    throw new Error(`remote path is not a regular file (${info.type}): ${remotePath}`)
  }
  if (limits.maxBytes > 0 && info.size > limits.maxBytes) {
    throw new Error(`remote file is ${info.size} bytes, over the ${limits.maxBytes} byte transfer ceiling`)
  }
  throwIfTransferAborted(signal, exec.signal, limits)
  const temporary = `${localPath}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const handle = await openExclusiveTemp(temporary)
  let bytes = 0
  try {
    // The chunk generator only notices the signal between reads, and it
    // reports that as an SFTP failure. Racing the deadline here makes a hung
    // read return on time, and an abort that arrives as that SFTP failure is
    // turned back into `AbortError` so the deadline can name it a timeout.
    await withTransferDeadline((async () => {
      try {
        for await (const chunk of hostApi.pool.sftpReadChunks(host, secret, remotePath, signal)) {
          throwIfTransferAborted(signal, exec.signal, limits)
          bytes += chunk.length
          if (limits.maxBytes > 0 && bytes > limits.maxBytes) {
            throw new Error(`remote file is over the ${limits.maxBytes} byte transfer ceiling`)
          }
          await handle.write(chunk)
        }
      } catch (error) {
        if (signal?.aborted === true) throw abortError()
        throw error
      }
    })(), signal, exec.signal, limits)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await handle.close()
  try {
    await renameReplacing(temporary, localPath)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  return {
    host: opsHostView(host),
    remotePath,
    localPath,
    bytes,
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs,
  }
}

const WINDOWS_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM'])

/**
 * Exclusive create at mode `0600`.
 *
 * `wx` refuses to follow a symlink planted on the temp path and does not
 * reuse a leftover inode, so the mode on that inode is the one `rename`
 * publishes. `'w'` would truncate either target and keep a leftover's mode.
 */
export function openExclusiveTemp(path: string): Promise<FileHandle> {
  return open(path, 'wx', 0o600)
}

/**
 * `rename` over the target, retrying the transient Windows errors that
 * `writeFileAtomic` retries. The temp file stays the source until one
 * attempt succeeds.
 */
export async function renameReplacing(from: string, to: string): Promise<void> {
  let delay = 20
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const transient = process.platform === 'win32' && code !== undefined && WINDOWS_RENAME_ERRORS.has(code)
      if (!transient || attempt >= 8) throw error
      await new Promise(resolve => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 200)
    }
  }
}

/** A download never creates a directory tree: the parent must already be one. */
async function assertLocalTarget(localPath: string): Promise<void> {
  const parent = dirnameLocal(localPath)
  if (parent.length > 0 && parent !== localPath) {
    const parentInfo = await stat(parent).catch(() => undefined)
    if (parentInfo === undefined) throw new Error(`local parent directory does not exist: ${parent}`)
    if (!parentInfo.isDirectory()) throw new Error(`local parent is not a directory: ${parent}`)
  }
  const existing = await lstat(localPath).catch(() => undefined)
  if (existing === undefined) return
  if (existing.isDirectory()) throw new Error(`local path is a directory: ${localPath}`)
  if (existing.isSymbolicLink()) throw new Error(`refusing to write through a symbolic link: ${localPath}`)
}

export function renderOpsDownload(value: Record<string, unknown>): string {
  const host = value.host as OpsHostView | undefined
  const label = host === undefined ? 'remote host' : host.name || host.address
  const bytes = typeof value.bytes === 'number' ? value.bytes : 0
  const limits = transferLimitText(value)
  return `downloaded ${String(value.remotePath ?? '')} from ${label} → ${String(value.localPath ?? '')} (${bytes} bytes${limits})`
}

/** State the ceilings that actually applied, so `0` reads as "unlimited". */
function transferLimitText(value: Record<string, unknown>): string {
  const maxBytes = typeof value.maxBytes === 'number' ? value.maxBytes : 0
  const timeoutMs = typeof value.timeoutMs === 'number' ? value.timeoutMs : 0
  const ceiling = maxBytes > 0 ? `${maxBytes} byte ceiling` : 'no byte ceiling'
  const deadline = timeoutMs > 0 ? `${timeoutMs} ms timeout` : 'no timeout'
  return `; ${ceiling}, ${deadline}`
}
