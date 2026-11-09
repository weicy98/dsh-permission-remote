#!/usr/bin/env node
/**
 * Check or refresh the upstream PTC worker contract manifest.
 *
 * Run through npm because this imports the TypeScript locator directly:
 *   npm run check:upstream
 *   npm run check:upstream -- --update
 *   npm run check:upstream -- --explain
 *
 * `DSH_INSTALL_ROOT` must name the installed @deepseek-ai/dsh package root (or
 * a directory containing node_modules/@deepseek-ai/dsh). `--dsh-root` is an
 * equivalent argument for local diagnostics.
 *
 * The module exports `run()` and only executes when invoked as the entry
 * point, so tests can drive it without spawning a process.
 */
import { assertSandboxProfilesLoad } from '../src/profile-contract.ts'
import { clearOverlayManifest, locateDshRoot, locateUpstreamWorker, manifestEntryFor, overlayManifestPath, probeContract, probePresentContract, readOverlayManifest, readPackageManifest, readWorkerManifest, writeOverlayManifest, writeWorkerManifest } from '../src/upstream-worker.ts'
import { applyDshRoot, CHECK_UPSTREAM_FLAGS, exitAfterFlush, isEntryPoint, isInstalledPackage, probeFailures, renderFailureGuide, unknownFlagLines, unknownFlags, usage, withDshRoot } from './cli-common.mjs'

export { isInstalledPackage }

/**
 * @typedef {object} RunOptions
 * @property {string[]} [argv] arguments after the script name
 * @property {(line: string) => void} [log] stdout sink
 * @property {(line: string) => void} [error] stderr sink
 * @property {boolean} [installed] override the installed-package detection
 *
 * The environment is always `process.env`: `readWorkerManifest()` resolves the
 * overlay through it. `--dsh-root` writes `DSH_INSTALL_ROOT` there only for the
 * duration of one run; `withDshRoot()` restores it before `run()` returns.
 */

/**
 * The command that actually records a worker for this kind of copy.
 * @param {boolean} installed
 */
function recordHint(installed) {
  return installed
    ? '`npm run adapt:upstream` (writable host overlay; no rebuild needed)'
    : '`npm run upgrade:ptc -- --write` (full gate) or `npm run check:upstream -- --update` after the suites pass'
}

/**
 * Run the check/update/adapt flow.
 *
 * @param {RunOptions} [options]
 * @returns {{ code: number, wrote?: string }} the exit code and any manifest path written
 */
export function run(options = {}) {
  return withDshRoot(process.env, env => runCheck(options, env))
}

function runCheck(options, env) {
  const argv = options.argv ?? process.argv.slice(2)
  const log = options.log ?? (line => console.log(line))
  const error = options.error ?? (line => console.error(line))

  const unknown = unknownFlags(argv, CHECK_UPSTREAM_FLAGS)
  if (unknown.length > 0) {
    for (const line of unknownFlagLines(unknown, CHECK_UPSTREAM_FLAGS, 'check:upstream')) error(line)
    return { code: 2 }
  }

  const installed = options.installed ?? isInstalledPackage()
  const explain = argv.includes('--explain')
  const adapt = argv.includes('--adapt')
  const dryRun = argv.includes('--dry-run')
  const reset = argv.includes('--reset')
  const update = argv.includes('--update') || adapt
  const check = argv.includes('--check') || !update

  // A pure `--check` never writes anything, so `--dry-run` there is a no-op that
  // would only print a line. Refuse it instead of pretending it did something.
  if (dryRun && !update && !reset) {
    error('check:upstream: --dry-run only applies to --update, --adapt or --reset; a plain --check never writes')
    return { code: 2 }
  }

  applyDshRoot(argv, env)

  // `--reset` runs before the locator on purpose: deleting a JSON file needs
  // no worker bytes, and "the DSH install is broken, get back to a clean state"
  // is exactly when this flag is wanted. Only a literal `--update` is refused,
  // because that writes the package manifest this command never touches;
  // `--adapt --reset` means "reset the overlay" and is allowed.
  if (reset) {
    if (argv.includes('--update')) {
      throw usage('--reset cannot be combined with --update; the package manifest is the release baseline')
    }
    if (explain) {
      error('check:upstream: --reset cannot be combined with --explain; --reset deletes the overlay before any probe runs')
      return { code: 2 }
    }
    if (dryRun) {
      log(`check:upstream: --dry-run would delete ${overlayManifestPath(env)}`)
      return { code: 0 }
    }
    const cleared = clearOverlayManifest(env)
    log(`check:upstream: deleted ${cleared}`)
    return { code: 0 }
  }

  // Sandbox is probed before the worker locator returns, so a worker failure
  // cannot hide a sandbox failure from `--explain`.
  const sandbox = assertSandboxProfilesLoad(env)
  let worker
  try {
    worker = locateUpstreamWorker(env, { allowUnverified: true })
  } catch (failure) {
    error(`check:upstream: ${failure instanceof Error ? failure.message : String(failure)}`)
    // `locateUpstreamWorker()` throws on any probe failure. Re-read the worker
    // sources and ask `probeContract()` directly for the failures, then print
    // the sandbox rows collected before this throw.
    if (explain) {
      const failures = probeFailures(env)
      error('check:upstream: what changed and where to fix it')
      if (failures !== undefined && failures.length > 0) {
        for (const failure of failures) renderFailureGuide(failure, error)
      } else {
        error('check:upstream: the worker could not be located; fix the DSH install before asking for guide rows')
      }
      for (const failure of sandbox.failures) renderFailureGuide(failure, error)
    } else {
      error('check:upstream: rerun with --explain for the file and function behind each failure')
      if (sandbox.failures.length > 0) {
        error(`check:upstream: sandbox profile contract failed: ${sandbox.failures.join('; ')}`)
      }
    }
    return { code: 1 }
  }

  const probes = probeContract(worker)
  const entry = manifestEntryFor(worker)
  if (sandbox.failures.length > 0) {
    error(`check:upstream: sandbox profile contract failed: ${sandbox.failures.join('; ')}`)
    if (explain) {
      error('check:upstream: what changed and where to fix it')
      for (const failure of sandbox.failures) renderFailureGuide(failure, error)
    } else {
      error('check:upstream: rerun with --explain for the file and function behind each failure')
    }
    return { code: 1 }
  }
  log(`check:upstream: sandbox profile sha256 ${sandbox.profileSha256}`)

  // `present` staging is a separate contract from the PTC worker: it only breaks
  // remote delivery, not every remote tool. It is probed after the sandbox and
  // worker gates so a failure there cannot hide a bigger one, and before any
  // manifest write so a drifted contract is never recorded as verified.
  const present = probePresentContract(locateDshRoot(env).root)
  if (present.failures.length > 0) {
    error(`check:upstream: present delivery contract failed: ${present.failures.join('; ')}`)
    error('check:upstream: present staging lives in src/execute.ts stagePresentFiles and the snapshot carve-out in src/remote-fs.ts lexicalPath')
    return { code: 1 }
  }
  log(present.installed
    ? 'check:upstream: present delivery contract ok (lstat/resolve carry the Session cwd, the recorded path is processPath(target))'
    : 'check:upstream: present delivery contract skipped: this DSH build does not ship dsh-tool-present, so nothing delegates to it')

  if (update && dryRun) {
    const target = adapt ? overlayManifestPath(env) : 'vendor/upstream/ptc-worker.manifest.json'
    log(`check:upstream: --dry-run would record ${entry.dshVersion} / runtime ${entry.ptcRuntimeNodeVersion} in ${target}`)
    return { code: 0 }
  }

  if (update) {
    // `--adapt` updates only the writable host overlay; package `--update` must
    // never promote host-local overlay entries into the release baseline.
    const manifest = adapt ? readOverlayManifest(env) : readPackageManifest()
    const verified = manifest.verified.filter(item => !(item.dshVersion === entry.dshVersion
      && item.ptcRuntimeNodeVersion === entry.ptcRuntimeNodeVersion))
    verified.push(entry)
    let path
    try {
      path = adapt
        ? writeOverlayManifest({ contractVersion: 1, verified }, env)
        : (writeWorkerManifest({ contractVersion: 1, verified }), 'vendor/upstream/ptc-worker.manifest.json')
    } catch (failure) {
      const code = typeof failure === 'object' && failure !== null ? failure.code : undefined
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        error('check:upstream: the package manifest is not writable from this installation.')
        error('check:upstream: run `npm run adapt:upstream` instead; it writes $DSH_HOME/permission-remote/upstream-ptc.manifest.json and takes effect without a rebuild.')
        return { code: 1 }
      }
      error(`check:upstream: could not write the manifest: ${failure instanceof Error ? failure.message : String(failure)}`)
      return { code: 1 }
    }
    log(`check:upstream: wrote manifest entry for DSH ${entry.dshVersion} / runtime ${entry.ptcRuntimeNodeVersion} -> ${path}`)
    // On an installed copy `upgrade:ptc` refuses by design, so pointing there
    // would be a dead end. Name the gate only where it can run.
    if (adapt) {
      log(installed
        ? 'check:upstream: static probes passed and the overlay is recorded. This copy cannot run the offline gate; treat the host as unverified until a source checkout runs `npm run upgrade:ptc -- --live --write`.'
        : 'check:upstream: static probes passed. Run `npm run upgrade:ptc` for the full gate before treating this host as production-verified.')
    }
    return { code: 0, wrote: path }
  }

  if (dryRun) log('check:upstream: --dry-run, not writing the manifest')

  const manifest = readWorkerManifest()
  const expected = manifest.verified.find(item => item.processSha256 === entry.processSha256
    && item.indexSha256 === entry.indexSha256
    && item.controlSha256 === entry.controlSha256
    && item.controlFd === entry.controlFd
    && item.controlEnv === entry.controlEnv
    && item.minimumNodeMajor === entry.minimumNodeMajor)
  const rows = [
    ['DSH', entry.dshVersion, expected?.dshVersion === entry.dshVersion ? 'same' : 'new'],
    ['ptc-runtime-node', entry.ptcRuntimeNodeVersion, expected?.ptcRuntimeNodeVersion === entry.ptcRuntimeNodeVersion ? 'same' : 'new'],
    ['process.js sha256', entry.processSha256, expected?.processSha256 === entry.processSha256 ? 'same' : 'changed'],
    ['lib/index.js sha256', entry.indexSha256, expected?.indexSha256 === entry.indexSha256 ? 'same' : 'changed'],
    ['dsh-subprocess control sha256', entry.controlSha256, expected?.controlSha256 === entry.controlSha256 ? 'same' : 'changed'],
    ['control fd', String(entry.controlFd), String(expected?.controlFd)],
    ['control env', entry.controlEnv ?? '(missing)', expected?.controlEnv ?? '(missing)'],
    ['minimum node', String(entry.minimumNodeMajor), String(expected?.minimumNodeMajor)],
    ['entry probe', String(probes.entry), String(expected?.probes.entry)],
    ['imports only node', String(probes.importsOnlyNode), String(expected?.probes.importsOnlyNode)],
    ['bootstrapArgs mapping', String(probes.bootstrapArgsMapsHostPath), String(expected?.probes.bootstrapArgsMapsHostPath)],
    ['spawn control pipe', String(probes.spawnControlPipe), String(expected?.probes.spawnControlPipe)],
  ]
  log('check:upstream: current host contract')
  for (const [name, actual, expectedValue] of rows) log(`  ${name}: ${actual} (manifest: ${expectedValue})`)

  // `locateUpstreamWorker()` throws on any probe failure, so a worker that
  // reaches here has all-green probes; failing-probe guide rows are rendered in
  // that catch path instead. There is nothing to print per-row on a green run.
  if (explain) {
    log('check:upstream: all contract probes passed; no guide action is pending')
  }

  const changed = expected === undefined
    || entry.processSha256 !== expected.processSha256
    || entry.indexSha256 !== expected.indexSha256
    || entry.controlSha256 !== expected.controlSha256
    || entry.controlFd !== expected.controlFd
    || entry.controlEnv !== expected.controlEnv
    || entry.minimumNodeMajor !== expected.minimumNodeMajor
    || entry.probes.entry !== expected.probes.entry
    || entry.probes.importsOnlyNode !== expected.probes.importsOnlyNode
    || entry.probes.bootstrapArgsMapsHostPath !== expected.probes.bootstrapArgsMapsHostPath
    || entry.probes.spawnControlPipe !== expected.probes.spawnControlPipe
  if (check && changed) {
    error(`check:upstream: contract drift. Read docs/upstream-ptc-worker.md, then record with ${recordHint(installed)}.`)
    if (explain) {
      error(installed
        ? 'check:upstream: the probes passed and the bytes changed. This installed package cannot run the offline gate, so treat the host as unverified until a source checkout runs `npm run upgrade:ptc -- --live --write`.'
        : 'check:upstream: the probes passed, so the bytes changed without a shape change. `npm run upgrade:ptc` handles that case.')
    }
    return { code: 1 }
  }
  log('check:upstream: OK')
  return { code: 0 }
}

if (isEntryPoint(import.meta.url)) {
  try {
    exitAfterFlush(run().code)
  } catch (failure) {
    console.error(`check:upstream: ${failure instanceof Error ? failure.message : String(failure)}`)
    exitAfterFlush(failure?.code === 'USAGE' ? 2 : 1)
  }
}
