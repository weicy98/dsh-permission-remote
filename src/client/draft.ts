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
 * everything. Filtering stays local — a keystroke must not wait for the remote.
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

/**
 * The directory a typed query names, or `null` when it is a plain name filter.
 *
 * The listing box doubles as a path field: `/home/me`, `~/src`, `../shared`,
 * `..`, and `me/projects` all resolve here, so walking into a deep directory
 * does not mean clicking one level at a time. Relative queries resolve against
 * `cwd`, which is always an absolute listing path.
 *
 * `..`, `.`, and repeated separators are resolved lexically; symlinked parents
 * cannot be known here, and the remote realpath settles those when the listing
 * is requested. A leading `~` stays in the result: the remote home is the
 * remote's answer, not something this side can assume. `~user` is left exactly
 * as typed for the same reason — only the remote can say whose home that is,
 * and reading it as a child of the listed directory would be a guess.
 */
export function pathQuery(query: string, cwd: string): string | null {
  const text = query.trim()
  if (!isPathQuery(text)) return null
  if (text === '~' || text.startsWith('~/')) {
    const parts = normalizeSegments(text.slice(1), false)
    return parts.length === 0 ? '~' : `~/${parts.join('/')}`
  }
  // Someone else's home is not ours to expand.
  if (text.startsWith('~')) return text
  if (text.startsWith('/')) return absolutePath(text)
  // `cwd` is absolute, so appending the query keeps absolute semantics: `..`
  // above the root stays at the root instead of producing a relative path.
  const base = cwd.replace(/\/+$/, '')
  return absolutePath(`${base}/${text}`)
}

/**
 * The part of a typed path that names something in the listing, so typing
 * `/home/we` keeps `weichongyong` visible while the walk is being typed.
 *
 * It is read from the text, not from the resolved path: `..` resolves to a
 * directory whose name is not on screen, and narrowing by it would empty a
 * listing the operator is only asking to leave. `~` and the relative steps name
 * nothing here, so they contribute nothing.
 */
export function pathTail(query: string): string {
  const text = query.trim()
  if (!isPathQuery(text)) return ''
  const parts = text.split('/')
    .filter(part => part.length > 0 && part !== '.' && part !== '..' && part !== '~')
  return parts.length === 0 ? '' : parts[parts.length - 1] ?? ''
}

/**
 * The directories a typed query may name, in the order they are tried.
 *
 * A relative query is read from the listed directory first, the way a picker
 * resolves what is typed, and then — for a bare relative query such as
 * `home/me` — from the root: typing a path without its leading `/` is the
 * common slip. A query that starts with `/` or `~` means itself, and `..` is
 * already relative to `cwd` in the only way it can be, so neither gets a retry.
 */
export function pathCandidates(query: string, cwd: string): string[] {
  const first = pathQuery(query, cwd)
  if (first === null) return []
  const text = query.trim()
  if (text === '..' || text.startsWith('/') || text.startsWith('~')) return [first]
  const fromRoot = pathQuery(`/${text}`, '/')
  return fromRoot === null || fromRoot === first ? [first] : [first, fromRoot]
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
