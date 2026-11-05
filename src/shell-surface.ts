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

/** Extra guidance for the optional DSH 0.2.2 patch / editor file tools. */
export const REMOTE_FILE_TOOLS_SECTION = 'remote-file-tools'

/**
 * Returned when a `str_replace_editor` call in a remote session names a bare
 * absolute path that is not a remote placeholder AND its path-rewriting shadow
 * is not mounted. Without the shadow the official tool resolves that path with
 * the local filesystem, so refusing is the only safe answer.
 */
export const STR_REPLACE_EDITOR_PATH_REFUSED = 'str_replace_editor is not safe on this remote workspace right now: this absolute path is not a remote placeholder path and no path-rewriting shadow is mounted. Pass the placeholder path returned by read or the file tree.'

export const REMOTE_APPLY_PATCH_PROMPT = 'The optional apply_patch tool runs on this remote host. It accepts paths relative to the session working directory, absolute placeholder paths, and bare remote absolute paths: /srv/app/a.ts is resolved against the remote host, not this computer.'

export const REMOTE_EDITOR_PROMPT = 'The optional str_replace_editor tool runs on this remote host. It requires absolute paths: pass back the placeholder paths returned by read or the file tree. A bare remote absolute path is rewritten by the plugin to that placeholder spelling and never reaches this computer; remote real absolute paths belong in bash commands only.'

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

/** Required runtime-context contribution: the placeholder's real remote directory. */
export const REMOTE_WORKSPACE_CONTEXT = 'remote-workspace:directory'

/**
 * Text for the per-turn runtime context. Local returns '' so the snapshot drops
 * it. JSON.stringify keeps spaces and `{{` literal (the context is registered
 * with `interpolate: false`, so no variable expansion sees it either).
 */
export function remoteWorkspaceContextText(route: Route): string {
  if (route.kind !== 'remote') return ''
  return `This workspace is a remote directory on an SSH host. The session's working directory is a local placeholder that maps to the real remote directory ${JSON.stringify(route.remoteCwd)}. File tools keep returning placeholder paths — pass those back unchanged. bash runs on that SSH host, so in commands use that quoted remote directory for absolute paths, never the local placeholder.`
}

export function windowsShellGuardReason(remote: boolean): string | undefined {
  return remote ? WINDOWS_SHELL_DENIED : undefined
}

/** Local returns the same array. Remote drops the Windows shell names. */
export function withoutWindowsShells<T extends { readonly name: string }>(tools: readonly T[], remote: boolean): readonly T[] {
  if (!remote) return tools
  return tools.filter(tool => !isWindowsShell(tool.name))
}
