import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CHANNEL_GUIDES, guideFor, PROBE_GUIDES, renderGuide } from '../scripts/upstream-map.mjs'

/**
 * `src/upstream-worker.ts` is the authority, not a hand-copied list. Extract
 * every `failures.push(...)` literal (the template literal's `${...}` parts get
 * a placeholder) so a reworded probe fails here instead of silently losing its
 * runbook row.
 */
function sourceProbeFailures(): string[] {
  const source = readFileSync(new URL('../src/upstream-worker.ts', import.meta.url), 'utf8')
  const pushes = [...source.matchAll(/failures\.push\(\s*(['"`])(.*?)\1\s*\)/gsu)]
  assert.ok(pushes.length > 0, 'no failures.push(...) literals found in src/upstream-worker.ts')
  return pushes.map(match => match[2]!.replace(/\$\{[^}]*\}/gu, 'UPSTREAM_VALUE'))
}

test('every failures.push(...) literal in src resolves to a guide row', () => {
  const failures = sourceProbeFailures()
  assert.equal(
    failures.length,
    PROBE_GUIDES.length,
    'the number of probe failures in src/upstream-worker.ts drifted from PROBE_GUIDES',
  )
  const ids = failures.map(failure => {
    const guide = guideFor(failure)
    assert.notEqual(guide, undefined, `no guide row for probe failure: ${failure}`)
    assert.equal(typeof guide!.where, 'string')
    assert.notEqual(guide!.where.length, 0, `guide ${guide!.id} has no file to change`)
    assert.notEqual(guide!.next.length, 0, `guide ${guide!.id} has no next command`)
    return guide!.id
  })
  assert.equal(new Set(ids).size, PROBE_GUIDES.length, 'two probe failures map to the same guide row')
})

test('the interpolated control-env failure resolves after placeholder substitution', () => {
  const failures = sourceProbeFailures()
  const changed = failures.find(failure => failure.startsWith('control environment marker changed to'))
  assert.notEqual(changed, undefined, 'the template-literal probe was not extracted')
  assert.equal(guideFor(changed!)?.id, 'control-env-changed')
})

test('the upstream-map header no longer overclaims the guard', () => {
  const source = readFileSync(new URL('../scripts/upstream-map.mjs', import.meta.url), 'utf8')
  const header = source.slice(0, source.indexOf('*/') + 2)
  assert.match(header, /reads `src\/upstream-worker\.ts`/u)
  assert.match(header, /extracts every `failures\.push\(\.\.\.\)` literal/u)
  assert.doesNotMatch(header, /kept as literals|hard-?coded|fails here loudly/u)
})

test('the embedded control environment value still matches its row', () => {
  // The real message interpolates the upstream name, so matching is by prefix.
  const guide = guideFor('control environment marker changed to DSH_NEW_NAME; the shim expects DSH_SUBPROCESS_CONTROL')
  assert.equal(guide?.id, 'control-env-changed')
})

test('channel failures the upgrade script can hit also resolve', () => {
  for (const text of [
    'PTC shim did not print a control-channel handshake',
    'PTC shim did not acknowledge the TCP authentication token',
    'a frame came back as invalid-output',
  ]) {
    assert.notEqual(guideFor(text), undefined, `no guide row for: ${text}`)
  }
})

test('guide ids are unique across both tables', () => {
  const ids = [...PROBE_GUIDES, ...CHANNEL_GUIDES].map(guide => guide.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('an unknown failure resolves to nothing instead of throwing', () => {
  assert.equal(guideFor('something upstream did that nobody predicted'), undefined)
  assert.equal(guideFor(''), undefined)
})

test('renderGuide names the meaning, the file, and the next command', () => {
  const guide = PROBE_GUIDES.find(item => item.id === 'control-fd')!
  const text = renderGuide(guide).join('\n')
  assert.match(text, /\[control-fd\]/u)
  assert.match(text, /src\/ptc-shim\.mjs/u)
  assert.match(text, /npm run test:ptc/u)
})

test('the runbook decision table covers every probe guide', () => {
  // `scripts/upstream-map.mjs` and the probe source are pinned by the tests
  // above, but the human-facing table in `docs/upstream-ptc-worker.md` is a
  // third copy. A new probe would otherwise leave the runbook silently short.
  const docs = readFileSync(new URL('../docs/upstream-ptc-worker.md', import.meta.url), 'utf8')
  for (const guide of PROBE_GUIDES) {
    assert.ok(docs.includes(guide.match), `the runbook has no row for guide ${guide.id}: ${guide.match}`)
  }
  const header = '| Probe failure | Meaning | Change |'
  const start = docs.indexOf(header)
  assert.notEqual(start, -1, 'the runbook has no probe decision table')
  const end = docs.indexOf('\n\n', start)
  const tableRows = docs.slice(start, end === -1 ? undefined : end).split('\n').filter(line => line.startsWith('| `'))
  assert.equal(tableRows.length, PROBE_GUIDES.length, 'the probe decision table must have exactly one row per guide')
})

test('each guide points at a file that exists', () => {
  // Guards against a renamed module leaving the runbook pointing at nothing.
  const sources = [...PROBE_GUIDES, ...CHANNEL_GUIDES].flatMap(guide =>
    [...guide.where.matchAll(/`?((?:src|scripts)\/[\w.-]+)/gu)].map(match => match[1]))
  assert.ok(sources.length > 0)
  for (const source of new Set(sources)) {
    assert.doesNotThrow(() => {
      readFileSync(new URL(`../${source}`, import.meta.url))
    }, `${source} is named in the guide table but is not readable`)
  }
})
