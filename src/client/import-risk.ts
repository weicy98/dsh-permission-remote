/**
 * Whether an import file should be confirmed before it is applied.
 *
 * A changed address drops the saved password, and relaxing ops policy lets
 * commands run with less asking. Omitting a field is not a change: the server
 * keeps the current value.
 */
export interface ImportRiskHost {
  id: string
  host: string
  opsPolicy: string
}

export function importNeedsConfirm(payload: unknown, current: readonly ImportRiskHost[]): boolean {
  const byId = new Map(current.map(host => [host.id, host]))
  for (const row of hostRows(payload)) {
    if (typeof row.id !== 'string') continue
    const existing = byId.get(row.id)
    if (existing === undefined) continue
    if (owns(row, 'host') && typeof row.host === 'string' && row.host.trim() !== existing.host.trim()) return true
    if (!owns(row, 'opsPolicy')) continue
    if (row.opsPolicy === 'trust' && existing.opsPolicy !== 'trust') return true
    if (row.opsPolicy === 'ask' && existing.opsPolicy === 'deny') return true
  }
  return false
}

interface HostRow {
  id?: unknown
  host?: unknown
  opsPolicy?: unknown
}

function hostRows(payload: unknown): HostRow[] {
  const rows = Array.isArray(payload)
    ? payload
    : (typeof payload === 'object' && payload !== null && Array.isArray((payload as { hosts?: unknown }).hosts)
      ? (payload as { hosts: unknown[] }).hosts
      : [])
  return rows.filter((row): row is HostRow => typeof row === 'object' && row !== null)
}

function owns(row: HostRow, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row, key)
}
