import { randomBytes } from 'node:crypto'
import { lstat, open, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import { dirname as dirnameLocal, isAbsolute, posix, win32 } from 'node:path'
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
import { isRemotePlaceholderPath, normalizeRemoteDirectory, routeByCwd } from './router.ts'
import { shJoin } from './shell-quote.ts'
import { CLEANUP_SETTLE_TIMEOUT_MS, isSftpMissing, settleWithin, type SecretMaterial } from './ssh-pool.ts'

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
  requireReadable(host)
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

/**
 * The read gate: a host the operator blocked, or one whose fingerprint is not
 * trusted yet, is refused before any IO. Reading is not gated on approval, so
 * this is all `ssh_read` and a copy's *source* side need.
 */
export function requireReadable(host: HostConfig): void {
  if (host.opsPolicy === 'deny') throw new Error(`remote ops are disabled for SSH host ${hostLabel(host)}`)
  requireTrusted(host)
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
  const normalizedWorkdir = workdir.length > 0 ? posix.normalize(workdir) : ''
  const where = normalizedWorkdir.length > 0 ? ` (workdir ${clip(normalizedWorkdir, 80)})` : ''
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
  const wrapped = normalizedWorkdir.length > 0 ? `cd ${shJoin([normalizedWorkdir])} && ${inner}` : inner
  const result = await hostApi.pool.exec(host, secret, wrapped, timeoutMs, exec.signal)
  return {
    kind: 'foreground',
    host: opsHostView(host),
    workdir: normalizedWorkdir.length > 0 ? normalizedWorkdir : null,
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
  requireReadable(host)
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
  requireReadable(host)
  throwIfAborted(exec?.signal)
  const secret = await hostApi.secretOf(host)
  const remotePath = await resolveOpsPath(hostApi, host, secret, requested, 'directory')
  refuseFilesystemRoot(remotePath, host)
  // RegisterWorkspace stores the host's realpath. Resolve it before approval so
  // the card names the same directory that will actually be registered. A
  // missing path is left unchanged here: registerWorkspace reports the useful
  // "remote directory not found" error.
  let resolved = remotePath
  try {
    resolved = await withSignal(hostApi.pool.sftpRealpath(host, secret, remotePath), exec?.signal)
  } catch (error) {
    if (!isSftpMissing(error)) throw error
  }
  const display = remotePathForDisplay(resolved, 'directory')
  const displayZh = remotePathForDisplay(resolved, 'directory', undefined, '远端 $HOME')
  await requireOps(
    hostApi,
    host,
    exec ?? {},
    args as OpsApprovalArgs,
    'ssh_workspace',
    hostSubject(host, 'remote workspace registration'),
    {
      en: `register workspace ${clip(display)} on ${hostLabel(host)}. This adds a sidebar workspace the user can open onto that machine. This session does not enter it`,
      zh: `在 ${hostLabel(host)} 上注册工作区 ${clip(displayZh)}。侧栏会多出一个可打开的远端工作区，打开后的会话在那台机器上。这个会话不会进入`,
    },
  )
  throwIfAborted(exec?.signal)
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
  requireReadable(host)
  throwIfAborted(exec.signal)
  const secret = await hostApi.secretOf(host)
  const requested = await resolveOpsPath(hostApi, host, secret, requestedRaw)
  // resolveCreatedPath follows parent-directory symlinks (the actual write
  // target). Resolve it once and use the same path for the card and the write:
  // a second call would be an extra round trip and a TOCTOU gap between the
  // path the user approved and the path that is written. Reads are allowed
  // without approval on an `ask` host, so this read-only probe before the gate
  // is permitted by policy (unlike probing the *local* filesystem).
  const target = await withSignal(resolveCreatedPath(hostApi.pool, host, secret, requested), exec.signal)
  const display = remotePathForDisplay(target, 'file_path')
  const displayZh = remotePathForDisplay(target, 'file_path', undefined, '远端 $HOME')
  await requireOps(
    hostApi,
    host,
    exec,
    args as OpsApprovalArgs,
    'ssh_write',
    hostSubject(host, 'remote file write'),
    {
      en: `write ${clip(display)} on ${hostLabel(host)}`,
      zh: `在 ${hostLabel(host)} 上写入 ${clip(displayZh)}`,
    },
  )
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

/**
 * A display spelling for an approval card.
 *
 * The card must describe the path the operation will use, not merely echo the
 * request: `/a/../b` is `/b`, and a relative source is anchored on the remote
 * cwd. `~` cannot be expanded without a remote home probe, so it is labelled
 * instead of silently displayed as if it were already absolute. A relative
 * path with no `base` is rejected before the approval card, with the same
 * message `resolveOpsPath` uses.
 */
function remotePathForDisplay(requested: string, field: string, base?: string, homeLabel = 'remote $HOME'): string {
  const path = requested.trim()
  if (path.length === 0) throw new Error(`${field} is required`)
  if (posix.isAbsolute(path)) return posix.normalize(path)
  if (path === '~' || path.startsWith('~/')) {
    const rest = path === '~' ? '' : path.slice(2)
    if (rest.split('/').includes('..')) {
      throw new Error(`${field} must not contain '..' after "~/" (the remote home is not known before approval): ${requested}`)
    }
    return `${path} (${homeLabel})`
  }
  if (base === undefined) {
    throw new Error(`${field} must be an absolute remote path or start with "~/": ${requested}`)
  }
  return posix.normalize(posix.join(base, path))
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
 * Refuse a local path that names the remote workspace's placeholder namespace.
 *
 * A remote session's `read` and file tree return paths under the placeholder
 * root, and that tree exists on this computer as an empty directory skeleton.
 * Handing one to a local transfer fails as "no such local file" after the
 * approval card was already shown, and if the same name happens to exist
 * locally — a delivery snapshot, a previous download — the copy silently moves
 * the *local* file instead. Both outcomes are worse than a refusal, so this
 * check runs before the approval gate.
 */
function refusePlaceholderSource(localPath: string, toolName: 'ssh_upload' | 'ssh_download'): void {
  if (!isRemotePlaceholderPath(localPath)) return
  const route = routeByCwd(localPath)
  const where = route.kind === 'remote' ? ` (host ${route.hostId}, remote directory ${route.remoteCwd})` : ''
  const advice = toolName === 'ssh_upload'
    ? 'to move a file from one SSH host to another, use ssh_copy; otherwise pass an absolute path to a real file on the machine running DSH'
    : 'choose an absolute path on the machine running DSH; to move a file to another SSH host, use ssh_copy'
  throw new Error(`local_path is a remote workspace placeholder path on this computer, which holds no remote bytes${where}: ${localPath}. ${advice}`)
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
    return await withSignal(hostApi.pool.sftpAttrs(host, secret, remotePath, follow, signal), signal)
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
  if (deadline === undefined) {
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
  // Before the approval gate: the user must not approve a copy that cannot
  // work, or that would move a different local file than the model named.
  refusePlaceholderSource(localPath, 'ssh_upload')
  const display = remotePathForDisplay(remoteRequest, 'remote_path')
  const displayZh = remotePathForDisplay(remoteRequest, 'remote_path', undefined, '远端 $HOME')
  await requireOps(
    hostApi,
    host,
    exec,
    args as OpsApprovalArgs,
    'ssh_upload',
    hostSubject(host, 'remote file upload'),
    {
      en: `upload ${clip(localPath, 120)} to ${clip(display, 120)} on ${hostLabel(host)}`,
      zh: `把 ${clip(localPath, 120)} 上传到 ${hostLabel(host)} 的 ${clip(displayZh, 120)}`,
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
  // One channel that belongs to this transfer only. A hung SFTP callback is
  // closed here without touching the host's terminals, `ssh_exec`, or the PTC
  // worker, and `rm` runs only after that close so a late SFTP `OPEN` cannot
  // recreate the temporary file afterwards.
  const lease = await withTransferDeadline(
    hostApi.pool.openSftpLease(host, secret, signal),
    signal,
    exec.signal,
    limits,
  )
  let bytes = 0
  const sending = hostApi.pool.sftpSendLocalOn(lease, localPath, tmp, { maxBytes: limits.maxBytes, signal })
  try {
    bytes = await withTransferDeadline(sending, signal, exec.signal, limits)
    await lease.close()
    const bits = existing?.mode === undefined ? '' : ` && chmod ${(existing.mode & 0o7777).toString(8)} ${shJoin([remotePath])}`
    const moved = await withTransferDeadline(
      hostApi.pool.exec(host, secret, `mv -f ${shJoin([tmp, remotePath])}${bits}`, limits.timeoutMs, signal),
      signal,
      exec.signal,
      limits,
    )
    if (moved.code !== 0) throw new Error(moved.stderr || 'remote upload failed')
  } catch (error) {
    await settleWithin(lease.close(), CLEANUP_SETTLE_TIMEOUT_MS)
    await settleWithin(hostApi.pool.exec(host, secret, `rm -f ${shJoin([tmp])}`, 15_000), CLEANUP_SETTLE_TIMEOUT_MS)
    throw error
  } finally {
    void lease.close()
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
  refusePlaceholderSource(localPath, 'ssh_download')
  const display = remotePathForDisplay(remoteRequest, 'remote_path')
  const displayZh = remotePathForDisplay(remoteRequest, 'remote_path', undefined, '远端 $HOME')
  await requireOps(
    hostApi,
    host,
    exec,
    args as OpsApprovalArgs,
    'ssh_download',
    hostSubject(host, 'remote file download'),
    {
      en: `download ${clip(display, 120)} from ${hostLabel(host)} to ${clip(localPath, 120)}`,
      zh: `把 ${hostLabel(host)} 的 ${clip(displayZh, 120)} 下载到 ${clip(localPath, 120)}`,
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
  let lease: Awaited<ReturnType<typeof hostApi.pool.openSftpLease>> | undefined
  try {
    lease = await withTransferDeadline(
      hostApi.pool.openSftpLease(host, secret, signal),
      signal,
      exec.signal,
      limits,
    )
    // The chunk generator only notices the signal between reads, and it
    // reports that as an SFTP failure. Racing the deadline here makes a hung
    // read return on time, and an abort that arrives as that SFTP failure is
    // turned back into `AbortError` so the deadline can name it a timeout.
    const reader = lease
    await withTransferDeadline((async () => {
      try {
        for await (const chunk of hostApi.pool.sftpReadChunksOn(reader, remotePath, signal)) {
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
    await settleWithin(lease === undefined ? Promise.resolve() : lease.close(), CLEANUP_SETTLE_TIMEOUT_MS)
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  } finally {
    void lease?.close()
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

/* ─────────── ssh_copy ───────────
 *
 * Remote A → remote B, one file. The bytes stream from the source host's SFTP
 * channel straight into the target host's SFTP channel: they never land on the
 * machine running DSH and never sit in memory as a whole file.
 *
 * This exists because a session inside a remote workspace has no local path to
 * work from. `ssh_upload` reads the machine running DSH by definition; in that
 * session the only file the model can name lives on A, and A's bytes are not on
 * this computer. Widening `ssh_upload` would give `local_path` two meanings,
 * and the quiet failure mode of that is uploading a same-named local file.
 *
 * Gates: the source side follows `ssh_read` (deny and untrusted refuse, no
 * approval), the target side follows `ssh_write` (deny, untrusted, and the
 * `ask` approval). Cards name both ends.
 * ─────────────────────────────── */

/**
 * Resolve one path against a remote workspace, for copy's source side.
 *
 * Absolute remote paths are taken as they are. `~` needs the remote home, and a
 * relative path is anchored on the remote directory the session is in. A
 * placeholder path is never resolved here: it names a remote host and path pair,
 * which the caller has to pull apart first.
 */
async function resolveCopyPath(
  hostApi: ToolHost,
  host: HostConfig,
  secret: SecretMaterial,
  requested: string,
  base: string | undefined,
  field: string,
): Promise<string> {
  const path = requested.trim()
  if (path.length === 0) throw new Error(`${field} is required`)
  if (posix.isAbsolute(path)) return posix.normalize(path)
  // A Windows drive/UNC path is absolute to `path.isAbsolute` but not to
  // `posix.isAbsolute`. Treating it as relative would silently join it under
  // the remote cwd; reject it instead so a local path never becomes a remote one.
  if (win32.isAbsolute(path)) {
    throw new Error(`${field} must be an absolute remote path or start with "~/": ${requested} (Windows local paths are not remote paths; use ssh_upload for local files)`)
  }
  if (path === '~' || path.startsWith('~/')) return resolveOpsPath(hostApi, host, secret, path, field)
  if (base === undefined) {
    throw new Error(`${field} is relative and there is no remote directory to resolve it against; pass an absolute remote path or start it with "~/"`)
  }
  return posix.normalize(posix.join(base, path))
}

/**
 * Resolve the source host and path of one copy.
 *
 * A placeholder path carries its own host in the second segment, so it wins over
 * an omitted `source_host` and is checked against an explicit one. Otherwise an
 * explicit `source_host` is used, and a last resort is the host this session's
 * working directory routes to. The copy's source may be a different host from
 * the session's — that is the point of the tool — so nothing here requires them
 * to match.
 */
function resolveCopySource(
  resolveHost: (selector: string) => HostConfig,
  args: Record<string, unknown>,
  currentCwd: string | undefined,
): { hostId: string, request: string, base: string | undefined } {
  const request = String(args.source_path ?? '').trim()
  if (request.length === 0) throw new Error('source_path is required')
  const explicit = typeof args.source_host === 'string' ? args.source_host.trim() : ''
  // `isRemotePlaceholderPath` already checks absoluteness with the native
  // rules: a placeholder is a Windows path on Windows, which `posix.isAbsolute`
  // would reject and drop through to "treat it as a remote path".
  if (isRemotePlaceholderPath(request)) {
    const route = routeByCwd(request)
    if (route.kind !== 'remote') throw new Error(`source_path is not a usable placeholder path: ${request}`)
    if (explicit.length > 0) {
      const named = resolveHost(explicit)
      if (named.id !== route.hostId) {
        throw new Error(`source_host ${named.id} does not match the placeholder path, which belongs to ${route.hostId}; drop source_host or correct it`)
      }
      return { hostId: named.id, request: route.remoteCwd, base: undefined }
    }
    return { hostId: route.hostId, request: route.remoteCwd, base: undefined }
  }
  if (explicit.length > 0) {
    const named = resolveHost(explicit)
    return { hostId: named.id, request, base: undefined }
  }
  const route = routeByCwd(currentCwd)
  if (route.kind === 'remote') return { hostId: route.hostId, request, base: route.remoteCwd }
  throw new Error('source_host is required: this session is not in a remote workspace, so there is no current SSH host to copy from. Pass source_host, or pass a placeholder source_path')
}

/** The target path, including a placeholder spelling that has to belong to the target host. */
function copyTargetRequest(target: HostConfig, raw: string): string {
  const request = raw.trim()
  if (request.length === 0) throw new Error('target_path is required')
  if (!isRemotePlaceholderPath(request)) return request
  const route = routeByCwd(request)
  if (route.kind !== 'remote') throw new Error(`target_path is not a usable placeholder path: ${request}`)
  if (route.hostId !== target.id) {
    throw new Error(`target_path belongs to SSH host ${route.hostId}, but target_host is ${target.id}; copy to that host explicitly instead`)
  }
  return route.remoteCwd
}

export async function runSshCopy(
  hostApi: ToolHost,
  target: HostConfig,
  args: Record<string, unknown>,
  exec: ToolExec,
  resolveHost: (selector: string) => HostConfig,
  limits: OpsTransferLimits = NO_TRANSFER_LIMITS,
  currentCwd?: string,
): Promise<Record<string, unknown>> {
  const sourceRef = resolveCopySource(resolveHost, args, currentCwd)
  const source = resolveHost(sourceRef.hostId)
  const targetRequest = copyTargetRequest(target, String(args.target_path ?? ''))
  if (!posix.isAbsolute(targetRequest) && !win32.isAbsolute(targetRequest) && targetRequest !== '~' && !targetRequest.startsWith('~/')) {
    throw new Error(`target_path must be an absolute remote path or start with "~/": ${targetRequest}`)
  }
  if (win32.isAbsolute(targetRequest) && !posix.isAbsolute(targetRequest)) {
    throw new Error(`target_path must be an absolute remote path or start with "~/": ${targetRequest} (Windows local paths are not remote paths; use ssh_upload for local files)`)
  }
  if (win32.isAbsolute(sourceRef.request) && !posix.isAbsolute(sourceRef.request)) {
    throw new Error(`source_path must be an absolute remote path or start with "~/": ${sourceRef.request} (Windows local paths are not remote paths; use ssh_upload for local files)`)
  }
  const poolLimit = (hostApi.pool as { maxConnections?: number }).maxConnections
  if (source.id !== target.id && typeof poolLimit === 'number' && poolLimit < 2) {
    throw new Error(`ssh_copy between different hosts needs maxConnections >= 2; current maxConnections is ${poolLimit}`)
  }
  // Read gate, then write gate. Both run before any IO so a blocked or
  // untrusted host never opens a connection, and the approval card lands only
  // when the copy could actually proceed.
  requireReadable(source)
  const sourceDisplay = remotePathForDisplay(sourceRef.request, 'source_path', sourceRef.base)
  const sourceDisplayZh = remotePathForDisplay(sourceRef.request, 'source_path', sourceRef.base, '远端 $HOME')
  const targetDisplay = remotePathForDisplay(targetRequest, 'target_path')
  const targetDisplayZh = remotePathForDisplay(targetRequest, 'target_path', undefined, '远端 $HOME')
  await requireOps(
    hostApi,
    target,
    exec,
    args as OpsApprovalArgs,
    'ssh_copy',
    hostSubject(target, 'remote file copy'),
    {
      en: `copy ${clip(sourceDisplay, 80)} on ${hostLabel(source)} to ${clip(targetDisplay, 80)} on ${hostLabel(target)}`,
      zh: `把 ${hostLabel(source)} 的 ${clip(sourceDisplayZh, 80)} 复制到 ${hostLabel(target)} 的 ${clip(targetDisplayZh, 80)}`,
    },
  )
  throwIfAborted(exec.signal)
  const signal = transferDeadline(exec, limits)
  const sourceSecret = await withTransferDeadline(hostApi.secretOf(source), signal, exec.signal, limits)
  const targetSecret = await withTransferDeadline(hostApi.secretOf(target), signal, exec.signal, limits)
  const sourcePath = await withTransferDeadline(
    resolveCopyPath(hostApi, source, sourceSecret, sourceRef.request, sourceRef.base, 'source_path'),
    signal,
    exec.signal,
    limits,
  )
  const targetPath = await withTransferDeadline(
    resolveCopyPath(hostApi, target, targetSecret, targetRequest, undefined, 'target_path'),
    signal,
    exec.signal,
    limits,
  )
  if (posix.normalize(sourcePath) === '/') throw new Error('source_path must name a file, not the filesystem root')
  if (posix.normalize(targetPath) === '/') throw new Error('target_path must name a file, not the filesystem root')
  if (source.id === target.id && sourcePath === targetPath) {
    throw new Error(`source_path and target_path are the same file on ${hostLabel(source)}: ${sourcePath}`)
  }
  const info = await withTransferDeadline(
    remoteTargetOf(hostApi, source, sourceSecret, sourcePath, false, signal),
    signal,
    exec.signal,
    limits,
  )
  if (info === undefined) throw new Error(`no file at source path on ${hostLabel(source)}: ${sourcePath}`)
  if (info.type !== 'file') throw new Error(`source path is not a regular file (${info.type}) on ${hostLabel(source)}: ${sourcePath}`)
  if (limits.maxBytes > 0 && info.size > limits.maxBytes) {
    throw new Error(`source file is ${info.size} bytes, over the ${limits.maxBytes} byte transfer ceiling`)
  }
  const existing = await withTransferDeadline(
    remoteTargetOf(hostApi, target, targetSecret, targetPath, false, signal),
    signal,
    exec.signal,
    limits,
  )
  if (existing !== undefined && existing.type !== 'file') {
    throw new Error(`target path is not a regular file (${existing.type}) on ${hostLabel(target)}: ${targetPath}`)
  }
  const directory = posix.dirname(targetPath)
  const tmp = posix.join(directory, `.dsh-permission-remote-${randomBytes(8).toString('hex')}`)
  const mkdir = await withTransferDeadline(
    hostApi.pool.exec(target, targetSecret, `mkdir -p ${shJoin([directory])}`, limits.timeoutMs, signal),
    signal,
    exec.signal,
    limits,
  )
  if (mkdir.code !== 0) throw new Error(mkdir.stderr || 'remote copy failed')
  // Each leg gets its own SFTP channel; a same-host copy shares one channel
  // (and therefore one connection slot by construction).
  const sourceLease = await withTransferDeadline(
    hostApi.pool.openSftpLease(source, sourceSecret, signal),
    signal,
    exec.signal,
    limits,
  )
  let targetLease: Awaited<ReturnType<typeof hostApi.pool.openSftpLease>>
  try {
    targetLease = source.id === target.id
      ? sourceLease
      : await withTransferDeadline(hostApi.pool.openSftpLease(target, targetSecret, signal), signal, exec.signal, limits)
  } catch (error) {
    await settleWithin(sourceLease.close(), CLEANUP_SETTLE_TIMEOUT_MS)
    throw error
  }
  const chunks = hostApi.pool.sftpReadChunksOn(sourceLease, sourcePath, signal)
  let bytes = 0
  const sending = hostApi.pool.sftpSendChunksOn(targetLease, tmp, chunks, {
    maxBytes: limits.maxBytes,
    signal,
    overflowLabel: 'source file',
  })
  try {
    bytes = await withTransferDeadline(sending, signal, exec.signal, limits)
    if (sourceLease !== targetLease) await sourceLease.close()
    await targetLease.close()
    const bits = existing?.mode === undefined ? '' : ` && chmod ${(existing.mode & 0o7777).toString(8)} ${shJoin([targetPath])}`
    const moved = await withTransferDeadline(
      hostApi.pool.exec(target, targetSecret, `mv -f ${shJoin([tmp, targetPath])}${bits}`, limits.timeoutMs, signal),
      signal,
      exec.signal,
      limits,
    )
    if (moved.code !== 0) throw new Error(moved.stderr || 'remote copy failed')
  } catch (error) {
    // Close both transfer channels (bounded) before `rm`. Only these channels
    // are destroyed; the host's other SFTP work and its SSH connection stay up.
    await settleWithin(sourceLease.close(), CLEANUP_SETTLE_TIMEOUT_MS)
    if (targetLease !== sourceLease) await settleWithin(targetLease.close(), CLEANUP_SETTLE_TIMEOUT_MS)
    await settleWithin(hostApi.pool.exec(target, targetSecret, `rm -f ${shJoin([tmp])}`, 15_000), CLEANUP_SETTLE_TIMEOUT_MS)
    throw error
  } finally {
    void sourceLease.close()
    if (targetLease !== sourceLease) void targetLease.close()
  }
  // A copy that succeeded still owns a closed generator; nothing to release.
  return {
    sourceHost: opsHostView(source),
    sourcePath,
    targetHost: opsHostView(target),
    targetPath,
    bytes,
    operation: existing === undefined ? 'create' : 'update',
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs,
  }
}

export function renderOpsCopy(value: Record<string, unknown>): string {
  const source = value.sourceHost as OpsHostView | undefined
  const target = value.targetHost as OpsHostView | undefined
  const from = source === undefined ? 'remote host' : source.name || source.address
  const to = target === undefined ? 'remote host' : target.name || target.address
  const bytes = typeof value.bytes === 'number' ? value.bytes : 0
  const action = value.operation === 'update' ? 'updated' : 'created'
  const limits = transferLimitText(value)
  return `copied ${from}:${String(value.sourcePath ?? '')} → ${to}:${String(value.targetPath ?? '')} (${bytes} bytes, ${action}${limits})`
}

/** State the ceilings that actually applied, so `0` reads as "unlimited". */
function transferLimitText(value: Record<string, unknown>): string {
  const maxBytes = typeof value.maxBytes === 'number' ? value.maxBytes : 0
  const timeoutMs = typeof value.timeoutMs === 'number' ? value.timeoutMs : 0
  const ceiling = maxBytes > 0 ? `${maxBytes} byte ceiling` : 'no byte ceiling'
  const deadline = timeoutMs > 0 ? `${timeoutMs} ms timeout` : 'no timeout'
  return `; ${ceiling}, ${deadline}`
}
