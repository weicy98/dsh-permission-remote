import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { applyHunks, type PatchHunk } from '../src/patch-hunks.ts'
import { parsePatch } from '../vendor/fs-patch/index.js'

/** Build one `*** Update File:` patch with the given hunk body lines. */
const P = (...lines: string[]) =>
  ['*** Begin Patch', '*** Update File: f.txt', ...lines, '*** End Patch'].join('\n')

/** Extract the ordered hunks of the first update operation from a patch. */
function updateHunks(parse: typeof parsePatch, patch: string): PatchHunk[] {
  const op = parse(patch).find((o) => o.kind === 'update')
  return op && op.kind === 'update' ? op.hunks : []
}

// ---------------------------------------------------------------------------
// Verbatim vendoring integrity
// ---------------------------------------------------------------------------

test('vendored file hashes match SOURCE.md and vendor/fs-patch/verify.mjs', () => {
  const vendorDir = fileURLToPath(new URL('../vendor/fs-patch/', import.meta.url))
  const source = readFileSync(new URL('../vendor/fs-patch/SOURCE.md', import.meta.url), 'utf8')
  const expected = new Map<string, string>()
  const line = /^\s*-\s*`([^`]+)`:\s*`([a-fA-F0-9]{64})`\s*$/gm
  let match: RegExpExecArray | null
  while ((match = line.exec(source)) !== null) expected.set(match[1], match[2].toLowerCase())

  for (const name of ['index.js', 'types.d.ts', 'LICENSE']) {
    const actual = createHash('sha256')
      .update(readFileSync(path.join(vendorDir, name)))
      .digest('hex')
    assert.equal(expected.get(name), actual, `SHA-256 mismatch for vendored ${name}`)
  }

  const script = fileURLToPath(new URL('../vendor/fs-patch/verify.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(run.status, 0, `verify-vendor.mjs failed:\n${run.stdout}${run.stderr}`)
})

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

// ---------------------------------------------------------------------------
// Differential: vendored implementation vs the upstream DSH installation
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('differential: vendored applyHunks matches upstream (seeded, ~300 cases)', async (t) => {
  // Load the upstream package from the global DSH installation. The anchor is the
  // DSH root package.json relative to the running node binary (verified on this machine).
  let applyUp: typeof applyHunks
  let parseUp: typeof parsePatch
  try {
    const anchor = path.resolve(
      path.dirname(process.execPath),
      '../lib/node_modules/@deepseek-ai/dsh/package.json',
    )
    const require = createRequire(anchor)
    const url = pathToFileURL(require.resolve('@deepseek-ai/dsh-fs-patch')).href
    const mod = await import(url)
    applyUp = mod.applyHunks
    parseUp = mod.parsePatch
  } catch (err) {
    t.skip(`upstream @deepseek-ai/dsh-fs-patch unavailable: ${(err as Error).message}`)
    return
  }

  const rng = mulberry32(0x5eed1234)

  type Before = { text: string; lines: string[] }
  function randomBefore(r: () => number): Before {
    const n = 1 + Math.floor(r() * 12)
    const lines: string[] = []
    for (let i = 0; i < n; i++) lines.push('w' + Math.floor(r() * 100000))
    // LF-only text, occasionally unterminated.
    return { text: lines.join('\n') + (r() < 0.8 ? '\n' : ''), lines }
  }
  // A patch derived from a contiguous slice of the before text -> matches (ok:true).
  function matchingPatch(r: () => number, lines: string[]): string {
    const start = Math.floor(r() * lines.length)
    const len = Math.min(lines.length - start, 1 + Math.floor(r() * 3))
    const body: string[] = []
    for (const l of lines.slice(start, start + len)) {
      if (r() < 0.5) body.push(' ' + l)
      else {
        body.push('-' + l)
        body.push('+' + ('NEW' + Math.floor(r() * 100000)))
      }
    }
    return P('@@', ...body)
  }
  // A patch whose anchor / old lines cannot be in the before text -> ok:false.
  function mismatchPatch(r: () => number): string {
    return r() < 0.5
      ? P('@@ ZZZanchor', '-q', '+r')
      : P('@@', '-ZZZ' + Math.floor(r() * 1e6), '+YYY')
  }
  // Fully random patch for extra shape variety; may contain context anchors / EOF.
  function randomPatch(r: () => number, lines: string[]): string {
    const parts = ['*** Begin Patch', '*** Update File: f.txt']
    const hunkCount = 1 + Math.floor(r() * 3)
    for (let h = 0; h < hunkCount; h++) {
      if (r() < 0.3) parts.push('@@ ' + (lines.length ? lines[Math.floor(r() * lines.length)] : 'q'))
      else parts.push('@@')
      const bodyCount = 1 + Math.floor(r() * 4)
      for (let b = 0; b < bodyCount; b++) {
        const q = r()
        const src = lines.length ? lines[Math.floor(r() * lines.length)] : 'q'
        if (q < 0.4) parts.push(' ' + src)
        else if (q < 0.7) parts.push('-' + src)
        else parts.push('+' + ('N' + Math.floor(r() * 100000)))
      }
      if (r() < 0.2) parts.push('*** End of File')
    }
    parts.push('*** End Patch')
    return parts.join('\n')
  }

  let okTrue = 0
  let okFalse = 0
  for (let i = 0; i < 300; i++) {
    const { text, lines } = randomBefore(rng)
    let patch: string
    if (i % 3 === 0) patch = matchingPatch(rng, lines)
    else if (i % 3 === 1) patch = mismatchPatch(rng)
    else patch = randomPatch(rng, lines)

    let hunks: PatchHunk[]
    try {
      hunks = updateHunks(parseUp, patch)
    } catch {
      continue // a malformed random patch is skipped (parsePatch throws)
    }
    if (hunks.length === 0) continue

    const vendored = applyHunks(text, hunks)
    const upstream = applyUp(text, hunks)
    assert.deepEqual(vendored, upstream, `differential mismatch at iteration ${i}`)
    if (vendored.ok) okTrue++
    else okFalse++
  }
  assert.ok(okTrue > 0, 'expected some {ok:true, after} results')
  assert.ok(okFalse > 0, 'expected some {ok:false, failure} results')

  // CRLF-pre-normalized input: callers normalize CR away before applyHunks.
  const crlf = 'one\r\ntwo\r\nthree\r\n'
  const normalized = crlf.replace(/\r\n/g, '\n')
  const crlfHunks = updateHunks(parseUp, P('@@', ' one', '-two', '+TWO', ' three'))
  assert.deepEqual(
    applyHunks(normalized, crlfHunks),
    applyUp(normalized, crlfHunks),
    'CRLF-pre-normalized input must match upstream',
  )
  // Both implementations also agree on raw CRLF (no CR line-ending handling, by design).
  assert.deepEqual(
    applyHunks(crlf, crlfHunks),
    applyUp(crlf, crlfHunks),
    'raw CRLF input must match upstream',
  )
})
