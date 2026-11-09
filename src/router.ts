/**
 * Placeholder directory ↔ remote absolute path.
 *
 * A remote workspace is a real local directory so workspaceRegistry.create can
 * register it. The session cwd the model sees is that local path.
 */
import { realpathSync } from 'node:fs'
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
  invalidateCanonicalRoots()
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
  if (!supersededRoots.includes(resolved)) {
    supersededRoots.push(resolved)
    invalidateCanonicalRoots()
  }
}

/** Drop every remembered root. Tests and a fresh plugin load only. */
export function clearSupersededRoots(): void {
  supersededRoots.length = 0
  invalidateCanonicalRoots()
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

/** The lexical spelling of a local path, followed by its canonical one when it resolves. */
function pathSpellings(target: string): string[] {
  const out = [target]
  try {
    const real = realpathSync(target)
    if (real !== target) out.push(real)
  } catch {
    // The path does not exist yet; the lexical spelling is all there is.
  }
  return out
}

/**
 * Every root a cwd may be a placeholder under, including each root's realpath.
 *
 * The workspace registry stores `fs.realpath`, so a session cwd is canonical
 * even when the configured root (or the environment default) spells a symlink
 * (`~/.dsh` is one on some installs). Routing must compare against both
 * spellings, or it silently treats that session as local and runs its commands
 * on this machine. This is the single authority `workspaces.ts` and the router
 * both use, so the two cannot drift apart again.
 */
export function canonicalRoutingRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = []
  for (const root of routingRoots(env)) {
    for (const spelling of pathSpellings(root)) {
      if (!roots.includes(spelling)) roots.push(spelling)
    }
  }
  return roots
}

/**
 * `canonicalRoutingRoots` memoized per root set.
 *
 * `pathSpellings` calls `realpathSync`, so computing this on every call means a
 * synchronous stat per root on every path the remote filesystem resolves —
 * `lexicalPath` then `routeByCwd` right after it paid for the same answer
 * twice. The roots only change through {@link setRemoteRootOverride},
 * {@link addSupersededRoot} and {@link clearSupersededRoots}, each of which
 * bumps {@link routingRootsEpoch}; the cache is keyed on that epoch plus the
 * environment's own root inputs, so a changed setting or a redeclared
 * `DSH_SSH_REMOTE_ROOT` cannot serve a stale list.
 */
let routingRootsEpoch = 0
let canonicalCache: { key: string, roots: string[] } | undefined

/** Drop {@link canonicalRoutingRootsCached}; every root mutation calls it. */
function invalidateCanonicalRoots(): void {
  routingRootsEpoch += 1
  canonicalCache = undefined
}

/**
 * {@link canonicalRoutingRoots}, reusing the previous answer while nothing that
 * can change it has.
 *
 * Only for hot callers that already hold no strong reason to recompute; the
 * locale/migration paths keep using the uncached version so a stale answer can
 * never outlive a test that swaps the root.
 */
export function canonicalRoutingRootsCached(env: NodeJS.ProcessEnv = process.env): string[] {
  const key = `${routingRootsEpoch}\0${env.DSH_SSH_REMOTE_ROOT ?? ''}\0${env.DSH_HOME ?? ''}\0${env.HOME ?? ''}`
  if (canonicalCache !== undefined && canonicalCache.key === key) return canonicalCache.roots
  const roots = canonicalRoutingRoots(env)
  canonicalCache = { key, roots }
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

/**
 * Directory under every remote root that holds delivery snapshots.
 *
 * The leading dot is load-bearing, not cosmetic: {@link isValidHostId} accepts
 * only lowercase letters, digits, and hyphens, so `.deliverables` can never be
 * read as a host id. That is what lets {@link routeUnderRoot} classify a
 * snapshot as local and hand every read to the mounted local backend, instead
 * of the remote filesystem trying to `stat` it over SFTP.
 *
 * It sits *inside* the remote root so a snapshot is found again after the
 * operator moves the root (as a superseded root) and so moving the root can
 * skip the tree by name. See `docs/advanced.md` for the expiry behaviour.
 */
export const PRESENT_CACHE_DIR = '.deliverables'

/** Where delivery snapshots live for the root in force right now. */
export function presentCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(remoteRoot(env), PRESENT_CACHE_DIR)
}

/**
 * The snapshot directory of every root this process routes under.
 *
 * A superseded root is included on purpose: a card recorded before the operator
 * moved the root still names a file under the old one, and the read-only guard
 * has to keep covering it. Each root contributes both its lexical and its
 * canonical spelling, because a snapshot path is recorded as a realpath while a
 * session cwd may still be spelled through a symlink (`~/.dsh` is one on some
 * installs) — the guard has to match either way.
 */
export function presentCacheRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return canonicalRoutingRootsCached(env).map(root => path.join(root, PRESENT_CACHE_DIR))
}

/**
 * Whether an absolute local path names a delivery snapshot.
 *
 * Callers use this for one decision only: a snapshot is on this computer, never
 * on the SSH host, so it must bypass the remote namespace. The check is purely
 * lexical against every candidate root — a path that does not exist yet is
 * still classified, because a read must not first create it. `..` and absolute
 * relatives are rejected by `path.relative`, and a path on another Windows
 * drive resolves to an absolute relative, which is rejected too.
 */
export function isPresentCachePath(absolute: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof absolute !== 'string' || absolute.length === 0) return false
  if (!path.isAbsolute(absolute)) return false
  const target = path.resolve(absolute)
  for (const root of presentCacheRoots(env)) {
    const rel = path.relative(path.resolve(root), target)
    if (rel === '') return true
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue
    return true
  }
  return false
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
  if (!cwd) return { kind: 'local' }
  // Try the cwd as given first, then its realpath: DSH normally stores the
  // canonical spelling already, but a row saved before realpath registration
  // (or a caller holding a symlink spelling) must still route remote.
  const roots = canonicalRoutingRootsCached(env)
  for (const spelling of pathSpellings(cwd)) {
    for (const root of roots) {
      const route = routeUnderRoot(root, spelling)
      if (route.kind === 'remote') {
        // Keep the spelling the caller (and the model) actually uses.
        return spelling === cwd ? route : { ...route, placeholderCwd: cwd }
      }
    }
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
  // this it would lose the sandbox pin and could follow a `cd` out of it. Both
  // the root and the cwd may be spelled through a symlink, so accept either.
  for (const spelling of pathSpellings(cwd)) {
    for (const root of canonicalRoutingRoots(env)) {
      const rel = path.relative(root, spelling)
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
 * The path a listing request should realpath.
 *
 * The picker also takes a typed path, so a request may be `~` or `~/src`, which
 * SFTP will not expand by itself: `home` is the login home the session starts
 * in, resolved by the caller. An empty request means the filesystem root, so a
 * picker that lost its path still has somewhere to list. `~user` is passed
 * through untouched — only the remote can say whose home that is, and the
 * caller never sends one it did not see typed.
 */
export function listingPath(requested: string, home: string): string {
  const text = requested.trim()
  if (text.length === 0) return '/'
  if (text === '~') return home
  if (text.startsWith('~/')) return posix.join(home, text.slice(2)).replace(/\/+$/, '') || '/'
  return text
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
