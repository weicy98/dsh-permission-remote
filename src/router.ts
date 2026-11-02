/**
 * Placeholder directory ↔ remote absolute path.
 *
 * A remote workspace is a real local directory so workspaceRegistry.create can
 * register it. The session cwd the model sees is that local path.
 */
import os from 'node:os'
import path from 'node:path'
import { posix } from 'node:path'

/**
 * The placeholder root when nothing has overridden it: `DSH_SSH_REMOTE_ROOT`,
 * else `<DSH_HOME>/remote` (`~/.dsh/remote`). Kept separate from
 * {@link remoteRoot} so the Settings page can show what the default would be.
 */
export function defaultRemoteRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_SSH_REMOTE_ROOT) return path.resolve(String(env.DSH_SSH_REMOTE_ROOT))
  const home = env.DSH_HOME ? String(env.DSH_HOME) : path.join(os.homedir(), '.dsh')
  return path.join(home, 'remote')
}

/**
 * Runtime override for the placeholder root, set by the plugin from its
 * `remoteRoot` setting. Every routing helper already funnels through
 * {@link remoteRoot}, so a single setter beats threading the value through
 * every call. `null` restores the environment/default resolution, which keeps
 * a config-less install and the unit tests on their old behaviour.
 */
let remoteRootOverride: string | null = null

/**
 * Roots this process used before the operator moved it.
 *
 * The migration copies the placeholders instead of moving them, so a directory
 * from an earlier root still exists. A session opened on one must keep routing
 * to its server: treating it as a local path would run the model's commands on
 * this machine while the conversation still says it is remote. Keeping the old
 * roots routable turns that into a refusal instead — a placeholder no
 * registered workspace covers is rejected by the entry guard.
 */
const supersededRoots: string[] = []

export function setRemoteRootOverride(root: string | null): void {
  const text = root === null ? '' : String(root).trim()
  remoteRootOverride = text.length === 0 ? null : path.resolve(text)
}

/**
 * Remember a root the operator migrated away from.
 *
 * Only the running process needs this: after a restart the old placeholders no
 * longer belong to a registered workspace, and reopening the workspace is what
 * the settings page already asks for.
 */
export function addSupersededRoot(root: string): void {
  const text = String(root ?? '').trim()
  if (text.length === 0) return
  const resolved = path.resolve(text)
  if (resolved === remoteRoot()) return
  if (!supersededRoots.includes(resolved)) supersededRoots.push(resolved)
}

/** Drop every remembered root. Tests and a fresh plugin load only. */
export function clearSupersededRoots(): void {
  supersededRoots.length = 0
}

/**
 * Every root a cwd may be a placeholder under, current one first.
 *
 * A previous root stays in the list so stale sessions keep their remote host;
 * see {@link addSupersededRoot}.
 */
export function routingRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [remoteRoot(env)]
  for (const root of supersededRoots) {
    if (!roots.includes(root)) roots.push(root)
  }
  return roots
}

export function remoteRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (remoteRootOverride !== null) return remoteRootOverride
  return defaultRemoteRoot(env)
}

/**
 * Expand a user-typed root into an absolute local path.
 *
 * `~` and `~/…` use this machine's home; every other relative spelling is
 * refused, because the placeholder tree must live at a stable absolute path.
 * @returns the resolved path, or `null` when the input is blank or relative.
 */
export function expandRemoteRoot(input: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const text = String(input ?? '').trim()
  if (text.length === 0) return null
  const home = env.HOME && String(env.HOME).length > 0 ? String(env.HOME) : os.homedir()
  let expanded = text
  if (text === '~') expanded = home
  else if (text.startsWith('~/')) expanded = path.join(home, text.slice(2))
  if (!path.isAbsolute(expanded)) return null
  return path.resolve(expanded)
}

/** Same grammar as `credentialKey()` segments: lowercase, digits, and hyphens. */
export function isValidHostId(hostId: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(hostId)
}

export function encodeRemotePath(remotePath: string): string {
  return Buffer.from(remotePath, 'utf8').toString('base64url')
}

export function decodeRemotePath(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null
  let text: string
  try {
    text = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (encodeRemotePath(text) !== encoded) return null
  return text
}

export function mapRemoteToLocal(hostId: string, remotePath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isValidHostId(hostId)) return null
  if (!posix.isAbsolute(remotePath)) return null
  return path.join(remoteRoot(env), hostId, encodeRemotePath(remotePath))
}

export interface RemoteRoute {
  readonly kind: 'remote'
  readonly hostId: string
  readonly remoteCwd: string
  readonly placeholderCwd: string
}

export interface LocalRoute {
  readonly kind: 'local'
}

export type Route = RemoteRoute | LocalRoute

/**
 * A cwd under a placeholder routes remote, including subdirectories.
 * The first two segments are host id and the encoded workspace root; further
 * segments are a remote subdirectory. Local separators stay on this machine.
 */
/**
 * The route of a cwd read as a path under one placeholder root.
 *
 * Split from {@link routeByCwd} so a caller that holds a root of its own (the
 * workspace registry may store `fs.realpath`) does not have to pass it back
 * through the environment.
 */
export function routeUnderRoot(root: string, cwd: string | undefined): Route {
  if (!cwd) return { kind: 'local' }
  const rel = path.relative(root, cwd)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { kind: 'local' }
  const segments = rel.split(path.sep).filter(segment => segment.length > 0)
  if (segments.length < 2) return { kind: 'local' }
  const hostId = segments[0]!
  const encoded = segments[1]!
  if (!isValidHostId(hostId)) return { kind: 'local' }
  const remotePath = decodeRemotePath(encoded)
  if (remotePath === null || !remotePath.startsWith('/')) return { kind: 'local' }
  const extra = segments.slice(2)
  const remoteCwd = extra.length === 0 ? remotePath : posix.join(remotePath, ...extra)
  return { kind: 'remote', hostId, remoteCwd, placeholderCwd: cwd }
}

export function routeByCwd(cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): Route {
  for (const root of routingRoots(env)) {
    const route = routeUnderRoot(root, cwd)
    if (route.kind === 'remote') return route
  }
  return { kind: 'local' }
}

/**
 * The workspace a placeholder was opened on, ignoring later subdirectory segments.
 *
 * `routeByCwd` folds those segments into the live remote directory. The sandbox
 * root is the encoded workspace, the directory the session was opened on, and
 * must not follow a `cd` into `/etc` or `/`.
 */
export function workspaceBinding(cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): { hostId: string, remotePath: string } | null {
  if (!cwd) return null
  // A session left on a superseded root still belongs to its workspace; without
  // this it would lose the sandbox pin and could follow a `cd` out of it.
  for (const root of routingRoots(env)) {
    const rel = path.relative(root, cwd)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue
    const segments = rel.split(path.sep).filter(segment => segment.length > 0)
    if (segments.length < 2) continue
    const hostId = segments[0]!
    if (!isValidHostId(hostId)) continue
    const remotePath = decodeRemotePath(segments[1]!)
    if (remotePath === null || !remotePath.startsWith('/')) continue
    const normalized = normalizeRemoteDirectory(remotePath)
    if (normalized === null) continue
    return { hostId, remotePath: normalized }
  }
  return null
}

/**
 * Resolve a model-supplied path against a remote workspace.
 * Relative paths and paths inside the placeholder root re-anchor to the remote
 * directory. Other absolute paths are remote absolute paths, lexically normalized.
 */
export function resolveRemotePath(requestedPath: string, remoteCwd: string, placeholderCwd: string): string {
  if (!posix.isAbsolute(requestedPath)) {
    const rel = path.relative(placeholderCwd, requestedPath)
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return posix.join(remoteCwd, rel.split(path.sep).join('/'))
    }
    return posix.normalize(posix.resolve(remoteCwd, requestedPath))
  }
  const rel = posix.relative(placeholderCwd, requestedPath)
  if (rel !== '' && !rel.startsWith('..') && !posix.isAbsolute(rel)) {
    return posix.join(remoteCwd, rel)
  }
  return posix.normalize(requestedPath)
}

/**
 * A remote directory path in the one spelling a workspace is keyed by.
 *
 * `posix.normalize` keeps a trailing slash, and the placeholder path encodes the
 * remote path verbatim, so `/srv/app/` would register a second workspace beside
 * `/srv/app`. This drops the slashes; the filesystem root stays `/`.
 *
 * @returns the normalized path, or `null` when the input is not absolute.
 */
export function normalizeRemoteDirectory(remotePath: string): string | null {
  const text = remotePath.trim()
  if (!posix.isAbsolute(text)) return null
  return posix.normalize(text).replace(/\/+$/, '') || '/'
}

/**
 * A directory the picker may create inside `parent`, or `null` with the reason.
 *
 * The name is one path segment: a separator would build a tree the operator
 * never listed, and `.`/`..` would resolve somewhere they are not looking at.
 * Only the name is validated; whether it exists is the remote's answer, which
 * this cannot know.
 */
export function childDirectoryPath(parent: string, rawName: string): { path: string } | { error: 'empty' | 'dot' | 'separator' } {
  const name = rawName.trim()
  if (name.length === 0) return { error: 'empty' }
  if (name === '.' || name === '..') return { error: 'dot' }
  if (name.includes('/') || name.includes('\0')) return { error: 'separator' }
  const root = parent.length === 0 ? '/' : parent
  return { path: root === '/' ? `/${name}` : `${root.replace(/\/$/, '')}/${name}` }
}

/** Spell a remote absolute path back as the local placeholder path the model already sees. */
export function toPlaceholderPath(remotePath: string, hostId: string, env: NodeJS.ProcessEnv = process.env): string {  const normalized = posix.normalize(remotePath)
  const local = mapRemoteToLocal(hostId, normalized, env)
  if (local === null) return normalized
  return local
}

/** Prefer a path relative to the placeholder cwd when the remote path sits under the workspace. */
export function toModelPath(remotePath: string, route: RemoteRoute, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = posix.normalize(remotePath)
  const rel = posix.relative(route.remoteCwd, normalized)
  if (rel === '') return route.placeholderCwd
  if (rel !== '' && !rel.startsWith('..') && !posix.isAbsolute(rel)) {
    return path.join(route.placeholderCwd, ...rel.split('/'))
  }
  return toPlaceholderPath(normalized, route.hostId, env)
}
