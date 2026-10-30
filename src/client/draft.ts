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
