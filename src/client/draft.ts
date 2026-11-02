/**
 * Pure form/browse helpers for the settings section.
 *
 * The form is a long-lived copy of one host row. Trusting a fingerprint updates
 * the stored row, which the form does not edit, so a later save takes `id` and
 * `fingerprint` from the latest row. `opsPolicy` and `loginEnv` are form
 * fields, so the form's values are what get saved. A successful change on the
 * host card copies that value back into an open form.
 */
import type { HostView } from './api.ts'

/**
 * The form keeps the port as text so the field can be cleared while typing. It
 * has no fingerprint input: trust is a separate action on the host card.
 */
export interface Draft extends Omit<HostView, 'port' | 'fingerprint'> {
  port: string
}

const DEFAULT_PORT = 22

export function toDraft(host: HostView): Draft {
  return {
    id: host.id,
    name: host.name,
    host: host.host,
    port: String(host.port),
    username: host.username,
    auth: host.auth,
    privateKeyPath: host.privateKeyPath,
    opsPolicy: host.opsPolicy,
    loginEnv: host.loginEnv === true,
  }
}

export function blankDraft(): Draft {
  return {
    id: '',
    name: '',
    host: '',
    port: String(DEFAULT_PORT),
    username: '',
    auth: 'key',
    privateKeyPath: '',
    opsPolicy: 'ask',
    loginEnv: false,
  }
}

export function draftPort(draft: Draft): number {
  return Number(draft.port) || DEFAULT_PORT
}

export function draftPortValid(draft: Draft): boolean {
  const port = Number(draft.port)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * Build the row to save. Connection fields come from the form; `fingerprint`
 * and `id` come from the latest stored row, because the form has no input for
 * them. A changed address or port drops the fingerprint so the new machine has
 * to prove its key again.
 */
export function mergeEditedHost(latest: HostView | undefined, form: Draft): HostView {
  const port = draftPort(form)
  const moved = latest !== undefined && (latest.host !== form.host || latest.port !== port)
  return {
    id: latest?.id ?? form.id,
    name: form.name,
    host: form.host,
    port,
    username: form.username,
    auth: form.auth,
    privateKeyPath: form.privateKeyPath,
    fingerprint: moved ? '' : latest?.fingerprint ?? '',
    opsPolicy: form.opsPolicy,
    loginEnv: form.loginEnv === true,
  }
}

/** The host a new workspace may be created for; `null` until a listing succeeds. */
export function createTarget(browsing: string, listed: boolean): string | null {
  return browsing.length > 0 && listed ? browsing : null
}

/**
 * Name filter for the directory listing, applied as the user types. Matching is
 * case-insensitive and trims the query; an empty query keeps the whole listing
 * (the same array, so a cleared box costs no extra work).
 *
 * Only names are matched: every entry's `path` contains the current directory,
 * so matching paths would make any substring of that directory match
 * everything. A plain name never reaches the remote, so a keystroke costs no
 * round trip; only a path in the box asks for the directory it points at.
 */
export function filterEntries<T extends { name: string }>(entries: readonly T[], query: string): readonly T[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return entries
  return entries.filter(entry => entry.name.toLowerCase().includes(needle))
}

/**
 * Whether a typed query names a path instead of filtering names.
 *
 * A directory name cannot contain `/`, so a query that does can never match one
 * and is unambiguously a path. `~` is the one path without a separator: it is
 * the remote home, and typing it as a filter would be meaningless anyway. `..`
 * is the same deal on the other end: no directory is named that, and it is how
 * a picker's box goes up one level.
 */
export function isPathQuery(query: string): boolean {
  const text = query.trim()
  return text === '..' || text.startsWith('~') || text.includes('/')
}

/** The box's path split into the directory to list and the segment being typed. */
export interface PathContext {
  /** The directory the suggestions come from, as typed (`~/src`, `/home`, ``, `..`). */
  base: string
  /** The part still being typed, `''` once the path names a directory. */
  needle: string
}

/**
 * Split the box's path at its last separator.
 *
 * The box holds the whole path and only its last segment is incomplete:
 * `/home/me/co` is the children of `/home/me` filtered by `co`. A trailing
 * separator means the path already names a directory (`/home/me/`), and so does
 * a last segment of `.` or `..`, which are steps rather than names — both leave
 * nothing to complete, so the listing below is not filtered by them.
 */
export function splitPath(text: string): PathContext {
  const raw = text.trim()
  const trimmed = raw.replace(/\/+$/, '')
  if (trimmed.length === 0) return { base: '/', needle: '' }
  if (raw.endsWith('/')) return { base: trimmed, needle: '' }
  // `~` and `~user` are whole paths, not a segment of one: the remote expands
  // the login home (or refuses), and a listing cannot complete either of them.
  if (trimmed.startsWith('~') && trimmed.indexOf('/') < 0) return { base: trimmed, needle: '' }
  const slash = trimmed.lastIndexOf('/')
  const last = slash < 0 ? trimmed : trimmed.slice(slash + 1)
  if (last === '.' || last === '..') return { base: trimmed, needle: '' }
  return { base: slash < 0 ? '' : trimmed.slice(0, slash), needle: last }
}

/**
 * The remote path a typed prefix is asked as.
 *
 * A relative prefix resolves against `origin`, the directory the box was empty
 * in. It stays put while the panel walks with the path, because resolving `a/b`
 * against the directory `a` the panel just entered would look for `a/a/b`. `~`
 * and `~user` stay as typed: the login home is the remote's answer. `.`, `..`,
 * and doubled separators are folded lexically here, and the remote realpath
 * settles symlinks when the listing is asked with `resolve`.
 */
export function resolveUnder(base: string, origin: string): string {
  const text = base.trim()
  if (text.length === 0 || text === '.') return origin
  if (text === '~' || text.startsWith('~/')) {
    const parts = normalizeSegments(text.slice(1), false)
    return parts.length === 0 ? '~' : `~/${parts.join('/')}`
  }
  // Someone else's home is not ours to expand.
  if (text.startsWith('~')) return text
  if (text.startsWith('/')) return absolutePath(text)
  return absolutePath(`${origin.replace(/\/+$/, '')}/${text}`)
}

/**
 * The box text after accepting a completion: the path names a directory now, so
 * it ends with `/` and the next segment can be typed straight away.
 */
export function joinPath(base: string, name: string): string {
  const raw = base.trim()
  const text = raw.replace(/\/+$/, '')
  // A base that was only separators is the root, not an empty prefix.
  if (text.length === 0) return raw.startsWith('/') ? `/${name}/` : `${name}/`
  return `${text}/${name}/`
}

/**
 * The `[start, end)` a case-insensitive match covers in a name, or `null` when
 * the name does not contain the typed segment. The listing uses it to show what
 * a row would add to the box, so the match has to be found rather than assumed
 * to be a prefix.
 */
export function matchRange(name: string, needle: string): [number, number] | null {
  const text = needle.trim().toLowerCase()
  if (text.length === 0) return null
  const at = name.toLowerCase().indexOf(text)
  return at < 0 ? null : [at, at + text.length]
}

/**
 * What Enter accepts, in the order a picker tries it: the highlighted row, the
 * only matching row, then a row named exactly like the typed segment. `none`
 * means there is nothing to complete (the path already ends at a directory) and
 * `missing` means nothing matched — reported as a message instead of asking the
 * remote for a directory that is not there.
 */
export function pickCompletion(input: {
  highlighted: number
  visibleCount: number
  exact: number
  needle: string
}): number | 'none' | 'missing' {
  if (input.highlighted >= 0) return input.highlighted
  // A path that already ends at a directory has nothing to complete: the rows
  // are that directory's children, and a lone child is not a completion of it.
  if (input.needle.trim().length === 0) return 'none'
  if (input.visibleCount === 1) return 0
  if (input.exact >= 0) return input.exact
  return 'missing'
}

/** `/a//b/./c/../d` -> `/a/b/d`; `..` never escapes an absolute path. */
function absolutePath(text: string): string {
  const parts = normalizeSegments(text, true)
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

function normalizeSegments(text: string, absolute: boolean): string[] {
  const out: string[] = []
  for (const part of text.split('/')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  return out
}

/**
 * Keep a highlighted row valid after the list changed under it. The filter can
 * shrink the listing while a row is highlighted, and an index past the end
 * would silently drop the highlight; clamping to the last row keeps the
 * keyboard user's place instead of losing it.
 */
export function clampActive(current: number, count: number): number {
  if (count <= 0) return -1
  if (current < 0) return -1
  return Math.min(current, count - 1)
}

/**
 * Move the highlighted row by `delta` (normally ±1).
 *
 * `-1` means "nothing highlighted": moving down from there starts at the first
 * row and moving up starts at the last one, which is what a keyboard user
 * expects from a list with no selection yet. The ends clamp rather than wrap —
 * wrapping makes a long listing jump and hides that you reached the end.
 */
export function stepActive(current: number, delta: number, count: number): number {
  if (count <= 0) return -1
  if (current < 0) return delta > 0 ? 0 : count - 1
  // Clamp here rather than through `clampActive`: -1 means "nothing
  // highlighted" for that helper, so walking up off the first row would clear
  // the highlight instead of staying on it.
  return Math.min(Math.max(current + delta, 0), count - 1)
}

/** Parent of a remote POSIX directory; `/` for the root. */
export function parentDir(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0) return '/'
  return trimmed.slice(0, slash)
}
