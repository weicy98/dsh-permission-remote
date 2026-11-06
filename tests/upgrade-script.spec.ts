import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { run, testCounts } from '../scripts/upgrade.mjs'
import { run as checkRun } from '../scripts/check-upstream.mjs'

/**
 * The upgrade gate must never record a worker it did not verify. The risk is
 * silent: `node --test` exits 0 when its file pattern matches nothing, and the
 * live suite exits 0 when every test skips. Both look green to a shell `&&`
 * chain, so each of those cases is exercised here against the real script.
 */

interface Outcome {
  readonly code: number
  readonly wrote?: string
}

function harness(argv: string[], execute?: (command: string, args: string[], env?: Record<string, string | undefined>) => { status: number | null, stdout: string, stderr: string, error?: string }) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-upgrade-'))
  const previousHome = process.env.DSH_HOME
  const previousLive = process.env.DSH_PTC_LIVE
  const previousRoot = process.env.DSH_INSTALL_ROOT
  process.env.DSH_HOME = home
  const lines: string[] = []
  const errors: string[] = []
  const outcome = (): Outcome => run({
    argv,
    log: line => lines.push(line),
    error: line => errors.push(line),
    execute,
  }) as Outcome
  return {
    home,
    lines,
    errors,
    outcome,
    overlay: () => join(home, 'permission-remote', 'upstream-ptc.manifest.json'),
    restore: () => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      if (previousLive === undefined) delete process.env.DSH_PTC_LIVE
      else process.env.DSH_PTC_LIVE = previousLive
      if (previousRoot === undefined) delete process.env.DSH_INSTALL_ROOT
      else process.env.DSH_INSTALL_ROOT = previousRoot
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** A summary block exactly as `node --test` prints it. */
function summary({ tests, pass = tests, fail = 0, skipped = 0 }: { tests: number, pass?: number, fail?: number, skipped?: number }) {
  return `\u2139 tests ${tests}\n\u2139 suites 0\n\u2139 pass ${pass}\n\u2139 fail ${fail}\n\u2139 cancelled 0\n\u2139 skipped ${skipped}\n\u2139 todo 0\n`
}

test('testCounts reads the node --test summary', () => {
  const counts = testCounts(summary({ tests: 20, pass: 20 }))
  assert.deepEqual(counts, { tests: 20, pass: 20, fail: 0, skipped: 0 })
})

test('testCounts returns undefined when no summary was printed', () => {
  assert.equal(testCounts('npm error missing script'), undefined)
  assert.equal(testCounts(''), undefined)
})

test('testCounts still reads a summary mixed into failing output', () => {
  const noisy = `not ok 1 - something\n  Error: boom\n${summary({ tests: 3, pass: 2, fail: 1 })}`
  assert.deepEqual(testCounts(noisy), { tests: 3, pass: 2, fail: 1, skipped: 0 })
})

test('--dry-run probes and never writes the overlay', () => {
  const h = harness(['--dry-run'])
  try {
    const result = h.outcome()
    assert.equal(result.code, 0)
    assert.equal(existsSync(h.overlay()), false, '--dry-run wrote an overlay')
    assert.match(h.lines.join('\n'), /\[1\/4\]/u)
    assert.match(h.lines.join('\n'), /--dry-run stops here/u)
  } finally {
    h.restore()
  }
})

test('a zero-test offline run is a hard stop, not a pass', () => {
  // Even from a source checkout the pattern can match nothing (a bad rename).
  const h = harness(['--write'], () => ({ status: 0, stdout: summary({ tests: 0, pass: 0 }), stderr: '' }))
  try {
    const result = h.outcome()
    assert.equal(result.code, 2)
    assert.equal(existsSync(h.overlay()), false, 'wrote an overlay after a zero-test run')
    assert.match(h.errors.join('\n'), /matched zero tests/u)
    assert.match(h.errors.join('\n'), /npm run adapt:upstream/u)
  } finally {
    h.restore()
  }
})

test('a failing offline suite stops before writing', () => {
  const h = harness(['--write'], () => ({ status: 1, stdout: summary({ tests: 5, pass: 4, fail: 1 }), stderr: '' }))
  try {
    const result = h.outcome()
    assert.equal(result.code, 1)
    assert.equal(existsSync(h.overlay()), false, 'wrote an overlay after a failing suite')
    assert.match(h.errors.join('\n'), /offline suite failed/u)
  } finally {
    h.restore()
  }
})

test('an offline run with no summary at all stops', () => {
  const h = harness(['--write'], () => ({ status: 0, stdout: 'something unrecognised', stderr: '' }))
  try {
    const result = h.outcome()
    assert.equal(result.code, 2)
    assert.equal(existsSync(h.overlay()), false)
  } finally {
    h.restore()
  }
})

test('a passing gate without --write records nothing and says so', () => {
  const h = harness([], () => ({ status: 0, stdout: summary({ tests: 20, pass: 20 }), stderr: '' }))
  try {
    const result = h.outcome()
    assert.equal(result.code, 0)
    assert.equal(existsSync(h.overlay()), false)
    assert.match(h.lines.join('\n'), /rerun with --write/u)
  } finally {
    h.restore()
  }
})

test('a passing gate with --write records the host entry', () => {
  const h = harness(['--write'], () => ({ status: 0, stdout: summary({ tests: 20, pass: 20 }), stderr: '' }))
  try {
    const result = h.outcome()
    assert.equal(result.code, 0)
    assert.equal(existsSync(h.overlay()), true)
    const manifest = JSON.parse(readFileSync(h.overlay(), 'utf8')) as { verified: Array<{ dshVersion: string }> }
    assert.equal(manifest.verified.length, 1)
    assert.equal(typeof manifest.verified[0]!.dshVersion, 'string')
    assert.equal(result.wrote, h.overlay())
  } finally {
    h.restore()
  }
})

test('--reset deletes the overlay instead of writing an empty entry list', () => {
  const h = harness(['--write'], () => ({ status: 0, stdout: summary({ tests: 20, pass: 20 }), stderr: '' }))
  try {
    h.outcome()
    assert.equal(existsSync(h.overlay()), true)
    const cleared = run({ argv: ['--reset'], log: () => undefined, error: () => undefined, execute: () => ({ status: 0, stdout: '', stderr: '' }) }) as Outcome
    assert.equal(cleared.code, 0)
    assert.equal(existsSync(h.overlay()), false, '--reset left the overlay file behind')
  } finally {
    h.restore()
  }
})

test('--live without DSH_PTC_LIVE stops with exit 2 and writes nothing', () => {
  delete process.env.DSH_PTC_LIVE
  const h = harness(['--live', '--write'], () => ({ status: 0, stdout: summary({ tests: 20, pass: 20 }), stderr: '' }))
  try {
    const result = h.outcome()
    assert.equal(result.code, 2)
    assert.equal(existsSync(h.overlay()), false)
    assert.match(h.errors.join('\n'), /DSH_PTC_LIVE=1/u)
  } finally {
    h.restore()
  }
})

test('an all-skipped live run proves nothing and stops', () => {
  // The live file marks each test `{ skip: !ready }`, so a half-configured
  // environment exits 0 with four skips.
  process.env.DSH_PTC_LIVE = '1'
  // The offline gate must pass for the live gate to be reached at all, so the
  // mock answers by call order: a clean offline run, then an all-skipped live run.
  let call = 0
  const h = harness(['--live', '--write'], () => {
    call += 1
    return call === 1
      ? { status: 0, stdout: summary({ tests: 736, pass: 736 }), stderr: '' }
      : { status: 0, stdout: summary({ tests: 4, pass: 0, skipped: 4 }), stderr: '' }
  })
  try {
    const result = h.outcome()
    assert.equal(result.code, 2)
    assert.equal(existsSync(h.overlay()), false)
    assert.match(h.errors.join('\n'), /no passing test/u)
  } finally {
    h.restore()
  }
})

test('a passing live run records', () => {
  process.env.DSH_PTC_LIVE = '1'
  const h = harness(['--live', '--write'], () => ({ status: 0, stdout: summary({ tests: 4, pass: 4 }), stderr: '' }))
  try {
    const result = h.outcome()
    assert.equal(result.code, 0)
    assert.equal(existsSync(h.overlay()), true)
    assert.match(h.lines.join('\n'), /live suite passed/u)
  } finally {
    h.restore()
  }
})

test('the default offline gate runs the full suite', () => {
  const seen: string[][] = []
  const h = harness(['--write'], (_command, args) => {
    seen.push(args)
    return { status: 0, stdout: summary({ tests: 727, pass: 727 }), stderr: '' }
  })
  try {
    assert.equal(h.outcome().code, 0)
    assert.deepEqual(seen[0]?.slice(-1), ['tests/*.spec.ts'], 'the default gate must cover the whole suite')
  } finally {
    h.restore()
  }
})

test('--ptc-only narrows the offline gate to the PTC subset', () => {
  const seen: string[][] = []
  // Without --write: the subset informs, it never certifies.
  const h = harness(['--ptc-only'], (_command, args) => {
    seen.push(args)
    return { status: 0, stdout: summary({ tests: 22, pass: 22 }), stderr: '' }
  })
  try {
    assert.equal(h.outcome().code, 0)
    assert.deepEqual(seen[0]?.slice(-1), ['tests/ptc-*.spec.ts'])
    assert.match(h.lines.join('\n'), /ptc subset/u)
    assert.equal(existsSync(h.overlay()), false, 'a subset run must not record anything')
  } finally {
    h.restore()
  }
})

test('--ptc-only cannot certify a host with --write', () => {
  // The subset skips the adapter specs (remote-world, ssh-pool, tool gates) that
  // the full gate exists to cover, so it must never produce a recorded worker.
  let executed = 0
  const h = harness(['--write', '--ptc-only'], () => {
    executed += 1
    return { status: 0, stdout: summary({ tests: 22, pass: 22 }), stderr: '' }
  })
  try {
    assert.equal(h.outcome().code, 2)
    assert.equal(executed, 0, 'the combination must be refused before running anything')
    assert.equal(existsSync(h.overlay()), false, 'the subset must not record a worker')
    assert.match(h.errors.join('\n'), /not a release gate/u)
  } finally {
    h.restore()
  }
})

test('a stray tests line before the real summary cannot fake a non-zero count', () => {
  // The zero-test guard depends on reading the last summary block. A run whose
  // earlier output contains something shaped like `tests 3` must still parse 0.
  const noisy = '  tests 3\nnot ok 1 - boom\n' + summary({ tests: 0, pass: 0 })
  const h = harness(['--write'], () => ({ status: 0, stdout: noisy, stderr: '' }))
  try {
    assert.equal(h.outcome().code, 2, 'a zero-test run must stop even with decoy output')
    assert.equal(existsSync(h.overlay()), false)
  } finally {
    h.restore()
  }
})

test('each script declaration matches the real module exports', async () => {
  for (const name of ['upgrade', 'check-upstream', 'upstream-map', 'cli-common']) {
    const mod = await import(`../scripts/${name}.mjs`) as Record<string, unknown>
    const dts = readFileSync(new URL(`../scripts/${name}.d.mts`, import.meta.url), 'utf8')
    for (const exported of Object.keys(mod)) {
      assert.match(dts, new RegExp(`\\b${exported}\\b`, 'u'), `${name}.d.mts is missing ${exported}`)
    }
  }
})

test('a run that skipped tests is a hard stop, not a pass', () => {
  // 14 suite tests skip when the official packages are missing, and two more
  // skip without bash or rg. A skip proves nothing, so it cannot certify a build.
  const h = harness(['--write'], () => ({
    status: 0,
    stdout: summary({ tests: 736, pass: 724, skipped: 12 }),
    stderr: '',
  }))
  try {
    assert.equal(h.outcome().code, 2)
    assert.equal(existsSync(h.overlay()), false)
    assert.match(h.errors.join('\n'), /skipped 12 test/u)
  } finally {
    h.restore()
  }
})

test('the offline gate turns the suite skips into failures', () => {
  // `DSH_REQUIRE_OFFICIAL_TOOLS=1` is how the suite itself reports the missing
  // packages instead of skipping them.
  const seen: Array<Record<string, string | undefined> | undefined> = []
  const h = harness(['--write'], (_command, _args, env) => {
    seen.push(env)
    return { status: 0, stdout: summary({ tests: 736, pass: 736 }), stderr: '' }
  })
  try {
    h.outcome()
    assert.equal(seen[0]?.DSH_REQUIRE_OFFICIAL_TOOLS, '1')
  } finally {
    h.restore()
  }
})

test('a command that could not run reports 2 instead of passing', () => {
  // spawnSync signals ENOBUFS through `error`, not through a non-zero status.
  const h = harness(['--write'], () => ({ status: null, stdout: '', stderr: '', error: 'ENOBUFS' }))
  try {
    assert.equal(h.outcome().code, 2)
    assert.equal(existsSync(h.overlay()), false)
    assert.match(h.errors.join('\n'), /could not run \(ENOBUFS\)/u)
  } finally {
    h.restore()
  }
})

test('an installed copy refuses the gate before running any suite', () => {
  // `tests/` is not published, so the gate cannot run at all. Saying that up
  // front beats letting the pattern match nothing and reporting "zero tests".
  let executed = 0
  const home = mkdtempSync(join(tmpdir(), 'dsh-installed-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const errors: string[] = []
  try {
    const result = run({
      argv: ['--write'],
      installed: true,
      log: () => undefined,
      error: line => errors.push(line),
      execute: () => {
        executed += 1
        return { status: 0, stdout: summary({ tests: 736, pass: 736 }), stderr: '' }
      },
    }) as { code: number }
    assert.equal(result.code, 2)
    assert.equal(executed, 0, 'the gate must not run a suite as an installed copy')
    assert.equal(existsSync(join(home, 'permission-remote', 'upstream-ptc.manifest.json')), false)
    const text = errors.join('\n')
    assert.match(text, /installed plugin/u)
    assert.match(text, /adapt:upstream/u)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('an installed copy refuses --ptc-only too, not just --write', () => {
  // The subset has the same problem: `tests/` does not exist, so the run would
  // match nothing and report "zero tests" instead of "wrong command here".
  let executed = 0
  const home = mkdtempSync(join(tmpdir(), 'dsh-installed-ptc-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const errors: string[] = []
  try {
    const result = run({
      argv: ['--ptc-only'],
      installed: true,
      log: () => undefined,
      error: line => errors.push(line),
      execute: () => {
        executed += 1
        return { status: 0, stdout: summary({ tests: 22, pass: 22 }), stderr: '' }
      },
    }) as { code: number }
    assert.equal(result.code, 2)
    assert.equal(executed, 0)
    assert.match(errors.join('\n'), /installed plugin/u)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('the installed early exit does not block --dry-run or --reset', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-installed-dry-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const dry = run({ argv: ['--dry-run'], installed: true, log: () => undefined, error: () => undefined }) as { code: number }
    assert.equal(dry.code, 0, '--dry-run must still report the probe result on an installed copy')
    const reset = run({ argv: ['--reset'], installed: true, log: () => undefined, error: () => undefined }) as { code: number }
    assert.equal(reset.code, 0)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('--dry-run reports which suite a real run would gate on', () => {
  const lines: string[] = []
  const home = mkdtempSync(join(tmpdir(), 'dsh-dry-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const result = run({ argv: ['--dry-run'], installed: false, log: l => lines.push(l), error: () => undefined }) as { code: number }
    assert.equal(result.code, 0)
    const text = lines.join('\n')
    assert.match(text, /tests\/\*\.spec\.ts/u)
    assert.match(text, /full suite/u)
    assert.doesNotMatch(text, /subset/u)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('--dry-run --ptc-only names the subset and its limitation', () => {
  const lines: string[] = []
  const result = run({ argv: ['--dry-run', '--ptc-only'], installed: false, log: l => lines.push(l), error: () => undefined }) as { code: number }
  assert.equal(result.code, 0)
  const text = lines.join('\n')
  assert.match(text, /tests\/ptc-\*\.spec\.ts/u)
  assert.match(text, /NOT a release gate/u)
  assert.match(text, /cannot be combined with --write/u)
})

test('an installed --dry-run says --write is refused here', () => {
  const lines: string[] = []
  const result = run({ argv: ['--dry-run'], installed: true, log: l => lines.push(l), error: () => undefined }) as { code: number }
  assert.equal(result.code, 0)
  const text = lines.join('\n')
  assert.match(text, /installed plugin/u)
  assert.match(text, /--write.*refused/u)
  assert.match(text, /adapt:upstream/u)
})

test('--dsh-root without a value is a usage error', () => {
  const h = harness(['--dsh-root'])
  try {
    assert.equal(h.outcome().code, 2)
  } finally {
    h.restore()
  }
})

test('an unreachable DSH install stops at step 1 without writing', () => {
  const h = harness(['--write', '--dsh-root', join(tmpdir(), 'definitely-not-a-dsh-root')])
  try {
    const result = h.outcome()
    assert.equal(result.code, 1)
    assert.equal(existsSync(h.overlay()), false)
    assert.match(h.errors.join('\n'), /\[1\/4\]|cannot locate/u)
  } finally {
    h.restore()
  }
})

test('the CLI entry flushes stdout instead of exiting into a truncated pipe', () => {
  // `process.exit()` drops whatever has not reached the pipe. A `--explain`
  // report over the kernel buffer would lose half its lines in a CI log, so the
  // entry point must set `exitCode` and let Node drain.
  const script = new URL('../scripts/upgrade.mjs', import.meta.url)
  const run = spawnSync(process.execPath, ['--experimental-transform-types', script.pathname, '--reset'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-flush-')) },
  })
  assert.equal(run.status, 0)
  // The reset path prints one line; the point is that the process still exits
  // with the right code through `exitCode` rather than truncating. Larger
  // output coverage lives in the big-output probe below.
  assert.match(run.stdout, /deleted/u)
})

test('the CLI entry survives a real shell pipe instead of truncating', () => {
  // The truncation only appears through a shell pipe: `spawnSync` reads the
  // child's stdout itself and never hits the kernel buffer that `process.exit`
  // abandons. A source checkout produces enough output here (the probe table
  // plus the guide rows) to cross it.
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-flush-'))
  try {
    // Build a tiny fake package that prints far more than a pipe holds, using
    // the same exit style as the real entry points.
    const script = join(scratch, 'entry.mjs')
    writeFileSync(script, [
      'function run() {',
      '  for (let i = 0; i < 4000; i += 1) console.log(`line ${i} ${"x".repeat(100)}`)',
      '  return 0',
      '}',
      'process.exitCode = run()',
      '',
    ].join('\n'))
    const piped = spawnSync('sh', ['-c', `"${process.execPath}" "${script}" | (sleep 0.2; wc -l)`], { encoding: 'utf8' })
    assert.equal(piped.status, 0)
    assert.equal(Number(piped.stdout.trim()), 4000, 'the pipe lost lines')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('the shared flush helper is used and no script calls process.exit', async () => {
  // A source-level guard: `process.exit` truncates a piped stdout, so the entry
  // points must not use it for the normal path. The helper now lives in the
  // shared module; both entry points must actually call it.
  const shared = readFileSync(new URL('../scripts/cli-common.mjs', import.meta.url), 'utf8')
  assert.match(shared, /function exitAfterFlush/u, 'cli-common.mjs has no flush helper')
  for (const name of ['upgrade', 'check-upstream', 'cli-common']) {
    const raw = readFileSync(new URL(`../scripts/${name}.mjs`, import.meta.url), 'utf8')
    // Strip comments first: the rationale for the helper mentions the call.
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '')
    assert.doesNotMatch(code, /\bprocess\.exit\(/u, `${name}.mjs must not call process.exit()`)
  }
  for (const name of ['upgrade', 'check-upstream']) {
    const raw = readFileSync(new URL(`../scripts/${name}.mjs`, import.meta.url), 'utf8')
    assert.match(raw, /\bexitAfterFlush\(/u, `${name}.mjs does not use the shared flush helper`)
  }
})

// ---------------------------------------------------------------------------
// CLI hardening regressions. Each of these fails on the pre-fix scripts.
// ---------------------------------------------------------------------------

function brokenDshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-broken-'))
  const runtime = join(root, 'node_modules', '@deepseek-ai', 'dsh-ptc-runtime-node', 'lib')
  const subprocess = join(root, 'node_modules', '@deepseek-ai', 'dsh-subprocess', 'lib')
  mkdirSync(runtime, { recursive: true })
  mkdirSync(subprocess, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9-fake' }))
  writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-ptc-runtime-node', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-ptc-runtime-node', version: '9.9.9-fake' }))
  writeFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-subprocess', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-subprocess', version: '9.9.9-fake' }))
  writeFileSync(join(runtime, 'process.js'), '// no entry line\n')
  writeFileSync(join(runtime, 'index.js'), '// no bootstrap\n')
  writeFileSync(join(subprocess, 'control.js'), '// no control\n')
  return root
}

/** Save/restore DSH_HOME around a direct `checkRun()` call. */
function withCheckHome<T>(fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), 'dsh-check-home-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return fn()
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
}

test('a misspelled --write is refused instead of silently doing nothing', () => {
  const h = harness(['--writ'], () => ({ status: 0, stdout: summary({ tests: 20, pass: 20 }), stderr: '' }))
  try {
    const result = h.outcome()
    assert.equal(result.code, 2)
    assert.equal(existsSync(h.overlay()), false)
    assert.match(h.errors.join('\n'), /unknown option\(s\): --writ/u)
    assert.match(h.errors.join('\n'), /valid flags:/u)
  } finally {
    h.restore()
  }
})

test('misspelled --live / --ptc-only and a random flag are all refused', () => {
  for (const argv of [['--liv', '--write'], ['--ptc-onl', '--write'], ['--bogus', '--write']]) {
    const h = harness(argv, () => ({ status: 0, stdout: summary({ tests: 20, pass: 20 }), stderr: '' }))
    try {
      assert.equal(h.outcome().code, 2, `${argv.join(' ')} was silently accepted`)
      assert.equal(existsSync(h.overlay()), false, `${argv.join(' ')} recorded an overlay`)
      assert.match(h.errors.join('\n'), /unknown option\(s\)/u)
    } finally {
      h.restore()
    }
  }
})

test('check-upstream refuses unknown flags too', () => {
  withCheckHome(() => {
    for (const argv of [['--check', '--writ'], ['--adap'], ['--check', '--liv'], ['--check', '--bogus']]) {
      const errors: string[] = []
      const result = checkRun({ argv, log: () => undefined, error: line => errors.push(line) }) as { code: number }
      assert.equal(result.code, 2, `${argv.join(' ')} was silently accepted`)
      assert.match(errors.join('\n'), /unknown option\(s\)/u)
      assert.match(errors.join('\n'), /valid flags:/u)
    }
  })
})

test('check-upstream --dry-run on a pure check is rejected, not a silent no-op', () => {
  withCheckHome(() => {
    const errors: string[] = []
    const result = checkRun({ argv: ['--check', '--dry-run'], log: () => undefined, error: line => errors.push(line) }) as { code: number }
    assert.equal(result.code, 2)
    assert.match(errors.join('\n'), /--dry-run only applies/u)
  })
})

test('check-upstream --reset --explain is refused instead of being swallowed', () => {
  withCheckHome(() => {
    const errors: string[] = []
    const result = checkRun({ argv: ['--reset', '--explain'], log: () => undefined, error: line => errors.push(line) }) as { code: number }
    assert.equal(result.code, 2)
    assert.match(errors.join('\n'), /--reset cannot be combined with --explain/u)
  })
})

test('--ptc-only --write --dry-run is refused like the non-dry-run combo', () => {
  const h = harness(['--ptc-only', '--write', '--dry-run'], () => ({ status: 0, stdout: summary({ tests: 20, pass: 20 }), stderr: '' }))
  try {
    assert.equal(h.outcome().code, 2)
    assert.equal(existsSync(h.overlay()), false)
    assert.match(h.errors.join('\n'), /--ptc-only cannot be combined with --write/u)
  } finally {
    h.restore()
  }
})

test('--reset and --dry-run no longer swallow --write / --live', () => {
  for (const argv of [
    ['--reset', '--write'],
    ['--reset', '--live', '--write'],
    ['--dry-run', '--live', '--write'],
    ['--dry-run', '--write'],
  ]) {
    const h = harness(argv, () => ({ status: 0, stdout: summary({ tests: 20, pass: 20 }), stderr: '' }))
    try {
      assert.equal(h.outcome().code, 2, `${argv.join(' ')} was silently accepted`)
      assert.equal(existsSync(h.overlay()), false)
      assert.match(h.errors.join('\n'), /cannot be combined/u)
    } finally {
      h.restore()
    }
  }
})

test('run() restores DSH_INSTALL_ROOT so a later run is unaffected', () => {
  const previousRoot = process.env.DSH_INSTALL_ROOT
  const bogus = join(tmpdir(), 'definitely-not-a-dsh-root')
  const h = harness(['--write', '--dsh-root', bogus], () => ({ status: 0, stdout: summary({ tests: 20, pass: 20 }), stderr: '' }))
  try {
    assert.equal(h.outcome().code, 1, 'the bogus root should stop at step 1')
    assert.equal(process.env.DSH_INSTALL_ROOT, previousRoot, '--dsh-root leaked into process.env')
    const second = harness(['--write'], () => ({ status: 0, stdout: summary({ tests: 20, pass: 20 }), stderr: '' }))
    try {
      assert.equal(second.outcome().code, 0, 'the second run was redirected by the leaked root')
      assert.equal(existsSync(second.overlay()), true)
    } finally {
      second.restore()
    }
  } finally {
    h.restore()
  }
})

test('a live run with partial skips is refused like the offline gate', () => {
  let call = 0
  const h = harness(['--live', '--write'], () => {
    call += 1
    return call === 1
      ? { status: 0, stdout: summary({ tests: 736, pass: 736 }), stderr: '' }
      : { status: 0, stdout: summary({ tests: 4, pass: 2, skipped: 2 }), stderr: '' }
  })
  process.env.DSH_PTC_LIVE = '1'
  try {
    assert.equal(h.outcome().code, 2)
    assert.equal(existsSync(h.overlay()), false)
    assert.match(h.errors.join('\n'), /live suite skipped 2 test/u)
  } finally {
    h.restore()
  }
})

test('a clean live run with zero skips still records', () => {
  let call = 0
  const h = harness(['--live', '--write'], () => {
    call += 1
    return call === 1
      ? { status: 0, stdout: summary({ tests: 736, pass: 736 }), stderr: '' }
      : { status: 0, stdout: summary({ tests: 4, pass: 4, skipped: 0 }), stderr: '' }
  })
  process.env.DSH_PTC_LIVE = '1'
  try {
    assert.equal(h.outcome().code, 0)
    assert.equal(existsSync(h.overlay()), true)
    assert.match(h.lines.join('\n'), /live suite passed/u)
  } finally {
    h.restore()
  }
})

test('--explain shows guide rows for real probe failures, not a dead branch', () => {
  const root = brokenDshRoot()
  try {
    withCheckHome(() => {
      const errors: string[] = []
      const result = checkRun({ argv: ['--check', '--explain', '--dsh-root', root], log: () => undefined, error: line => errors.push(line) }) as { code: number }
      assert.equal(result.code, 1)
      const text = errors.join('\n')
      assert.match(text, /what changed and where to fix it/u)
      assert.match(text, /\[entry\]/u)
      assert.match(text, /\[control-fd\]/u)
      assert.match(text, /\[spawn-control\]/u)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upgrade prints one guide row per probe failure, never one for the combined error', () => {
  const root = brokenDshRoot()
  try {
    withCheckHome(() => {
      const errors: string[] = []
      const result = run({ argv: ['--dsh-root', root], log: () => undefined, error: line => errors.push(line) }) as { code: number }
      assert.equal(result.code, 1)
      const text = errors.join('\n')
      assert.match(text, /\[entry\]/u)
      assert.match(text, /\[imports\]/u)
      assert.match(text, /\[spawn-control\]/u)
      assert.doesNotMatch(text, /no guide row matches/u)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('duplicate CLI helpers live only in cli-common.mjs', () => {
  const shared = readFileSync(new URL('../scripts/cli-common.mjs', import.meta.url), 'utf8')
  for (const helper of ['isInstalledPackage', 'isEntryPoint', 'exitAfterFlush', 'applyDshRoot']) {
    assert.match(shared, new RegExp(`function ${helper}\\b`, 'u'), `cli-common.mjs is missing ${helper}`)
  }
  for (const name of ['upgrade', 'check-upstream']) {
    const raw = readFileSync(new URL(`../scripts/${name}.mjs`, import.meta.url), 'utf8')
    for (const helper of ['isInstalledPackage', 'isEntryPoint', 'exitAfterFlush']) {
      assert.doesNotMatch(raw, new RegExp(`function ${helper}\\b`, 'u'), `${name}.mjs still defines ${helper} locally`)
    }
    assert.match(raw, /from '\.\/cli-common\.mjs'/u, `${name}.mjs does not import the shared helpers`)
  }
})

test('--explain success does not claim a wrong probe count', () => {
  const raw = readFileSync(new URL('../scripts/check-upstream.mjs', import.meta.url), 'utf8')
  assert.match(raw, /all contract probes passed; no guide action is pending/u)
  assert.doesNotMatch(raw, /all \$\{PROBE_GUIDES\.length\} contract probes/u)
})

test('package.json and package-lock.json agree on the version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as { version: string, packages: { '': { version: string } } }
  assert.equal(lock.version, pkg.version, 'package-lock.json version is stale')
  assert.equal(lock.packages[''].version, pkg.version, 'package-lock.json packages[""].version is stale')
})

test('the staged debug drafts no longer exist', () => {
  assert.equal(existsSync(new URL('../.tmp-f.ts', import.meta.url)), false)
  assert.equal(existsSync(new URL('../.panel.tmp', import.meta.url)), false)
})
