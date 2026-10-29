/**
 * What a remote workspace shows the model instead of the Windows shells.
 *
 * Decisions only. `installShadows` owns the registrations: a permanent guard,
 * prompt section, and schema filter, plus a dynamic restrict / `tool:pwsh` /
 * bash-fallback set replaced when the working directory enters or leaves a
 * remote workspace.
 */
import type { Route } from './router.ts'

export const WINDOWS_SHELLS = ['pwsh', 'powershell', 'cmd'] as const
export type WindowsShellName = (typeof WINDOWS_SHELLS)[number]

const WINDOWS_SHELL_NAMES: ReadonlySet<string> = new Set(WINDOWS_SHELLS)

/** Agent-layer cover for the ancestor's static Windows termination sentence. */
export const PWSH_SECTION = 'tool:pwsh'

/** Separate from `tool:bash`, whose official text is only the exit-code sentence. */
export const REMOTE_POSIX_SECTION = 'remote-posix-shell'

/**
 * Returned to the model when a Windows shell would run on the control host.
 * Fixed text: the guard does not invent a translated command.
 */
export const WINDOWS_SHELL_DENIED = 'pwsh, powershell, and cmd run on the Windows machine where DSH is running, not on this remote workspace. Use bash.'

export const REMOTE_POSIX_PROMPT = 'This workspace is a POSIX host reached over SSH. The bash tool runs on that host: write commands with Linux paths and Bash syntax. Do not use PowerShell or cmd. File-tool arguments may keep the placeholder paths those tools already return. Skills, MCP tools, and custom tools registered on this computer may still run locally.'

export function isWindowsShell(name: string): boolean {
  return WINDOWS_SHELL_NAMES.has(name)
}

/**
 * DSH 0.2.1-rc.3 reports an unknown name and a same-scope name with this
 * phrase. It is not a public error code; `tests/shell-surface-dsh.spec.ts`
 * locks the message `tools.restrict` actually throws. A permission failure,
 * a closed registry, or an incompatible API uses different text and must
 * still fail the remote agent.
 */
export function isUnknownRestrictError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('unknown global tool')
}

export interface ShellSurfacePlan {
  readonly remote: boolean
  /** Names to attempt one at a time. Empty means do not call `restrict`. */
  readonly deny: readonly WindowsShellName[]
  readonly shadowPwshPrompt: boolean
  readonly bashFallback: boolean
}

export function shellSurfacePlan(route: Route, hasOfficialBash: boolean): ShellSurfacePlan {
  if (route.kind !== 'remote') {
    return { remote: false, deny: [], shadowPwshPrompt: false, bashFallback: false }
  }
  return {
    remote: true,
    deny: WINDOWS_SHELLS,
    shadowPwshPrompt: true,
    bashFallback: !hasOfficialBash,
  }
}

export function sameShellSurface(left: ShellSurfacePlan, right: ShellSurfacePlan): boolean {
  return left.remote === right.remote
    && left.shadowPwshPrompt === right.shadowPwshPrompt
    && left.bashFallback === right.bashFallback
    && left.deny.length === right.deny.length
    && left.deny.every((name, index) => name === right.deny[index])
}

export function remotePosixPrompt(remote: boolean): string {
  return remote ? REMOTE_POSIX_PROMPT : ''
}

export function windowsShellGuardReason(remote: boolean): string | undefined {
  return remote ? WINDOWS_SHELL_DENIED : undefined
}

/** Local returns the same array. Remote drops the Windows shell names. */
export function withoutWindowsShells<T extends { readonly name: string }>(tools: readonly T[], remote: boolean): readonly T[] {
  if (!remote) return tools
  return tools.filter(tool => !isWindowsShell(tool.name))
}
