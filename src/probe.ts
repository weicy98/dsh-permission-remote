/**
 * A runner is usable only when the read-only profile actually runs `true`.
 * A binary that exists while user namespaces are disabled is still unavailable.
 */
import { posix } from 'node:path'
import { rgPackageName, rgPlatformOf } from './rg-fetch.ts'
import { shQuote } from './shell-quote.ts'

export interface ProbeOutcome {
  readonly available: boolean
  readonly reason: 'ok' | 'missing' | 'rejected' | 'timeout'
}

export function probeOutcome(exitCode: number | null, timedOut: boolean, stderr = ''): ProbeOutcome {
  if (timedOut) return { available: false, reason: 'timeout' }
  if (exitCode === 0) return { available: true, reason: 'ok' }
  if (exitCode === null || exitCode === 127 || /not found|command not found/i.test(stderr)) {
    return { available: false, reason: 'missing' }
  }
  return { available: false, reason: 'rejected' }
}

/** PTC worker minimum: process.js uses Promise.withResolvers (Node 22+). */
export const PTC_MIN_NODE_MAJOR = 22

/**
 * DSH 0.2.2-rc.2's worker imports `registerHooks` from `node:module` for ESM
 * import support. That named export only exists from Node 22.15 / 23.5, and an
 * ESM link error would stop the worker before any control frame is exchanged.
 * The requirement is derived from the worker bytes, not the DSH version label.
 */
export const PTC_MIN_NODE_MODULE_HOOKS_MINOR = 15

/** The same API landed in Node 23.5; Node 23.0-23.4 still lack it. */
export const PTC_MIN_NODE_MODULE_HOOKS_MINOR_NEXT = 5

/** Markers keep a login-shell banner out of the node lookup. */
export const NODE_LOOKUP_BEGIN = '__DSH_NODE_BEGIN__'
export const NODE_LOOKUP_END = '__DSH_NODE_END__'

export interface RemoteNode {
  readonly path: string
  readonly version: string
  readonly major: number
  readonly minor: number
}

/**
 * `command -v node` then `node -p process.versions.node`.
 *
 * Plain PATH first; a failing or too-old system Node retries through an
 * interactive bash so nvm/asdf layouts resolve. Markers keep login banners out
 * of the parsed result.
 */
export function nodeProbeCommand(): string {
  const inner = [
    'command -v node',
    '__dsh_rc=$?',
    'if [ "$__dsh_rc" -eq 0 ]; then node -p process.versions.node; fi',
    'exit $__dsh_rc',
  ].join('; ')
  return [
    `printf '%s\\n' '${NODE_LOOKUP_BEGIN}'`,
    '__dsh_ok=0',
    'if command -v node >/dev/null 2>&1; then',
    '  __dsh_ver=$(node -p process.versions.node 2>/dev/null)',
    '  __dsh_rc=$?',
    '  if [ "$__dsh_rc" -eq 0 ]; then',
    '    command -v node',
    `    printf '%s\\n' "$__dsh_ver"`,
    '    case "$__dsh_ver" in',
    '      2[2-9].*|3[0-9].*|4[0-9].*) __dsh_ok=1 ;;',
    '    esac',
    '  fi',
    'fi',
    'if [ "$__dsh_ok" -eq 0 ] && command -v bash >/dev/null 2>&1; then',
    `  bash -ic ${shQuote(inner)} 2>/dev/null`,
    'fi',
    `printf '%s\\n' '${NODE_LOOKUP_END}'`,
    'exit 0',
  ].join('\n')
}

/** Last semantic version is the version; the last bare absolute path before it is the binary. */
export function parseNodeProbe(stdout: string): RemoteNode | null {
  const lines = outputBlock(stdout, NODE_LOOKUP_BEGIN, NODE_LOOKUP_END)
    .map(line => line.trim())
    .filter(line => line.length > 0)
  const versionIndex = lines.findLastIndex(line => /^\d+\.\d+\.\d+/.test(line))
  if (versionIndex < 1) return null
  const version = lines[versionIndex] ?? ''
  const [majorText = '', minorText = ''] = version.split('.')
  const major = Number(majorText)
  const minor = Number(minorText)
  const nodePath = lines.slice(0, versionIndex).reverse().find(line => posix.isAbsolute(line) && !/\s/.test(line))
  if (nodePath === undefined || !Number.isInteger(major) || !Number.isInteger(minor)) return null
  return { path: nodePath, version, major, minor }
}

/**
 * Five lines: kernel, machine, canonical /tmp, canonical user temp, home.
 * A failed `cd` still prints a blank line. Otherwise HOME slides into userTmp
 * and the file sandbox bind-mounts the home directory.
 *
 * The block is wrapped in markers because a login shell may print a banner on
 * stdout before the first command runs; positional parsing would then read the
 * banner as the kernel name and disable the sandbox for the whole host.
 */
export const FACT_BEGIN = '__DSH_FACTS_BEGIN__'
export const FACT_END = '__DSH_FACTS_END__'

export function hostFactsCommand(): string {
  const line = (body: string) => `( ${body} ) || printf '\\n'`
  return [
    `printf '%s\\n' '${FACT_BEGIN}'`,
    'uname -s',
    'uname -m',
    line('cd /tmp && pwd -P'),
    line('cd "${TMPDIR:-/tmp}" && pwd -P'),
    `printf '%s\\n' "$HOME"`,
    `printf '%s\\n' '${FACT_END}'`,
  ].join('; ')
}

export interface HostFacts {
  readonly os: RemoteOs
  readonly arch: RemoteArch
  readonly tmp: string
  readonly userTmp: string
  /** Empty when the remote did not report an absolute home. */
  readonly home: string
}

/**
 * `pwd -P` resolves macOS `/tmp` to `/private/tmp` before file containment
 * checks. Values must be absolute: a relative path would be bound by bwrap as
 * a bogus root, and the home is spliced into the ripgrep upload path.
 */
export function parseHostFacts(stdout: string): HostFacts {
  const [osLine = '', archLine = '', tmpLine = '', userTmpLine = '', homeLine = ''] = factBody(stdout)
  const tmp = absoluteOr(tmpLine.trim(), '/tmp')
  const userTmp = absoluteOr(userTmpLine.trim(), tmp)
  const home = absoluteOr(homeLine.trim(), '')
  return {
    os: remoteOsOf(osLine),
    arch: remoteArchOf(archLine),
    tmp,
    userTmp,
    home,
  }
}

/** The five fact lines between the markers; unmarked output keeps the old layout. */
function factBody(stdout: string): string[] {
  return outputBlock(stdout, FACT_BEGIN, FACT_END, 5)
}

/**
 * Lines between two marker lines.
 *
 * A login shell can print a banner before the remote command. When the end
 * marker never arrives, keep the lines after the begin marker: falling back to
 * the start of the output would read that banner again. Without a begin
 * marker, `legacyCount` preserves a positional layout.
 */
export function outputBlock(stdout: string, begin: string, end: string, legacyCount?: number): string[] {
  const lines = stdout.split(/\r?\n/)
  const start = lines.indexOf(begin)
  if (start === -1) return legacyCount === undefined ? lines : lines.slice(0, legacyCount)
  const stop = lines.indexOf(end, start + 1)
  return lines.slice(start + 1, stop === -1 ? undefined : stop)
}

/** `command -v rg`, with markers so a login banner is not the binary path. */
export const RG_LOOKUP_BEGIN = '__DSH_RG_BEGIN__'
export const RG_LOOKUP_END = '__DSH_RG_END__'

export function systemRipgrepCommand(): string {
  return [
    `printf '%s\\n' '${RG_LOOKUP_BEGIN}'`,
    'command -v rg',
    'status=$?',
    `printf '%s\\n' '${RG_LOOKUP_END}'`,
    'exit $status',
  ].join('; ')
}

/**
 * Absolute path printed by `command -v rg`, or `''` when that lookup did not
 * print one. The last absolute line inside the markers is the binary. A banner
 * before the command, and a shell function dumped as text, are not. Output
 * with no markers uses the same rule on the whole stdout. A line with
 * whitespace is a function body or an alias, never a bare binary path.
 */
export function systemRipgrepPath(stdout: string): string {
  const lines = outputBlock(stdout, RG_LOOKUP_BEGIN, RG_LOOKUP_END)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim()
    if (posix.isAbsolute(line) && !/\s/.test(line)) return line
  }
  return ''
}

function absoluteOr(value: string, fallback: string): string {
  return posix.isAbsolute(value) ? value : fallback
}

export type RemoteOs = 'linux' | 'darwin' | 'other'

export function remoteOsOf(uname: string): RemoteOs {
  const name = uname.trim().toLowerCase()
  if (name === 'linux') return 'linux'
  if (name === 'darwin') return 'darwin'
  return 'other'
}

export type RemoteArch = 'x64' | 'arm64' | 'other'

export function remoteArchOf(machine: string): RemoteArch {
  const name = machine.trim().toLowerCase()
  if (name === 'x86_64' || name === 'amd64') return 'x64'
  if (name === 'aarch64' || name === 'arm64') return 'arm64'
  return 'other'
}

/**
 * npm optional package that ships the ripgrep binary for one remote.
 *
 * Delegates to the one platform table in `rg-fetch.ts`: the package name and the
 * download target must never disagree about which platforms exist.
 */
export function ripgrepPackage(os: RemoteOs, arch: RemoteArch): string | null {
  const platform = rgPlatformOf(os, arch)
  return platform === null ? null : rgPackageName(platform)
}
