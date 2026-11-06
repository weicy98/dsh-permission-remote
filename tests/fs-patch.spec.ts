import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { applyHunks, parsePatch, type PatchHunk } from '../src/patch-hunks.ts'

/** Build one `*** Update File:` patch with the given hunk body lines. */
const P = (...lines: string[]) =>
  ['*** Begin Patch', '*** Update File: f.txt', ...lines, '*** End Patch'].join('\n')

/** Extract the ordered hunks of the first update operation from a patch. */
function updateHunks(parse: typeof parsePatch, patch: string): PatchHunk[] {
  const op = parse(patch).find((o) => o.kind === 'update')
  return op && op.kind === 'update' ? op.hunks : []
}

// ---------------------------------------------------------------------------
// Golden behaviour of the vendored applyHunks (hunks built via parsePatch)
// ---------------------------------------------------------------------------

test('applyHunks: trailing empty line + basic replacement', () => {
  const hunks = updateHunks(parsePatch, P('@@', ' alpha', '-beta', '+BETA', ' gamma'))
  const result = applyHunks('alpha\nbeta\ngamma\n', hunks)
  assert.deepEqual(result, { ok: true, after: 'alpha\nBETA\ngamma\n' })
  assert.ok(result.ok && result.after.endsWith('\n'), 'successful output ends in LF')
})

test('applyHunks: successful nonempty output gains a trailing LF', () => {
  // Unterminated input; the algorithm still terminates output with LF.
  const hunks = updateHunks(parsePatch, P('@@', '-a', '+A', ' b'))
  const result = applyHunks('a\nb', hunks)
  assert.deepEqual(result, { ok: true, after: 'A\nb\n' })
})

test('applyHunks: hunk ending in an empty context line is retried without its sentinel', () => {
  const hunks = updateHunks(parsePatch, P('@@', '-a', '+A', ' b', ''))
  // The trailing empty context line becomes an "" sentinel at the end of oldLines.
  assert.equal(hunks[0].oldLines.at(-1), '')
  assert.deepEqual(applyHunks('a\nb\n', hunks), { ok: true, after: 'A\nb\n' })
})

test('applyHunks: @@ context anchor disambiguates duplicate lines', () => {
  const hunks = updateHunks(parsePatch, P('@@ y', '-target', '+HIT'))
  assert.equal(hunks[0].context, 'y')
  // The anchor advances the cursor past the first 'target', so the second is replaced.
  assert.deepEqual(applyHunks('x\ntarget\ny\ntarget\nz\n', hunks), {
    ok: true,
    after: 'x\ntarget\ny\nHIT\nz\n',
  })
})

test('applyHunks: *** End of File anchors the hunk to the tail', () => {
  const hunks = updateHunks(parsePatch, P('@@', ' dup1', '-dup2', '+CHANGED', '*** End of File'))
  assert.equal(hunks[0].isEndOfFile, true)
  // With EOF tail semantics the LAST matching pair is changed, not the first.
  assert.deepEqual(applyHunks('dup1\ndup2\ndup1\ndup2\n', hunks), {
    ok: true,
    after: 'dup1\ndup2\ndup1\nCHANGED\n',
  })
})

test('applyHunks: empty lines match correctly', () => {
  const hunks = updateHunks(parsePatch, P('@@', ' A', '', '+INSERT', ' B'))
  assert.deepEqual(hunks[0].oldLines, ['A', '', 'B'])
  assert.deepEqual(applyHunks('A\n\nB\n', hunks), { ok: true, after: 'A\n\nINSERT\nB\n' })
})

test('applyHunks: whitespace-only lines match correctly', () => {
  // A context line whose content is two spaces is written as '   ' (prefix + content).
  const hunks = updateHunks(parsePatch, P('@@', '   ', ' X', '-Y', '+Z'))
  assert.deepEqual(hunks[0].oldLines, ['  ', 'X', 'Y'])
  assert.deepEqual(applyHunks('  \nX\nY\n', hunks), { ok: true, after: '  \nX\nZ\n' })
})

test('applyHunks: context mismatch returns {ok:false, failure:{hunkLineNumber,stage}}', () => {
  const hunks = updateHunks(parsePatch, P('@@ MISSING', '-beta', '+BETA'))
  const result = applyHunks('alpha\nbeta\n', hunks)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.failure.stage, 'context')
  assert.equal(result.ok === false && result.failure.hunkLineNumber, hunks[0].lineNumber)
  assert.ok(result.ok === false && Array.isArray(result.failure.pattern))
})

test('applyHunks: oldLines mismatch returns {ok:false, failure:{hunkLineNumber,stage}}', () => {
  const hunks = updateHunks(parsePatch, P('@@', '-DOES_NOT_EXIST', '+NEW'))
  const result = applyHunks('alpha\nbeta\n', hunks)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.failure.stage, 'oldLines')
  assert.equal(result.ok === false && result.failure.hunkLineNumber, hunks[0].lineNumber)
})

test('applyHunks: no partial output when a later hunk fails', () => {
  const before = 'one\ntwo\nthree\n'
  const hunks = updateHunks(parsePatch, P('@@', '-one', '+ONE', '@@', '-MISSING', '+X'))
  assert.equal(hunks.length, 2)
  // The first hunk alone would succeed...
  assert.deepEqual(applyHunks(before, [hunks[0]]), { ok: true, after: 'ONE\ntwo\nthree\n' })
  // ...but a failure in the second hunk discards all replacements: no `after`, no partial text.
  const result = applyHunks(before, hunks)
  assert.equal(result.ok, false)
  assert.equal('after' in result, false, 'failure must not carry partially updated text')
  assert.deepEqual(Object.keys(result).sort(), ['failure', 'ok'])
  assert.equal(result.ok === false && result.failure.stage, 'oldLines')
  // applyHunks is pure: the caller's input is untouched.
  assert.equal(before, 'one\ntwo\nthree\n')
})
