/**
 * Ops tools for a session whose workspace is not on the remote host.
 *
 * The model names a configured host on every call. Reads are allowed on any
 * host that is not `deny`. Commands and writes are unconfined on the remote,
 * so they need `danger-full-access`: either the session already has it, the
 * host is marked `trust`, or the model retries with `sandbox_permissions` and
 * `justification` and the existing approval card grants this one call.
 */

import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { escalationHintMarker, sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
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

/** Short form for sentences such as the escalation hint and approval prompt. */
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

/**
 * `deny` rejects every call. `trust` skips approval. Otherwise the call runs
 * only when the session mode resolves to `danger-full-access`, which is the
 * session's own mode or a one-shot approval for the supplied escalation args.
 */
export async function requireOps(
  hostApi: ToolHost,
  host: HostConfig,
  exec: ToolExec,
  args: OpsApprovalArgs,
  toolName: string,
  subject: string,
): Promise<void> {
  requireTrusted(host)
  if (host.opsPolicy === 'deny') throw new Error(`remote ops are disabled for SSH host ${hostLabel(host)}`)
  if (host.opsPolicy === 'trust') return
  const mode = await hostApi.resolveMode(exec, args.sandbox_permissions, args.justification, toolName, subject)
  if (mode === 'danger-full-access') return
  throw new Error(`${sandboxDenialMarker(mode)}\n${escalationHintMarker(subject)}`)
}

/** The SSH pool rejects an untrusted host key with a terse verifier error. */
function requireTrusted(host: HostConfig): void {
  if (host.fingerprint.trim().length > 0) return
  throw new Error(`SSH host ${hostLabel(host)} is not trusted yet; open Settings → SSH hosts, test the connection, and trust its fingerprint first`)
}

export async function runSshExec(hostApi: ToolHost, host: HostConfig, args: Record<string, unknown>, exec: ToolExec): Promise<Record<string, unknown>> {
  await requireOps(hostApi, host, exec, args as OpsApprovalArgs, 'ssh_exec', hostSubject(host, 'remote command'))
  const secret = await hostApi.secretOf(host)
  const command = String(args.command ?? '')
  if (command.trim().length === 0) throw new Error('command is required')
  const workdir = typeof args.workdir === 'string' ? args.workdir.trim() : ''
  if (workdir.length > 0 && !posix.isAbsolute(workdir)) throw new Error(`workdir must be an absolute remote path: ${workdir}`)
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

export async function runSshRead(hostApi: ToolHost, host: HostConfig, args: Record<string, unknown>, exec?: ToolExec): Promise<Record<string, unknown>> {
  requireTrusted(host)
  if (host.opsPolicy === 'deny') throw new Error(`remote ops are disabled for SSH host ${hostLabel(host)}`)
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

export async function runSshWrite(hostApi: ToolHost, host: HostConfig, args: Record<string, unknown>, exec: ToolExec): Promise<Record<string, unknown>> {
  await requireOps(hostApi, host, exec, args as OpsApprovalArgs, 'ssh_write', hostSubject(host, 'remote file write'))
  const secret = await hostApi.secretOf(host)
  const requested = await resolveOpsPath(hostApi, host, secret, String(args.file_path ?? ''))
  const target = await resolveCreatedPath(hostApi.pool, host, secret, requested)
  throwIfAborted(exec.signal)
  let before: string | null = null
  try {
    before = (await withSignal(hostApi.pool.sftpRead(host, secret, target, READ_CAP), exec.signal)).toString('utf8')
  } catch (error) {
    if (exec.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')) throw error
    before = null
  }
  const content = String(args.content ?? '')
  const directory = posix.dirname(target)
  const tmp = posix.join(directory, `.dsh-permission-remote-${randomBytes(8).toString('hex')}`)
  const result = await hostApi.pool.exec(host, secret, atomicWriteScript(directory, tmp, target), 20_000, exec.signal, content)
  if (result.code !== 0) throw new Error(result.stderr || 'remote write failed')
  return {
    host: opsHostView(host),
    path: target,
    operation: before === null ? 'create' : 'update',
    before,
    after: content,
  }
}

/** Absolute remote paths only. A leading `~/` expands against the remote home. */
async function resolveOpsPath(hostApi: ToolHost, host: HostConfig, secret: SecretMaterial, requested: string): Promise<string> {
  const path = requested.trim()
  if (path.length === 0) throw new Error('file_path is required')
  if (posix.isAbsolute(path)) return posix.normalize(path)
  if (path === '~' || path.startsWith('~/')) {
    const home = await remoteHome(hostApi, host, secret)
    return posix.join(home, path.slice(1))
  }
  throw new Error(`file_path must be an absolute remote path or start with "~/": ${requested}`)
}

/**
 * A full probe uploads ripgrep and checks the sandbox, which ops does not
 * need. Read the login home with one small command instead.
 */
const homes = new Map<string, Promise<string>>()

export function forgetOpsHost(hostId: string): void {
  homes.delete(hostId)
}

async function remoteHome(hostApi: ToolHost, host: HostConfig, secret: SecretMaterial): Promise<string> {
  const cached = homes.get(host.id)
  if (cached !== undefined) return cached
  const pending = (async () => {
    const result = await hostApi.pool.exec(host, secret, 'printf %s "$HOME"', 10_000)
    const home = result.stdout.trim()
    if (result.code !== 0 || home.length === 0) throw new Error('cannot resolve "~": the remote home directory is unknown')
    return home
  })()
  homes.set(host.id, pending)
  pending.catch(() => homes.delete(host.id))
  return pending
}
