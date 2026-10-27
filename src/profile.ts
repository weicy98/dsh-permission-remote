/**
 * Remote confinement argv copied from @deepseek-ai/dsh-sandbox-local.
 *
 * bwrapProfileArgs and seatbeltProfileArgs are internal to that package
 * (not re-exported from its public entry). The spellings below match
 * lib/index.js of dsh 0.2.1-rc.3.
 *
 * Bash and file writes do not share a temp root: bash workspace-write mounts
 * a private tmpfs on /tmp, while file tools may write the real remote temp dirs.
 */

import { shJoin } from './shell-quote.ts'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface RemoteFileRoots {
  /** Canonical remote workspace root. */
  readonly workspaceRoot: string
  /** Canonical remote /tmp (on macOS this is often /private/tmp). */
  readonly tmp: string
  /** Canonical remote per-user temp directory (os.tmpdir() on that host). */
  readonly userTmp: string
}

/** bwrap arguments before the `--` separator. danger-full-access does not wrap. */
export function bwrapProfileArgs(mode: SandboxMode, workspaceRoot: string): string[] | null {
  if (mode === 'danger-full-access') return null
  const args = bwrapBaseArgs()
  if (mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp', '--bind', workspaceRoot, workspaceRoot)
  }
  return args
}

/**
 * File-tool bwrap profile. workspace-write bind-mounts the real workspace,
 * `/tmp`, and user temp. It does not mount a private tmpfs, so a write the
 * policy allows is still on the remote disk after bwrap exits.
 * Shorter roots are mounted first; a later mount of a longer path stays visible.
 */
export function bwrapFileProfileArgs(mode: SandboxMode, roots: RemoteFileRoots): string[] | null {
  if (mode === 'danger-full-access') return null
  const args = bwrapBaseArgs()
  if (mode === 'workspace-write') {
    const binds = fileWritableRoots(mode, roots).slice().sort((left, right) => left.length - right.length || left.localeCompare(right))
    for (const root of binds) args.push('--bind', root, root)
  }
  return args
}

function bwrapBaseArgs(): string[] {
  return [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent',
  ]
}

/** `cd` happens before `sandbox-exec`, which inherits the calling process directory. */
export function seatbeltBashCommand(mode: SandboxMode, writable: readonly string[], workdir: string, command: string): string {
  const profile = seatbeltProfileArgs(mode, writable) ?? []
  return `cd ${shJoin([workdir])} && ${shJoin(['sandbox-exec', ...profile, '--', 'bash', '-c', command])}`
}

/** Read-only profile used to probe that bwrap can actually create a user namespace. */
export function bwrapProbeArgv(): string[] {
  return ['bwrap', ...bwrapProfileArgs('read-only', '/')!, '--', 'true']
}

/**
 * Seatbelt arguments before `--`. Writable roots are the remote-probed set,
 * not writableRoots() from the harness host.
 */
export function seatbeltProfileArgs(mode: SandboxMode, roots: readonly string[]): string[] | null {
  if (mode === 'danger-full-access') return null
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
  ]
  if (mode === 'workspace-write' && roots.length > 0) {
    const grants = roots.map(root => `(subpath ${sbplString(root)})`).join(' ')
    forms.push(`(allow file-write* ${grants})`)
  }
  return ['-p', forms.join(' ')]
}

export function seatbeltProbeArgv(): string[] {
  return ['sandbox-exec', ...seatbeltProfileArgs('read-only', [])!, '--', 'true']
}

function sbplString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * File-tool writable roots under workspace-write. read-only allows nothing.
 * An empty root is left out: bwrap exits immediately when a `--bind` source
 * does not exist, and that would reject a write inside the workspace as well.
 */
export function fileWritableRoots(mode: SandboxMode, roots: RemoteFileRoots): string[] {
  if (mode !== 'workspace-write') return []
  return [...new Set([roots.workspaceRoot, roots.tmp, roots.userTmp].filter(root => root.length > 0))]
}

export function pathInsideRoot(target: string, root: string): boolean {
  const normalizedTarget = target.length > 1 && target.endsWith('/') ? target.slice(0, -1) : target
  const normalizedRoot = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root
  if (normalizedRoot === '/') return normalizedTarget.startsWith('/')
  if (normalizedTarget === normalizedRoot) return true
  return normalizedTarget.startsWith(`${normalizedRoot}/`)
}

export function fileWriteAllowed(mode: SandboxMode, target: string, roots: RemoteFileRoots): boolean {
  if (mode === 'danger-full-access') return true
  if (mode === 'read-only') return false
  return fileWritableRoots(mode, roots).some(root => pathInsideRoot(target, root))
}

/** Kernel confinement dialects. Ordinary "Permission denied" is a command failure. */
export function sandboxDenied(exitCode: number | null, stderr: string): boolean {
  if (exitCode === 0 || exitCode === null) return false
  return /read-only file system|operation not permitted/i.test(stderr)
}

export function grepArgv(rg: string, pattern: string, base: string, include?: string): string[] {
  const argv = [rg, '--no-config', '--json', '-n', '--heading', pattern]
  if (include !== undefined && include.length > 0) argv.push('--glob', include)
  argv.push(base)
  return argv
}

export function globArgv(rg: string, pattern: string): string[] {
  return [rg, '--no-config', '--files', '--hidden', '--iglob', pattern, '--glob', '!.git/**', '--sort', 'modified']
}

/**
 * Write stdin to a same-directory temp file, then rename it onto the target.
 * `mv` on one filesystem replaces the destination atomically. A dropped
 * connection leaves the temp file, not a truncated target.
 * `cat` failure removes the temp file and does not run `mv`.
 */
export function atomicWriteScript(directory: string, tmp: string, target: string): string {
  const write = `cat > ${shJoin([tmp])} && mv -f ${shJoin([tmp, target])}`
  const cleanup = `{ status=$?; rm -f ${shJoin([tmp])}; exit $status; }`
  return `mkdir -p ${shJoin([directory])} && ${write} || ${cleanup}`
}
