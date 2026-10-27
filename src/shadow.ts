/**
 * Tool shadowing for one agent.
 *
 * Presets register bash/read/write/edit/read_image/glob/grep on an ancestor
 * scope. A registration on the root context does not cover them. The wrapper
 * must close over the official execute captured BEFORE register: a later get()
 * returns the wrapper and recurses.
 */

export const ROUTED_TOOLS = ['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'working_directory'] as const
export type RoutedToolName = (typeof ROUTED_TOOLS)[number]

export interface OfficialTool<TArgs = unknown, TExec = unknown, TResult = unknown> {
  readonly execute: (args: TArgs, exec: TExec) => Promise<TResult> | TResult
}

export interface ShadowPlan<TArgs = unknown, TExec = unknown, TResult = unknown> {
  readonly name: RoutedToolName
  /** Official execute, absent when the preset does not publish this tool. */
  readonly official: OfficialTool<TArgs, TExec, TResult>['execute'] | undefined
  /** bash is still registered on a remote session when the host platform hid tool-bash. */
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
