/**
 * Tool shadowing for one agent.
 *
 * Presets register their tools on an ancestor scope. A registration on the
 * root context does not cover them. The wrapper must close over the official
 * execute captured BEFORE register: a later get() returns the wrapper and
 * recurses. `read`, `write`, `edit` and `apply_patch` are deliberately absent:
 * the remote filesystem backend serves them through the official tools.
 * `str_replace_editor` is the exception: its official `resolveTarget` calls
 * `ctx.fs.resolve(path, { signal })` without a cwd, so a remote real absolute
 * path would fall through to the local provider. Its shadow only rewrites
 * `args.path` and delegates to the official execute; the schema stays official.
 *
 * A name belongs in `ROUTED_TOOLS` when the official function cannot see the
 * session cwd, or when a path argument is a different spelling from that cwd.
 * `read` / `write` / `edit` / `apply_patch` / `read_image` go through `ctx.fs`
 * and stay off this list. `bash`, `glob`, and `grep` stay because a path
 * argument is a different spelling from the routing key. `working_directory`
 * only validates, then the official service commits. `present` stages bytes
 * for a local card. `terminal_open` rewrites `cwd` onto this host's placeholder
 * and delegates; the official tool resolves an absolute path on this computer.
 * When the remote terminal world is not fully installed it refuses instead.
 */

export const ROUTED_TOOLS = ['bash', 'glob', 'grep', 'working_directory', 'terminal_open', 'present', 'str_replace_editor'] as const
export type RoutedToolName = (typeof ROUTED_TOOLS)[number]

/**
 * `present` is routed like the file tools but is not reimplemented remotely: the
 * delivery event and the card that opens it both resolve paths with the local
 * filesystem, so the remote path stages the bytes at the placeholder path and
 * then calls the official tool. Its argument and output schemas stay official.
 */

/**
 * Why `terminal_open` refuses on a remote workspace when the remote terminal
 * world is not ready. Without the `spawnTerminal` bridge the official tool
 * would ask the local PTY backend for a shell in the placeholder directory.
 */
export const TERMINAL_OPEN_REFUSED = 'terminal_open is not ready in this remote workspace yet: the remote terminal bridge or the remote sandbox world is still installing. Retry shortly or reload the plugin. It will not fall back to a local shell on this computer.'

export interface OfficialTool<TArgs = unknown, TExec = unknown, TResult = unknown> {
  readonly execute: (args: TArgs, exec: TExec) => Promise<TResult> | TResult
}

export interface ShadowPlan<TArgs = unknown, TExec = unknown, TResult = unknown> {
  readonly name: RoutedToolName
  /** Official execute, absent when the preset does not publish this tool. */
  readonly official: OfficialTool<TArgs, TExec, TResult>['execute'] | undefined
  /**
   * True for bash. A preset without bash still produces a plan; the shell
   * surface registers that fallback only while the session cwd is remote.
   */
  readonly required: boolean
}

export function planShadows<TArgs, TExec, TResult>(
  visible: (name: RoutedToolName) => OfficialTool<TArgs, TExec, TResult> | undefined,
): ShadowPlan<TArgs, TExec, TResult>[] {
  const plans: ShadowPlan<TArgs, TExec, TResult>[] = []
  for (const name of ROUTED_TOOLS) {
    const official = visible(name)
    if (official === undefined && name !== 'bash') continue
    plans.push({
      name,
      official: official?.execute,
      required: name === 'bash',
    })
  }
  return plans
}

export function dispatchShadow<TArgs, TExec, TResult>(
  official: ((args: TArgs, exec: TExec) => Promise<TResult> | TResult) | undefined,
  remote: boolean,
  remoteExecute: (args: TArgs, exec: TExec) => Promise<TResult>,
  args: TArgs,
  exec: TExec,
): Promise<TResult> | TResult {
  if (!remote) {
    if (official === undefined) {
      throw new Error('dsh-permission-remote: this call left the remote workspace and no local tool is mounted')
    }
    return official(args, exec)
  }
  return remoteExecute(args, exec)
}
