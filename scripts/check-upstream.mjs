#!/usr/bin/env node
/**
 * Check or refresh the upstream PTC worker contract manifest.
 *
 * Run through npm because this imports the TypeScript locator directly:
 *   npm run check:upstream
 *   npm run check:upstream -- --update
 *
 * `DSH_INSTALL_ROOT` must name the installed @deepseek-ai/dsh package root (or
 * a directory containing node_modules/@deepseek-ai/dsh). `--dsh-root` is an
 * equivalent argument for local diagnostics.
 */
import { locateUpstreamWorker, manifestEntryFor, probeContract, readWorkerManifest, writeOverlayManifest, writeWorkerManifest } from '../src/upstream-worker.ts'

const argv = process.argv.slice(2)
const adapt = argv.includes('--adapt')
const update = argv.includes('--update') || adapt
const check = argv.includes('--check') || !update
const rootIndex = argv.findIndex(value => value === '--dsh-root')
if (rootIndex !== -1) {
  const value = argv[rootIndex + 1]
  if (value === undefined || value.length === 0) {
    console.error('check:upstream: --dsh-root requires a path')
    process.exit(2)
  }
  process.env.DSH_INSTALL_ROOT = value
}
let worker
try {
  worker = locateUpstreamWorker(process.env, { allowUnverified: true })
} catch (error) {
  console.error(`check:upstream: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const probes = probeContract(worker)
const entry = manifestEntryFor(worker)
if (update) {
  const manifest = readWorkerManifest()
  const verified = manifest.verified.filter(item => !(item.dshVersion === entry.dshVersion
    && item.ptcRuntimeNodeVersion === entry.ptcRuntimeNodeVersion
    && item.processSha256 === entry.processSha256))
  verified.push(entry)
  const path = adapt ? writeOverlayManifest({ contractVersion: 1, verified }) : (writeWorkerManifest({ contractVersion: 1, verified }), 'vendor/upstream/ptc-worker.manifest.json')
  console.log(`check:upstream: wrote manifest entry for DSH ${entry.dshVersion} / runtime ${entry.ptcRuntimeNodeVersion} -> ${path}`)
  if (adapt) console.log('check:upstream: static probes passed. Run `npm run test:ptc` and `npm run e2e:ptc` before treating this host as production-verified.')
  process.exit(0)
}

const manifest = readWorkerManifest()
const expected = manifest.verified.find(item => item.dshVersion === entry.dshVersion
  && item.ptcRuntimeNodeVersion === entry.ptcRuntimeNodeVersion)
const rows = [
  ['DSH', entry.dshVersion, expected?.dshVersion === entry.dshVersion ? 'same' : 'new'],
  ['ptc-runtime-node', entry.ptcRuntimeNodeVersion, expected?.ptcRuntimeNodeVersion === entry.ptcRuntimeNodeVersion ? 'same' : 'new'],
  ['process.js sha256', entry.processSha256, expected?.processSha256 === entry.processSha256 ? 'same' : 'changed'],
  ['lib/index.js sha256', entry.indexSha256, expected?.indexSha256 === entry.indexSha256 ? 'same' : 'changed'],
  ['dsh-subprocess control sha256', entry.controlSha256, expected?.controlSha256 === entry.controlSha256 ? 'same' : 'changed'],
  ['control fd', String(entry.controlFd), String(expected?.controlFd)],
  ['control env', entry.controlEnv ?? '(missing)', expected?.controlEnv ?? '(missing)'],
  ['entry probe', String(probes.entry), String(expected?.probes.entry)],
  ['imports only node', String(probes.importsOnlyNode), String(expected?.probes.importsOnlyNode)],
  ['bootstrapArgs mapping', String(probes.bootstrapArgsMapsHostPath), String(expected?.probes.bootstrapArgsMapsHostPath)],
  ['spawn control pipe', String(probes.spawnControlPipe), String(expected?.probes.spawnControlPipe)],
]
console.log('check:upstream: current host contract')
for (const [name, actual, expectedValue] of rows) console.log(`  ${name}: ${actual} (manifest: ${expectedValue})`)
if (probes.failures.length > 0) {
  console.error(`check:upstream: contract probe failures: ${probes.failures.join('; ')}`)
  process.exit(1)
}
const changed = expected === undefined
  || entry.processSha256 !== expected.processSha256
  || entry.indexSha256 !== expected.indexSha256
  || entry.controlSha256 !== expected.controlSha256
  || entry.controlFd !== expected.controlFd
  || entry.controlEnv !== expected.controlEnv
  || entry.probes.entry !== expected.probes.entry
  || entry.probes.importsOnlyNode !== expected.probes.importsOnlyNode
  || entry.probes.bootstrapArgsMapsHostPath !== expected.probes.bootstrapArgsMapsHostPath
  || entry.probes.spawnControlPipe !== expected.probes.spawnControlPipe
if (check && changed) {
  console.error('check:upstream: contract drift. Read docs/upstream-ptc-worker.md, run the offline and live e2e suites, then run `npm run check:upstream -- --update`.')
  process.exit(1)
}
console.log('check:upstream: OK')
