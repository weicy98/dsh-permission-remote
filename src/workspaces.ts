/**
 * Which registered workspaces belong to which SSH host.
 *
 * A remote workspace is a real local directory under `remoteRoot()/<hostId>/<encoded>`,
 * so the workspace registry only knows the placeholder path. `routeByCwd` turns
 * that back into a host id and a remote absolute directory.
 *
 * DSH's sidebar renders a workspace row from its stored title alone and offers no
 * slot on that row, so the server is carried by the title: `hostTag · name`.
 * Tagging is idempotent and leaves a title that already starts with the tag alone.
 */
import { realpathSync } from 'node:fs'
import type { HostConfig } from './config.ts'
import { remoteRoot, routeByCwd } from './router.ts'

export interface WorkspaceLike {
  readonly id: unknown
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly sessionIds: readonly unknown[]
  setTitle(title: string): Promise<void>
}

export interface WorkspaceRegistryLike {
  create(dir: string, title?: string): Promise<WorkspaceLike>
  list(): WorkspaceLike[]
  delete(id: unknown): Promise<boolean>
}

export interface RemoteWorkspaceView {
  readonly hostId: string
  readonly workspaceId: string
  readonly title: string
  readonly remotePath: string
  readonly placeholderPath: string
  readonly sessions: number
  readonly createdAt: string
}

/** How the server is named in a sidebar title: its name, or its address when unnamed. */
export function hostTag(host: HostConfig): string {
  const name = host.name.trim()
  return name.length > 0 ? name : host.host
}

export function titlePrefix(host: HostConfig): string {
  return `${hostTag(host)} · `
}

/** Prefix a sidebar title with the server unless it already carries that prefix. */
export function taggedTitle(host: HostConfig, title: string): string {
  const prefix = titlePrefix(host)
  const current = title.trim()
  if (current.startsWith(prefix)) return title
  if (current.length === 0) return hostTag(host)
  return `${prefix}${current}`
}

/**
 * Re-tag after the host was renamed: an existing `oldTag · name` keeps its name,
 * anything else is tagged from scratch.
 */
export function retaggedTitle(host: HostConfig, previousTag: string, title: string): string {
  const previousPrefix = `${previousTag} · `
  const current = title.trim()
  if (current.startsWith(previousPrefix)) return `${titlePrefix(host)}${current.slice(previousPrefix.length)}`
  return taggedTitle(host, title)
}

/**
 * The remote root can itself be a symlink (`~/.dsh` is one on some installs) and
 * the registry stores `fs.realpath`, so accept either spelling.
 */
function candidateRoots(env: NodeJS.ProcessEnv): string[] {
  const root = remoteRoot(env)
  const roots = [root]
  try {
    const real = realpathSync(root)
    if (real !== root) roots.push(real)
  } catch {
    // The remote root does not exist yet; the lexical spelling is all there is.
  }
  return roots
}

export function workspaceRoute(workspacePath: string, env: NodeJS.ProcessEnv = process.env): { hostId: string, remotePath: string } | null {
  for (const root of candidateRoots(env)) {
    const route = routeByCwd(workspacePath, { ...env, DSH_SSH_REMOTE_ROOT: root })
    if (route.kind === 'remote') return { hostId: route.hostId, remotePath: route.remoteCwd }
  }
  return null
}

export function remoteWorkspaces(workspaces: readonly WorkspaceLike[], env: NodeJS.ProcessEnv = process.env): RemoteWorkspaceView[] {
  const items: RemoteWorkspaceView[] = []
  for (const workspace of workspaces) {
    const route = workspaceRoute(workspace.path, env)
    if (route === null) continue
    items.push({
      hostId: route.hostId,
      workspaceId: String(workspace.id),
      title: workspace.title,
      remotePath: route.remotePath,
      placeholderPath: workspace.path,
      sessions: workspace.sessionIds.length,
      createdAt: workspace.createdAt,
    })
  }
  return items
}

export async function tagWorkspace(host: HostConfig, workspace: WorkspaceLike): Promise<string> {
  const next = taggedTitle(host, workspace.title)
  if (next !== workspace.title) await workspace.setTitle(next)
  return next
}

/**
 * Tag every workspace that sits under one of `hosts`. `hostId` and
 * `workspaceId` narrow the set; both absent tags everything. `previousTag`
 * rewrites a title that still carries the old server name.
 */
export async function tagRemoteWorkspaces(
  hosts: readonly HostConfig[],
  workspaces: readonly WorkspaceLike[],
  options: { hostId?: string, workspaceId?: string, previousTag?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const byId = new Map(hosts.map(host => [host.id, host]))
  const onlyHost = textOrUndefined(options.hostId)
  const onlyWorkspace = textOrUndefined(options.workspaceId)
  const previousTag = textOrUndefined(options.previousTag)
  let changed = 0
  for (const workspace of workspaces) {
    if (onlyWorkspace !== undefined && String(workspace.id) !== onlyWorkspace) continue
    const route = workspaceRoute(workspace.path, env)
    if (route === null) continue
    if (onlyHost !== undefined && route.hostId !== onlyHost) continue
    const host = byId.get(route.hostId)
    if (host === undefined) continue
    const next = previousTag === undefined
      ? taggedTitle(host, workspace.title)
      : retaggedTitle(host, previousTag, workspace.title)
    if (next === workspace.title) continue
    await workspace.setTitle(next)
    changed += 1
  }
  return changed
}

/** RPC inputs may arrive as null or an empty string for "not set". */
export function textOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}
