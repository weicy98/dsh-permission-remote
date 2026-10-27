/**
 * Placeholder directory ↔ remote absolute path.
 *
 * A remote workspace is a real local directory so workspaceRegistry.create can
 * register it. The session cwd the model sees is that local path.
 */
import os from 'node:os'
import path from 'node:path'
import { posix } from 'node:path'

export function remoteRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_SSH_REMOTE_ROOT) return path.resolve(String(env.DSH_SSH_REMOTE_ROOT))
  const home = env.DSH_HOME ? String(env.DSH_HOME) : path.join(os.homedir(), '.dsh')
  return path.join(home, 'remote')
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
export function routeByCwd(cwd: string | undefined, env: NodeJS.ProcessEnv = process.env): Route {
  if (!cwd) return { kind: 'local' }
  const root = remoteRoot(env)
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

/** Spell a remote absolute path back as the local placeholder path the model already sees. */
export function toPlaceholderPath(remotePath: string, hostId: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = posix.normalize(remotePath)
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
