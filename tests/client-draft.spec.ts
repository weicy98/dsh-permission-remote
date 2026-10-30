import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostView } from '../src/client/api.ts'
import { blankDraft, clampActive, createTarget, draftPort, draftPortValid, filterEntries, mergeEditedHost, parentDir, stepActive, toDraft } from '../src/client/draft.ts'

function host(overrides: Partial<HostView> = {}): HostView {
  return {
    id: 'h1',
    name: 'dev',
    host: '10.0.0.5',
    port: 22,
    username: 'me',
    auth: 'key',
    privateKeyPath: '/home/me/.ssh/id_ed25519',
    fingerprint: 'SHA256:abc',
    opsPolicy: 'ask',
    loginEnv: false,
    ...overrides,
  }
}

test('saving an open form keeps a fingerprint trusted after the form was opened', () => {
  // The form was opened before the trust, so its own fingerprint field is empty.
  const form = { ...toDraft(host({ fingerprint: '' })), name: 'prod' }
  const merged = mergeEditedHost(host({ fingerprint: 'SHA256:new' }), form)
  assert.equal(merged.fingerprint, 'SHA256:new')
  assert.equal(merged.name, 'prod')
})

test('the form owns the fields it edits and the stored row owns the rest', () => {
  // The policy select lives in the form, so a change made there is what is saved.
  const form = { ...toDraft(host({ opsPolicy: 'ask' })), opsPolicy: 'trust' as const, name: 'prod' }
  const merged = mergeEditedHost(host({ opsPolicy: 'ask', fingerprint: 'SHA256:new' }), form)
  assert.equal(merged.opsPolicy, 'trust')
  assert.equal(merged.name, 'prod')
  assert.equal(merged.fingerprint, 'SHA256:new')
})

test('the draft has no fingerprint the form cannot edit', () => {
  assert.equal('fingerprint' in toDraft(host()), false)
  assert.equal('fingerprint' in blankDraft(), false)
})

test('changing the address or port drops the fingerprint', () => {
  const changedAddress = { ...toDraft(host()), host: '10.0.0.9' }
  assert.equal(mergeEditedHost(host(), changedAddress).fingerprint, '')
  const changedPort = { ...toDraft(host()), port: '2222' }
  assert.equal(mergeEditedHost(host(), changedPort).fingerprint, '')
})

test('the form keeps the login environment switch', () => {
  assert.equal(blankDraft().loginEnv, false)
  assert.equal(toDraft(host()).loginEnv, false)
  assert.equal(toDraft(host({ loginEnv: true })).loginEnv, true)
  const turnedOn = { ...toDraft(host({ loginEnv: false })), loginEnv: true }
  assert.equal(mergeEditedHost(host({ loginEnv: false, fingerprint: 'SHA256:new' }), turnedOn).loginEnv, true)
  // A rename must not drop a switch the form did not change.
  const untouched = { ...toDraft(host({ loginEnv: true })), name: 'prod' }
  assert.equal(mergeEditedHost(host({ loginEnv: true }), untouched).loginEnv, true)
})

test('a new host keeps no fingerprint and takes the form policy', () => {
  const form = { ...blankDraft(), host: '10.0.0.7', username: 'me', opsPolicy: 'trust' as const }
  const merged = mergeEditedHost(undefined, form)
  assert.equal(merged.fingerprint, '')
  assert.equal(merged.opsPolicy, 'trust')
  assert.equal(merged.port, 22)
})

test('the port field can be cleared while typing', () => {
  const form = { ...blankDraft(), port: '' }
  assert.equal(draftPort(form), 22)
  assert.equal(draftPortValid(form), false)
  assert.equal(draftPortValid({ ...form, port: '0' }), false)
  assert.equal(draftPortValid({ ...form, port: '70000' }), false)
  assert.equal(draftPortValid({ ...form, port: '2222' }), true)
})

test('no workspace target exists before a listing succeeds', () => {
  assert.equal(createTarget('h1', false), null)
  assert.equal(createTarget('', true), null)
  assert.equal(createTarget('h1', true), 'h1')
})

test('the draft round-trips the numeric port', () => {
  assert.deepEqual(toDraft(host({ port: 2222 })).port, '2222')
})

test('parentDir stops at the root', () => {
  assert.equal(parentDir('/srv/app'), '/srv')
  assert.equal(parentDir('/srv'), '/')
  assert.equal(parentDir('/'), '/')
})

test('the directory filter matches names, ignoring case and surrounding space', () => {
  const entries = [{ name: 'src' }, { name: 'node_modules' }, { name: 'SourceMaps' }]
  assert.deepEqual(filterEntries(entries, 'SO').map(entry => entry.name), ['SourceMaps'])
  assert.deepEqual(filterEntries(entries, '  SOURCE ').map(entry => entry.name), ['SourceMaps'])
  // A cleared box must not filter anything out.
  assert.equal(filterEntries(entries, ''), entries)
  assert.equal(filterEntries(entries, '   '), entries)
  // No match is a real result; the list renders its own empty message for it.
  assert.deepEqual(filterEntries(entries, 'zzz'), [])
})

test('the directory filter never matches on the encoded path', () => {
  // Every entry's path begins with the current directory, so matching paths
  // would make any query that is a substring of that directory match all rows.
  const entries = [{ name: 'src', path: '/home/me/code/src' }, { name: 'lib', path: '/home/me/code/lib' }]
  assert.deepEqual(filterEntries(entries, 'code'), [])
})

test('arrow keys start at an end and clamp instead of wrapping', () => {
  // -1 is "nothing highlighted": down starts at the first row, up at the last.
  assert.equal(stepActive(-1, 1, 3), 0)
  assert.equal(stepActive(-1, -1, 3), 2)
  assert.equal(stepActive(0, 1, 3), 1)
  assert.equal(stepActive(2, 1, 3), 2)
  assert.equal(stepActive(0, -1, 3), 0)
})

test('an empty listing has no highlighted row', () => {
  assert.equal(stepActive(-1, 1, 0), -1)
  assert.equal(stepActive(2, -1, 0), -1)
  assert.equal(clampActive(4, 0), -1)
})

test('a highlighted row is clamped when the filter shrinks the list', () => {
  // Index 4 was valid before a keystroke narrowed the listing to two rows.
  assert.equal(clampActive(4, 2), 1)
  assert.equal(clampActive(1, 2), 1)
  assert.equal(clampActive(-1, 2), -1)
})
