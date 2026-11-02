import type { RemoteRootChange } from './api.ts'

/**
 * The remote-root change the page is waiting on the operator to decide.
 *
 * Kept out of the component so the two-round flow can be tested: a target with
 * both live sessions and conflicting files asks twice, and the second round
 * must not forget the first answer.
 */
export interface RootPrompt {
  kind: 'sessions' | 'conflicts'
  root: string
  sessions?: number
  conflicts?: string[]
}

export interface RootPromptState {
  prompt: RootPrompt | null
  /** What the next request must send as `force`. */
  force: boolean
}

/**
 * What one server result means for the prompt state.
 *
 * `has-sessions` always re-asks, so a confirmation cannot be recycled for a
 * different target. `needs-strategy` carries `force` through: the operator
 * already accepted the open sessions and only has to pick a strategy now. A
 * result that finishes the change clears it.
 */
export function rootPromptFor(result: RemoteRootChange, force: boolean): RootPromptState {
  if (result.status === 'has-sessions') {
    return { prompt: { kind: 'sessions', root: result.root, sessions: result.sessions ?? 0 }, force: false }
  }
  if (result.status === 'needs-strategy') {
    return { prompt: { kind: 'conflicts', root: result.root, conflicts: result.conflicts ?? [] }, force }
  }
  return { prompt: null, force: false }
}
