/**
 * Session-route state shared by the two remote terminal bridges.
 *
 * rc.2's `TerminalController.spawn` calls `prepare()`, which reaches
 * `subprocess.terminalEnvironment()` to resolve the default shell and to decide
 * the `HISTFILE` policy for an agent terminal. That call carries no cwd, so the
 * `sandbox.confine` / `subprocess.spawn` seams cannot route it by path the way
 * every other remote operation is routed.
 *
 * The wrapped `terminal.spawn` in `installSidebarBridge` does know the session
 * route. It runs the allocation inside an `AsyncLocalStorage` scope; only calls
 * made from that async call chain see the remote route. A concurrent local
 * session's `terminalEnvironment()` is therefore unaffected.
 *
 * `removeHistory` runs after the terminal allocation has ended and spawns
 * `rm -f -- /tmp/dsh-agent-history-<terminal id>` with `cwd: '/'`. That call is
 * outside the allocation scope, so the route is recorded by terminal id and
 * consumed once by an exact argv match. A stale or mismatched entry is ignored;
 * no "last remote terminal" guess is ever made.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface RemoteTerminalRoute {
  readonly hostId: string
  readonly remoteCwd: string
  readonly placeholderCwd: string
}

const active = new AsyncLocalStorage<RemoteTerminalRoute>()

/** How long a finished terminal's history-cleanup route stays usable. */
export const TERMINAL_HISTORY_ROUTE_TTL_MS = 24 * 60 * 60_000

interface HistoryRoute {
  readonly route: RemoteTerminalRoute
  readonly expires: number
}

const historyRoutes = new Map<string, HistoryRoute>()

/** Run one remote terminal allocation with its route visible to nested calls. */
export function runRemoteTerminal<T>(route: RemoteTerminalRoute, run: () => Promise<T>): Promise<T> {
  return active.run(route, run)
}

/** The route of the remote terminal allocation this async call belongs to. */
export function remoteTerminalRoute(): RemoteTerminalRoute | undefined {
  return active.getStore()
}

/** Remember where a terminal's post-exit history cleanup must run. */
export function rememberTerminalHistory(id: string, route: RemoteTerminalRoute): void {
  if (id.length === 0) return
  const now = Date.now()
  for (const [key, entry] of historyRoutes) {
    if (entry.expires <= now) historyRoutes.delete(key)
  }
  historyRoutes.set(id, { route, expires: now + TERMINAL_HISTORY_ROUTE_TTL_MS })
}

/**
 * Resolve the route for one exact upstream history-cleanup spawn.
 *
 * Upstream `removeHistory` is `rm -f -- /tmp/dsh-agent-history-<id>` with
 * `cwd: '/'`; any other argv or cwd is left to the ordinary local provider.
 * The entry is single-use, so a repeated or forged command cannot be routed
 * twice, and it expires after the terminal lifecycle.
 */
export function terminalHistoryRoute(argv: readonly string[], cwd: string): RemoteTerminalRoute | undefined {
  if (cwd !== '/') return undefined
  if (argv.length !== 4 || argv[0] !== 'rm' || argv[1] !== '-f' || argv[2] !== '--') return undefined
  const match = /^\/tmp\/dsh-agent-history-(.+)$/u.exec(argv[3] ?? '')
  if (match === null) return undefined
  const id = match[1]!
  const entry = historyRoutes.get(id)
  if (entry === undefined) return undefined
  historyRoutes.delete(id)
  if (entry.expires <= Date.now()) return undefined
  return entry.route
}

/** Test-only reset so a phase cannot inherit another test's state. */
export function resetRemoteTerminalState(): void {
  historyRoutes.clear()
}
