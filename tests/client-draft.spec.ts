import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostView } from '../src/client/api.ts'
import { blankDraft, clampActive, createTarget, draftPort, draftPortValid, filterEntries, isPathQuery, joinPath, matchRange, mergeEditedHost, parentDir, pickCompletion, resolveUnder, splitPath, stepActive, toDraft } from '../src/client/draft.ts'

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

test('only a separator, a leading ~, or .. opens path mode', () => {
  // A name filter cannot contain `/`, so the two meanings never collide; `~`
  // and `..` are not names a directory can have either.
  assert.equal(isPathQuery('src'), false)
  assert.equal(isPathQuery('  src  '), false)
  // A single dot names the directory already on screen, so it stays a filter.
  assert.equal(isPathQuery('.'), false)
  assert.equal(isPathQuery('..'), true)
  assert.equal(isPathQuery('~/'), true)
  assert.equal(isPathQuery('~'), true)
  assert.equal(isPathQuery('~me/src'), true)
  assert.equal(isPathQuery('/home'), true)
  assert.equal(isPathQuery('src/lib'), true)
})

test('a typed path splits at its last separator', () => {
  // The box holds the whole path; only its last segment is incomplete, and that
  // segment is what the rows below complete.
  assert.deepEqual(splitPath('/home/me/co'), { base: '/home/me', needle: 'co' })
  assert.deepEqual(splitPath('/home/me'), { base: '/home', needle: 'me' })
  // A trailing separator means the path already names a directory.
  assert.deepEqual(splitPath('/home/me/'), { base: '/home/me', needle: '' })
  assert.deepEqual(splitPath('/'), { base: '/', needle: '' })
  assert.deepEqual(splitPath('/home/me//'), { base: '/home/me', needle: '' })
  // `~` is the remote home; `~me` is somebody else's, and neither is a segment
  // a listing could complete.
  assert.deepEqual(splitPath('~'), { base: '~', needle: '' })
  assert.deepEqual(splitPath('~/'), { base: '~', needle: '' })
  assert.deepEqual(splitPath('~/src'), { base: '~', needle: 'src' })
  assert.deepEqual(splitPath('~/src/'), { base: '~/src', needle: '' })
  assert.deepEqual(splitPath('~me'), { base: '~me', needle: '' })
  assert.deepEqual(splitPath('~me/src'), { base: '~me', needle: 'src' })
  // `.` and `..` are steps, not names: the listing under them is unfiltered.
  assert.deepEqual(splitPath('..'), { base: '..', needle: '' })
  assert.deepEqual(splitPath('../shared'), { base: '..', needle: 'shared' })
  assert.deepEqual(splitPath('/a/b/..'), { base: '/a/b/..', needle: '' })
  // A relative path keeps its spelling; the panel resolves it against `origin`.
  assert.deepEqual(splitPath('a/b'), { base: 'a', needle: 'b' })
  assert.deepEqual(splitPath('co'), { base: '', needle: 'co' })
  assert.deepEqual(splitPath('   '), { base: '/', needle: '' })
})

test('a typed prefix resolves against the directory typing started in', () => {
  assert.equal(resolveUnder('', '/home/me'), '/home/me')
  assert.equal(resolveUnder('.', '/home/me'), '/home/me')
  // The tilde is the remote's to expand, so it stays as typed.
  assert.equal(resolveUnder('~', '/srv'), '~')
  assert.equal(resolveUnder('~/src', '/srv'), '~/src')
  assert.equal(resolveUnder('~/src/', '/srv'), '~/src')
  assert.equal(resolveUnder('~/src/../lib', '/srv'), '~/lib')
  // Another account's home is not ours to expand either.
  assert.equal(resolveUnder('~me/src', '/srv'), '~me/src')
  assert.equal(resolveUnder('/home/me', '/srv'), '/home/me')
  assert.equal(resolveUnder('//home///me/', '/srv'), '/home/me')
  assert.equal(resolveUnder('home/me', '/'), '/home/me')
  assert.equal(resolveUnder('../shared', '/home/me'), '/home/shared')
  // Above the root there is nothing, and an escape must not be invented.
  assert.equal(resolveUnder('../../..', '/'), '/')
  assert.equal(resolveUnder('/../etc', '/'), '/etc')
})

test('accepting a row leaves the box on a directory', () => {
  assert.equal(joinPath('/home/me', 'code'), '/home/me/code/')
  assert.equal(joinPath('/home/me/', 'code'), '/home/me/code/')
  assert.equal(joinPath('/', 'home'), '/home/')
  assert.equal(joinPath('~', 'src'), '~/src/')
  assert.equal(joinPath('', 'code'), 'code/')
  assert.equal(joinPath('..', 'shared'), '../shared/')
})

test('the matched part of a name is what the row would add', () => {
  assert.deepEqual(matchRange('code', 'co'), [0, 2])
  // The match is found rather than assumed to be a prefix.
  assert.deepEqual(matchRange('node_modules', 'mod'), [5, 8])
  assert.deepEqual(matchRange('Code', 'co'), [0, 2])
  assert.equal(matchRange('code', ''), null)
  assert.equal(matchRange('code', 'zz'), null)
})

test('Enter completes the best match and explains a miss', () => {
  const base = { highlighted: -1, visibleCount: 3, exact: -1, needle: 'co' }
  // A highlighted row wins over everything else.
  assert.equal(pickCompletion({ ...base, highlighted: 2 }), 2)
  // A single candidate is unambiguous.
  assert.equal(pickCompletion({ ...base, visibleCount: 1 }), 0)
  // Otherwise a row named exactly like the typed segment.
  assert.equal(pickCompletion({ ...base, exact: 1 }), 1)
  // Nothing to complete once the path already ends at a directory — not even
  // its only child, which is not a completion of the path itself.
  assert.equal(pickCompletion({ ...base, visibleCount: 0, needle: '' }), 'none')
  assert.equal(pickCompletion({ ...base, visibleCount: 1, needle: '' }), 'none')
  // A miss is reported without asking the remote for a directory that is not there.
  assert.equal(pickCompletion({ ...base, visibleCount: 0 }), 'missing')
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
