#!/usr/bin/env node
/**
 * One-command upstream gate: probe, run the offline suite, optionally run the
 * live suite, then record the host worker.
 *
 *   npm run upgrade:ptc                      # probe + offline suite, print the diff
 *   npm run upgrade:ptc -- --write           # ... and record the overlay
 *   npm run upgrade:ptc -- --dry-run         # probe only, never writes
 *   npm run upgrade:ptc -- --live --write    # add the real-SSH suite
 *   npm run upgrade:ptc -- --reset           # delete the host overlay, then exit
 *
 * Exit codes: 0 recorded (or nothing to do), 1 a gate failed, 2 the gate could
 * not run (missing live environment, or a suite that matched zero tests).
 *
 * The zero-test case is the important one. `tests/` is not published with the
 * plugin, so `node --test tests/ptc-*.spec.ts` on an installed package matches
 * nothing and still exits 0. Treating that as a pass would let "green" mean
 * "nothing ran", so a run that reports `tests 0` is a `2`, never a `0`.
 */
import { spawnSync } from 'node:child_process'
import { assertSandboxProfilesLoad } from '../src/profile-contract.ts'
import { clearOverlayManifest, locateUpstreamWorker, manifestEntryFor, overlayManifestPath, readOverlayManifest, readWorkerManifest, writeOverlayManifest } from '../src/upstream-worker.ts'
import { applyDshRoot, exitAfterFlush, isEntryPoint, isInstalledPackage, probeFailures, renderFailureGuide, UPGRADE_FLAGS, unknownFlagLines, unknownFlags, withDshRoot } from './cli-common.mjs'

export { isInstalledPackage }

/**
 * @typedef {object} RunOptions
 * @property {string[]} [argv]
 * @property {(line: string) => void} [log]
 * @property {(line: string) => void} [error]
 * @property {boolean} [installed] overrides the installed-package detection
 * @property {(command: string, args: string[], env?: NodeJS.ProcessEnv) => {status: number | null, stdout: string, stderr: string, error?: string}} [execute]
 */

/**
 * Parse the `node --test` summary block.
 *
 * The block is the LAST run of lines that starts with a `tests N` line. Taking
 * the first match let an earlier line shaped like `  tests 3` win, which turns
 * a failing run into a passing-looking count and defeats the zero-test guard.
 */
export function testCounts(text) {
  const lines = String(text).split(/\r?\n/u)
  let start = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*\S*\s*tests\s+\d+/u.test(lines[index])) {
      start = index
      break
    }
  }
  if (start === -1) return undefined
  const block = lines.slice(start).join('\n')
  const read = name => {
    const match = new RegExp(`(?:^|\\n)\\s*[^\\w\\s]*\\s*${name}\\s+(\\d+)`, 'u').exec(block)
    return match === null ? undefined : Number(match[1])
  }
  return { tests: read('tests'), pass: read('pass'), fail: read('fail'), skipped: read('skipped') }
}

/** The suite prints a few tens of KB; the ceiling only has to survive a bad day. */
const MAX_BUFFER = 64 * 1024 * 1024

function defaultExecute(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // The default 1 MB silently truncates; a truncated run has no readable
    // summary and would be reported as "could not run" instead of "passed".
    maxBuffer: MAX_BUFFER,
    env,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // ENOBUFS/E2BIG arrive here rather than as a non-zero status.
    ...result.error === undefined ? {} : { error: result.error.code ?? result.error.message },
  }
}

/**
 * Run the upgrade gate.
 *
 * @param {RunOptions} [options]
 * @returns {{ code: number, wrote?: string, entry?: object }} outcome
 */
export function run(options = {}) {
  return withDshRoot(process.env, env => runGate(options, env))
}

function runGate(options, env) {
  const argv = options.argv ?? process.argv.slice(2)
  const log = options.log ?? (line => console.log(line))
  const error = options.error ?? (line => console.error(line))
  const execute = options.execute ?? defaultExecute

  const unknown = unknownFlags(argv, UPGRADE_FLAGS)
  if (unknown.length > 0) {
    for (const line of unknownFlagLines(unknown, UPGRADE_FLAGS, 'upgrade:ptc')) error(line)
    return { code: 2 }
  }

  const installed = options.installed ?? isInstalledPackage()
  const dryRun = argv.includes('--dry-run')
  const hasWrite = argv.includes('--write')
  const write = hasWrite && !dryRun
  const live = argv.includes('--live')
  // The default is the full suite: `--write` certifies "this build works with
  // this worker", and adapter regressions (remote-world, ssh-pool, tool gates)
  // live outside `tests/ptc-*.spec.ts`. `--ptc-only` keeps a fast inner loop.
  const ptcOnly = argv.includes('--ptc-only')
  const reset = argv.includes('--reset')

  // `--ptc-only` runs the PTC subset; `--write` certifies a host. The adapter
  // regressions this gate exists to catch (remote-world, ssh-pool, tool gates)
  // live outside the subset, so the subset may only inform, never certify.
  // Keep this free of exact test counts: the subset grows and a stale number
  // in a comment is a lie that survives review.
  // Check the raw argv, not the derived `write` boolean: `--dry-run` used to
  // zero out `write` and let `--ptc-only --write --dry-run` slip through.
  if (ptcOnly && hasWrite) {
    error('upgrade:ptc: --ptc-only cannot be combined with --write; the PTC subset is not a release gate.')
    error('upgrade:ptc: run `npm run upgrade:ptc -- --write` for the full suite, or drop --write to keep the fast loop.')
    error('upgrade:ptc: nothing was written')
    return { code: 2 }
  }

  // `--reset` returns before every other gate, so any companion flag used to be
  // silently swallowed. `--dry-run` likewise stops at [1/4] and used to swallow
  // `--write`/`--live`. Refuse both combinations out loud.
  if (reset && (hasWrite || live || ptcOnly || dryRun)) {
    error('upgrade:ptc: --reset cannot be combined with --write, --live, --ptc-only or --dry-run; --reset only deletes the overlay.')
    error('upgrade:ptc: nothing was written')
    return { code: 2 }
  }
  if (dryRun && (hasWrite || live)) {
    error('upgrade:ptc: --dry-run cannot be combined with --write or --live; --dry-run never writes and never runs any suite.')
    error('upgrade:ptc: nothing was written')
    return { code: 2 }
  }

  try {
    applyDshRoot(argv, env)
  } catch (failure) {
    error(`upgrade:ptc: ${failure instanceof Error ? failure.message : String(failure)}`)
    return { code: 2 }
  }

  if (reset) {
    // `--reset --dry-run` was rejected above, so this path always deletes.
    const deleted = clearOverlayManifest(env)
    log(`upgrade:ptc: deleted ${deleted}`)
    return { code: 0 }
  }

  // `--dry-run` still reports the probe result and `--reset` still works; only
  // the recording path needs the offline suite, and an installed copy has no
  // `tests/` to run. Saying so up front beats letting the suite match nothing
  // and reporting "zero tests" instead of "wrong command for this install".
  // Any path that would reach the offline suite needs `tests/`, not just
  // `--write`: `--ptc-only` runs the same missing directory.
  if (!dryRun && installed) {
    error('upgrade:ptc: this is an installed plugin, so `tests/` is not present and the offline gate cannot run here.')
    error('upgrade:ptc: record the installed host with `npm run adapt:upstream` (static probes, no rebuild) and treat the worker as unverified.')
    error('upgrade:ptc: `--dry-run` and `--reset` still work; run the gate from a source checkout.')
    error('upgrade:ptc: nothing was written')
    return { code: 2 }
  }

  // [1/4] locate + probe. Sandbox runs on `--dry-run` and `--ptc-only` too;
  // the PTC subset does not include the profile contract tests.
  log('upgrade:ptc: [1/4] locate the host worker and probe its contract')
  const sandbox = assertSandboxProfilesLoad(env)
  let worker
  try {
    worker = locateUpstreamWorker(env, { allowUnverified: true })
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure)
    error(`upgrade:ptc: ${message}`)
    // `locateUpstreamWorker()` throws on any probe failure, so this is the only
    // reachable place where guide rows can be printed. Never run `guideFor()`
    // on the combined locator error: it would pick an unrelated row out of the
    // long message (e.g. `[imports]`) and name the wrong file. Only actual
    // `probeContract().failures` get rows; anything else gets the raw error
    // plus a pointer to the command that can explain it.
    const failures = probeFailures(env)
    error('upgrade:ptc: what changed and where to fix it')
    if (failures !== undefined && failures.length > 0) {
      for (const failure of failures) renderFailureGuide(failure, error)
    } else {
      error('upgrade:ptc: rerun `npm run check:upstream -- --explain` for the file and function behind this failure')
    }
    for (const failure of sandbox.failures) renderFailureGuide(failure, error)
    return { code: 1 }
  }
  if (sandbox.failures.length > 0) {
    error(`upgrade:ptc: sandbox profile contract failed: ${sandbox.failures.join('; ')}`)
    error('upgrade:ptc: what changed and where to fix it')
    for (const failure of sandbox.failures) renderFailureGuide(failure, error)
    error('upgrade:ptc: nothing was written')
    return { code: 1 }
  }
  const entry = manifestEntryFor(worker)
  log(`upgrade:ptc: host worker DSH ${entry.dshVersion} / runtime ${entry.ptcRuntimeNodeVersion}, all probes passed`)
  log(`upgrade:ptc: sandbox profile sha256 ${sandbox.profileSha256}`)

  if (dryRun) {
    log(`upgrade:ptc: --dry-run stops here. Would record into ${overlayManifestPath(env)}`)
    log(`upgrade:ptc: process.js sha256 ${entry.processSha256}`)
    // `--dry-run` exits before [2/4], so without this line the caller cannot
    // tell which suite a real run would have used, and `--ptc-only` is silent.
    log(`upgrade:ptc: a real run would gate on ${ptcOnly ? 'tests/ptc-*.spec.ts (subset; NOT a release gate)' : 'tests/*.spec.ts (full suite)'}${live ? ', then tests/ptc-live.e2e.ts' : ''}`)
    if (ptcOnly) log('upgrade:ptc: --ptc-only cannot be combined with --write; drop one of them for a real run.')
    if (installed) {
      // The installed early exit is skipped for --dry-run, so say out loud what
      // would happen otherwise: the recording command is refused on this copy.
      log('upgrade:ptc: this is an installed plugin; `--write` is refused here. Record with `npm run adapt:upstream` (static probes only, host stays unverified).')
    }
    return { code: 0, entry }
  }

  // [2/4] offline suite
  const pattern = ptcOnly ? 'tests/ptc-*.spec.ts' : 'tests/*.spec.ts'
  log(`upgrade:ptc: [2/4] offline suite (${ptcOnly ? 'ptc subset' : 'full suite'})`)
  // `DSH_REQUIRE_OFFICIAL_TOOLS=1` turns the graceful `skip:` guards in the
  // suite into hard failures. Without it, a machine missing the official
  // packages records 14 silent skips and the gate still certifies the build.
  const offlineEnv = { ...env, DSH_REQUIRE_OFFICIAL_TOOLS: '1' }
  const offline = execute(process.execPath, ['--experimental-transform-types', '--test', pattern], offlineEnv)
  if (offline.error !== undefined) {
    error(`upgrade:ptc: the offline suite could not run (${offline.error})`)
    error('upgrade:ptc: nothing was written')
    return { code: 2 }
  }
  const offlineCounts = testCounts(`${offline.stdout}\n${offline.stderr}`)
  if (offlineCounts === undefined) {
    error(`upgrade:ptc: the offline suite produced no test summary; run \`npm run ${ptcOnly ? 'test:ptc' : 'test'}\` by hand`)
    error('upgrade:ptc: nothing was written')
    return { code: 2 }
  }
  if (offlineCounts.tests === 0) {
    error('upgrade:ptc: the offline suite matched zero tests, so it proves nothing.')
    error('upgrade:ptc: `tests/` is not published with this plugin. Run the full gate from a source checkout, or record with `npm run adapt:upstream` and treat the host as unverified.')
    error('upgrade:ptc: nothing was written')
    return { code: 2 }
  }
  if ((offlineCounts.skipped ?? 0) > 0) {
    // A skipped test proves nothing. The suite has three independent skip
    // sources (official packages, bash, the fs-search module), so requiring one
    // environment variable is not enough to rule them out.
    error(`upgrade:ptc: the offline suite skipped ${offlineCounts.skipped} test(s), so it did not prove them.`)
    error('upgrade:ptc: install what the skip reasons name (official DSH tool packages, bash, rg) and rerun.')
    error('upgrade:ptc: run `npm test` to see each skip reason next to its test.')
    error('upgrade:ptc: nothing was written')
    return { code: 2 }
  }
  if (offline.status !== 0 || (offlineCounts.fail ?? 0) > 0) {
    error(`upgrade:ptc: the offline suite failed (${offlineCounts.pass ?? 0} passed, ${offlineCounts.fail ?? 0} failed)`)
    error('upgrade:ptc: nothing was written')
    return { code: 1 }
  }
  log(`upgrade:ptc: offline suite passed (${offlineCounts.pass ?? offlineCounts.tests} tests)`)

  // [3/4] live suite, only on request
  if (live) {
    log('upgrade:ptc: [3/4] live suite against a real SSH host')
    if (env.DSH_PTC_LIVE !== '1') {
      error('upgrade:ptc: --live needs DSH_PTC_LIVE=1 plus DSH_PTC_HOST, DSH_PTC_USER, DSH_PTC_FINGERPRINT, DSH_PTC_REMOTE_DIR')
      error('upgrade:ptc: nothing was written')
      return { code: 2 }
    }
    const liveRun = execute(process.execPath, ['--experimental-transform-types', '--test', 'tests/ptc-live.e2e.ts'], env)
    if (liveRun.error !== undefined) {
      error(`upgrade:ptc: the live suite could not run (${liveRun.error})`)
      error('upgrade:ptc: nothing was written')
      return { code: 2 }
    }
    const liveCounts = testCounts(`${liveRun.stdout}\n${liveRun.stderr}`)
    if (liveCounts === undefined || (liveCounts.pass ?? 0) === 0) {
      // The live file skips every test when the environment is incomplete, and
      // a skipped run also exits 0. Only a real pass counts.
      error(`upgrade:ptc: the live suite ran no passing test (${liveCounts?.skipped ?? '?'} skipped), so it proves nothing`)
      error('upgrade:ptc: check DSH_PTC_LIVE, DSH_PTC_HOST, DSH_PTC_USER, DSH_PTC_FINGERPRINT and DSH_PTC_REMOTE_DIR')
      error('upgrade:ptc: nothing was written')
      return { code: 2 }
    }
    if ((liveCounts.skipped ?? 0) > 0) {
      // Same rule as the offline gate: a skipped test proves nothing. `pass > 0`
      // alone used to let a half-configured live run (2 pass / 2 skipped) record
      // the overlay.
      error(`upgrade:ptc: the live suite skipped ${liveCounts.skipped} test(s), so it did not prove them.`)
      error('upgrade:ptc: check DSH_PTC_LIVE, DSH_PTC_HOST, DSH_PTC_USER, DSH_PTC_FINGERPRINT and DSH_PTC_REMOTE_DIR')
      error('upgrade:ptc: nothing was written')
      return { code: 2 }
    }
    if (liveRun.status !== 0 || (liveCounts.fail ?? 0) > 0) {
      error(`upgrade:ptc: the live suite failed (${liveCounts.fail ?? 0} failed)`)
      error('upgrade:ptc: nothing was written')
      return { code: 1 }
    }
    log(`upgrade:ptc: live suite passed (${liveCounts.pass} tests)`)
  } else {
    log('upgrade:ptc: [3/4] live suite skipped; pass --live to require it')
  }

  // [4/4] record
  const target = overlayManifestPath(env)
  if (!write) {
    log('upgrade:ptc: [4/4] every gate passed. Nothing was written.')
    log(`upgrade:ptc: rerun with --write to record this worker in ${target}`)
    log(`upgrade:ptc: process.js sha256 ${entry.processSha256}`)
    return { code: 0, entry }
  }
  const existing = readOverlayManifest(env)
  const verified = existing.verified.filter(item => !(item.dshVersion === entry.dshVersion
    && item.ptcRuntimeNodeVersion === entry.ptcRuntimeNodeVersion))
  verified.push(entry)
  let wrote
  try {
    wrote = writeOverlayManifest({ contractVersion: 1, verified }, env)
  } catch (failure) {
    error(`upgrade:ptc: could not write ${target}: ${failure instanceof Error ? failure.message : String(failure)}`)
    return { code: 1 }
  }
  log(`upgrade:ptc: [4/4] recorded DSH ${entry.dshVersion} / runtime ${entry.ptcRuntimeNodeVersion} -> ${wrote}`)
  const merged = readWorkerManifest()
  log(`upgrade:ptc: the merged manifest now holds ${merged.verified.length} entr${merged.verified.length === 1 ? 'y' : 'ies'}`)
  return { code: 0, wrote, entry }
}

if (isEntryPoint(import.meta.url)) {
  try {
    exitAfterFlush(run().code)
  } catch (failure) {
    console.error(`upgrade:ptc: ${failure instanceof Error ? failure.message : String(failure)}`)
    exitAfterFlush(1)
  }
}
