import assert from 'node:assert/strict'
import test from 'node:test'
import type { RemoteRootChange } from '../src/client/api.ts'
import { rootPromptFor } from '../src/client/root-prompt.ts'

/**
 * The two-round remote-root flow.
 *
 * A target with both live sessions and conflicting files needs two answers.
 * The regression this guards: the second round dropped the first answer, so the
 * page asked about sessions again and the pair could never finish.
 */

const sessions: RemoteRootChange = { status: 'has-sessions', oldRoot: '/old', root: '/new', sessions: 2 }
const conflicts: RemoteRootChange = { status: 'needs-strategy', oldRoot: '/old', root: '/new', conflicts: ['host1/x'] }
const changed: RemoteRootChange = { status: 'changed', oldRoot: '/old', root: '/new', migration: { copied: 1, skipped: 0, overwritten: 0, conflicts: [] }, workspacesRemapped: 1 }

test('both conditions resolve: accept sessions, then pick a strategy with force kept', () => {
  let force = false
  const first = rootPromptFor(sessions, force)
  assert.equal(first.prompt?.kind, 'sessions')
  assert.equal(first.force, false)

  // The operator clicks "migrate anyway".
  force = true
  const second = rootPromptFor(conflicts, force)
  assert.equal(second.prompt?.kind, 'conflicts')
  // Without this the next request would hit the session gate again, forever.
  assert.equal(second.force, true)

  const done = rootPromptFor(changed, second.force)
  assert.equal(done.prompt, null)
  assert.equal(done.force, false)
})

test('a strategy alone (no live sessions) goes straight through', () => {
  const state = rootPromptFor(conflicts, false)
  assert.equal(state.prompt?.kind, 'conflicts')
  assert.equal(state.force, false)
})

test('a session prompt never reuses an earlier confirmation', () => {
  // A fresh attempt after accepting must ask again, so a stale "yes" cannot be
  // applied to a target the operator did not look at.
  const state = rootPromptFor(sessions, true)
  assert.equal(state.prompt?.kind, 'sessions')
  assert.equal(state.force, false)
})

test('a finished change clears the prompt state', () => {
  const state = rootPromptFor(changed, true)
  assert.deepEqual(state, { prompt: null, force: false })
})

test('an unchanged root also reports without a prompt', () => {
  const state = rootPromptFor({ status: 'unchanged', oldRoot: '/old', root: '/old' }, true)
  assert.deepEqual(state, { prompt: null, force: false })
})

test('the conflict prompt carries the paths, not just a count', () => {
  const state = rootPromptFor(conflicts, false)
  assert.deepEqual(state.prompt?.conflicts, ['host1/x'])
})
