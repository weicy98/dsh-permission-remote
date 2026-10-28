import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { HostConfig, OpsPolicy } from './config.ts'
import {
  capturedText,
  resolveCreatedPath,
  throwIfAborted,
  withSignal,
  type ToolExec,
  type ToolHost,
} from './execute.ts'
import { atomicWriteScript } from './profile.ts'
import { shJoin } from './shell-quote.ts'
import type { SecretMaterial } from './ssh-pool.ts'

const READ_CAP = 1024 * 1024
const NOT_FOUND = /no such file|cannot find|not found|does not exist/i
const HOME_BEGIN = '__DSH_OPS_HOME_BEGIN__'
const HOME_END = '__DSH_OPS_HOME_END__'

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
  detail?: string,
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
    `command on ${hostLabel(host)}: ${clip(command)}${where}`,
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
  const bytes = await withSignal(hostApi.pool.sftpRead(host, secret, remotePath, READ_CAP), exec?.signal)
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
    `write ${clip(requestedRaw)} on ${hostLabel(host)}`,
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
    before = (await withSignal(hostApi.pool.sftpRead(host, secret, target, READ_CAP), exec.signal)).toString('utf8')
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

function isRemoteMissing(error: unknown): boolean {
  return error instanceof Error && NOT_FOUND.test(error.message)
}

/** Absolute remote paths only. A leading `~/` expands against the remote home. */
async function resolveOpsPath(hostApi: ToolHost, host: HostConfig, secret: SecretMaterial, requested: string): Promise<string> {
  const path = requested.trim()
  if (path.length === 0) throw new Error('file_path is required')
  if (posix.isAbsolute(path)) return posix.normalize(path)
  if (path === '~') return remoteHome(hostApi, host, secret)
  if (path.startsWith('~/')) {
    const home = await remoteHome(hostApi, host, secret)
    return posix.normalize(posix.join(home, path.slice(2)))
  }
  throw new Error(`file_path must be an absolute remote path or start with "~/": ${requested}`)
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
