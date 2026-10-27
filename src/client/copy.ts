export const MANUAL_INSTALLS = [
  { title: 'Debian/Ubuntu', command: 'sudo apt-get update && sudo apt-get install -y bubblewrap' },
  { title: 'Fedora/RHEL', command: 'sudo dnf install -y bubblewrap' },
  { title: 'Arch', command: 'sudo pacman -S bubblewrap' },
  { title: 'Alpine', command: 'sudo apk add bubblewrap' },
] as const

export const MACOS_NOTE = 'macOS uses the system sandbox-exec. There is nothing to install. If the read-only probe fails, confined bash needs a one-shot approval up to danger-full-access.'

export const RIPGREP_NOTE = 'Ripgrep is uploaded for the remote architecture. If that fails, install ripgrep so rg is on PATH. Bubblewrap install does not install ripgrep.'
