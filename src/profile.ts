/**
 * Remote confinement argv.
 *
 * Bash and PTC profiles call the installed `@deepseek-ai/dsh-sandbox-local`
 * constructors (`profile-contract.ts`). Those functions are not exported. A
 * shape-literal change or a different argv refuses the command instead of
 * running a copied argv.
 *
 * File writes do not share that temp root. Their bwrap base is the official
 * read-only profile; workspace-write then bind-mounts the real remote temp
 * directories so a write is still on disk after bwrap exits. Bash keeps the
 * official private tmpfs on `/tmp`.
 */

import { loadSandboxProfiles } from './profile-contract.ts'
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

/** Official bwrap arguments before `--`. danger-full-access does not wrap. */
export function bwrapProfileArgs(mode: SandboxMode, workspaceRoot: string): string[] | null {
  if (mode === 'danger-full-access') return null
  return loadSandboxProfiles().bwrap({ mode, workspaceRoot })
}

/**
 * File-tool bwrap profile. The base flags are the official read-only profile.
 * workspace-write bind-mounts the real workspace, `/tmp`, and user temp, and
 * does not mount a private tmpfs, so a write the policy allows is still on
 * the remote disk after bwrap exits. Shorter roots are mounted first; a later
 * mount of a longer path stays visible.
 */
export function bwrapFileProfileArgs(mode: SandboxMode, roots: RemoteFileRoots): string[] | null {
  if (mode === 'danger-full-access') return null
  const args = [...loadSandboxProfiles().bwrap({ mode: 'read-only', workspaceRoot: roots.workspaceRoot })]
  if (mode === 'workspace-write') {
    const binds = fileWritableRoots(mode, roots).slice().sort((left, right) => left.length - right.length || left.localeCompare(right))
    for (const root of binds) args.push('--bind', root, root)
  }
  return args
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
 * Official seatbelt arguments before `--`.
 *
 * `roots` is the remote-probed grant list. The constructor would otherwise
 * call `writableRoots()` and grant this computer's temp directories.
 * read-only passes no roots. The workspace root then stays empty: falling
 * back to `/` would grant the whole filesystem if upstream starts reading
 * `policy.workspaceRoot`.
 */
export function seatbeltProfileArgs(mode: SandboxMode, roots: readonly string[]): string[] | null {
  if (mode === 'danger-full-access') return null
  return loadSandboxProfiles().seatbelt({
    mode,
    workspaceRoot: roots.find(root => root.length > 0) ?? '',
    remoteWritableRoots: roots,
  })
}

export function seatbeltProbeArgv(): string[] {
  return ['sandbox-exec', ...seatbeltProfileArgs('read-only', [])!, '--', 'true']
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

/**
 * Write stdin to a same-directory temp file, then rename it onto the target.
 * `mv` on one filesystem replaces the destination atomically. A dropped
 * connection leaves the temp file, not a truncated target.
 * `cat` failure removes the temp file and does not run `mv`.
 * `mv` into an existing directory succeeds, so a directory target fails first.
 * `mode` is the target's existing permission bits; only `undefined` (a new file)
 * keeps the remote umask. Mode `000` is a real value and must be restored.
 */
export function atomicWriteScript(directory: string, tmp: string, target: string, mode?: number, options: { noClobber?: boolean } = {}): string {
  const quotedTarget = shJoin([target])
  const quotedTmp = shJoin([tmp])
  const bits = mode === undefined ? undefined : mode & 0o7777
  const chmod = bits === undefined ? '' : ` && chmod ${bits.toString(8)} ${quotedTarget}`
  // `mv -n` is the atomic no-clobber publication. It leaves the temp file in
  // place when the destination exists; checking that condition lets the caller
  // report a typed conflict instead of a generic write failure, even if a
  // non-cooperating writer creates the target between the guard and the rename.
  const rename = options.noClobber === true
    ? `mv -n ${quotedTmp} ${quotedTarget} || true; if [ -e ${quotedTmp} ]; then if [ -e ${quotedTarget} ] || [ -L ${quotedTarget} ]; then echo 'remote target already exists' >&2; fi; false; fi`
    : `mv -f ${quotedTmp} ${quotedTarget}`
  const write = `if test -d ${quotedTarget}; then echo 'remote path is a directory' >&2; false; else cat > ${quotedTmp} && ${rename}${chmod}; fi`
  const cleanup = `{ status=$?; rm -f ${quotedTmp}; exit $status; }`
  return `mkdir -p ${shJoin([directory])} && ${write} || ${cleanup}`
}
