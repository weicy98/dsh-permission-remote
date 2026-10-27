/**
 * A runner is usable only when the read-only profile actually runs `true`.
 * A binary that exists while user namespaces are disabled is still unavailable.
 */

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

/**
 * Five lines: kernel, machine, canonical /tmp, canonical user temp, home.
 * A failed `cd` still prints a blank line. Otherwise HOME slides into userTmp
 * and the file sandbox bind-mounts the home directory.
 */
export function hostFactsCommand(): string {
  const line = (body: string) => `{ ${body}; } || printf '\\n'`
  return [
    'uname -s',
    'uname -m',
    line('cd /tmp && pwd -P'),
    line('cd "${TMPDIR:-/tmp}" && pwd -P'),
    `printf '%s\\n' "$HOME"`,
  ].join('; ')
}

export interface HostFacts {
  readonly os: RemoteOs
  readonly arch: RemoteArch
  readonly tmp: string
  readonly userTmp: string
  readonly home: string
}

/** `pwd -P` resolves macOS `/tmp` to `/private/tmp` before file containment checks. */
export function parseHostFacts(stdout: string): HostFacts {
  const [osLine = '', archLine = '', tmpLine = '', userTmpLine = '', homeLine = ''] = stdout.split('\n')
  const tmp = tmpLine.trim() || '/tmp'
  const userTmp = userTmpLine.trim() || tmp
  const home = homeLine.trim() || '/tmp'
  return {
    os: remoteOsOf(osLine),
    arch: remoteArchOf(archLine),
    tmp,
    userTmp,
    home,
  }
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

/** npm optional package that ships the ripgrep binary for one remote. */
export function ripgrepPackage(os: RemoteOs, arch: RemoteArch): string | null {
  if (arch === 'other' || os === 'other') return null
  if (os === 'linux' && arch === 'x64') return '@vscode/ripgrep-linux-x64'
  if (os === 'linux' && arch === 'arm64') return '@vscode/ripgrep-linux-arm64'
  if (os === 'darwin' && arch === 'x64') return '@vscode/ripgrep-darwin-x64'
  if (os === 'darwin' && arch === 'arm64') return '@vscode/ripgrep-darwin-arm64'
  return null
}
