/** Fixed, non-interactive package-manager commands. Never built from model input. */

export interface DistroInstall {
  readonly id: string
  readonly title: string
  /**
   * Command the settings button runs. Uses sudo -n so a password prompt cannot hang.
   *
   * The refresh step and the install step are separate statements joined by
   * `;`, and the exit status reported is the install's. A stale index is
   * recoverable — the package is usually still installable from it — while a
   * broken third-party source (a retired apt repository, for example) makes
   * `apt-get update` fail forever. Chaining with `&&` would let that
   * unrelated failure skip the install entirely.
   */
  readonly auto: string
  /** Command shown for the operator to run themselves. */
  readonly manual: string
}

export const BUBBLEWRAP_INSTALLS: readonly DistroInstall[] = [
  {
    id: 'debian',
    title: 'Debian/Ubuntu',
    auto: 'sudo -n apt-get update; sudo -n apt-get install -y bubblewrap',
    manual: 'sudo apt-get update; sudo apt-get install -y bubblewrap',
  },
  {
    id: 'fedora',
    title: 'Fedora/RHEL',
    auto: 'sudo -n dnf install -y bubblewrap',
    manual: 'sudo dnf install -y bubblewrap',
  },
  {
    id: 'arch',
    title: 'Arch',
    auto: 'sudo -n pacman -S --noconfirm bubblewrap',
    manual: 'sudo pacman -S bubblewrap',
  },
  {
    id: 'alpine',
    title: 'Alpine',
    auto: 'sudo -n apk add bubblewrap',
    manual: 'sudo apk add bubblewrap',
  },
]

const DEBIAN = new Set(['debian', 'ubuntu', 'linuxmint', 'pop', 'raspbian'])
const FEDORA = new Set(['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'ol'])
const ARCH = new Set(['arch', 'manjaro', 'endeavouros'])
const ALPINE = new Set(['alpine'])

export interface OsRelease {
  readonly id: string
  readonly idLike: readonly string[]
}

/** Parse /etc/os-release ID and ID_LIKE. Unknown files yield an empty id. */
export function parseOsRelease(text: string): OsRelease {
  const fields = new Map<string, string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq)
    let value = trimmed.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    fields.set(key, value)
  }
  const id = (fields.get('ID') ?? '').toLowerCase()
  const idLike = (fields.get('ID_LIKE') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return { id, idLike }
}

export function distroInstallFor(release: OsRelease): DistroInstall | null {
  const names = [release.id, ...release.idLike]
  for (const name of names) {
    if (DEBIAN.has(name)) return BUBBLEWRAP_INSTALLS[0]!
    if (FEDORA.has(name)) return BUBBLEWRAP_INSTALLS[1]!
    if (ARCH.has(name)) return BUBBLEWRAP_INSTALLS[2]!
    if (ALPINE.has(name)) return BUBBLEWRAP_INSTALLS[3]!
  }
  return null
}

export const MACOS_MANUAL = 'macOS uses the system sandbox-exec. There is nothing to install. If the read-only probe fails, confined bash needs a one-shot approval up to danger-full-access.'

export const RIPGREP_MANUAL = 'This plugin uploads a ripgrep binary for the remote architecture. If that upload fails, install ripgrep so `rg` is on PATH.'
