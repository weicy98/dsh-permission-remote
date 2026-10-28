/**
 * Pure form/browse helpers for the settings section.
 *
 * The form is a long-lived copy of one host row. Trusting a fingerprint updates
 * the stored row, which the form does not edit, so a later save takes `id` and
 * `fingerprint` from the latest row. `opsPolicy` is a form field, so the form's
 * value is what gets saved. A successful change on the host card copies that
 * policy back into an open form.
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
  }
}

/** The host a new workspace may be created for; `null` until a listing succeeds. */
export function createTarget(browsing: string, listed: boolean): string | null {
  return browsing.length > 0 && listed ? browsing : null
}

/** Parent of a remote POSIX directory; `/` for the root. */
export function parentDir(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  if (slash <= 0) return '/'
  return trimmed.slice(0, slash)
}
