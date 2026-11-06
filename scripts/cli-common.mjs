/**
 * Shared plumbing for the two upstream CLI scripts.
 *
 * Keeping the flag whitelist, `--dsh-root` handling, installed-package
 * detection and exit helpers here means one script cannot silently drift from
 * the other. `probeFailures()` is the diagnostic-only path that lets
 * `--explain` show guide rows even though `locateUpstreamWorker()` throws on a
 * failing probe: it re-reads the very same worker sources and calls the
 * exported `probeContract()` directly, which never throws.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { guideFor, renderGuide } from './upstream-map.mjs'
import { locateDshRoot, probeContract } from '../src/upstream-worker.ts'

/** Flags `upgrade.mjs` accepts. `--dsh-root` consumes the next argument. */
export const UPGRADE_FLAGS = [
  '--dry-run', '--write', '--live', '--ptc-only', '--reset', '--dsh-root',
]

/** Flags `check-upstream.mjs` accepts. `--dsh-root` consumes the next argument. */
export const CHECK_UPSTREAM_FLAGS = [
  '--check', '--update', '--adapt', '--reset', '--explain', '--dry-run', '--dsh-root',
]

/**
 * Return every argument that is not a known flag.
 *
 * A flag's value is positional, so `--dsh-root <path>` must not have its path
 * mistaken for a flag. Only dash-prefixed arguments are considered flags.
 *
 * @param {readonly string[]} argv
 * @param {readonly string[]} knownFlags
 * @returns {string[]}
 */
export function unknownFlags(argv, knownFlags) {
  const unknown = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (typeof value !== 'string' || !value.startsWith('-')) continue
    if (knownFlags.includes(value)) {
      if (value === '--dsh-root') index += 1
      continue
    }
    unknown.push(value)
  }
  return unknown
}

/**
 * The two lines both scripts print when an unknown flag is refused.
 * @param {readonly string[]} unknown
 * @param {readonly string[]} knownFlags
 * @param {string} label
 * @returns {string[]}
 */
export function unknownFlagLines(unknown, knownFlags, label) {
  return [
    `${label}: unknown option(s): ${unknown.join(', ')}`,
    `${label}: valid flags: ${knownFlags.join(', ')}`,
  ]
}

/**
 * Whether this copy came from the npm package rather than a source checkout.
 *
 * `tests/` is not in `package.json` `files`, so its absence is the one reliable
 * signal available at runtime. Both scripts live in `scripts/`, so `../tests/`
 * resolves to the same directory for this module as it did for them.
 */
export function isInstalledPackage() {
  return !existsSync(new URL('../tests/', import.meta.url))
}

/** Whether this module's caller was invoked as the CLI entry point. */
export function isEntryPoint(metaUrl) {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(metaUrl))
  } catch {
    return false
  }
}

/**
 * Exit only after stdout has drained.
 *
 * `process.exit()` truncates a piped stdout once the output passes the kernel
 * buffer. Setting `exitCode` lets Node flush and exit on its own.
 */
export function exitAfterFlush(code) {
  process.exitCode = code
}

/** An error the CLI entry point maps to exit code 2. */
export function usage(message) {
  const error = new Error(message)
  error.code = 'USAGE'
  return error
}

/**
 * Apply `--dsh-root <path>` to the given environment.
 *
 * The caller owns the environment: `run()` wraps itself in `withDshRoot()`, so
 * the mutation is always undone before it returns. Both scripts now share this
 * one implementation instead of two that had drifted apart.
 *
 * @param {readonly string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {string | undefined} the applied path, if any
 */
export function applyDshRoot(argv, env) {
  const rootIndex = argv.findIndex(value => value === '--dsh-root')
  if (rootIndex === -1) return undefined
  const value = argv[rootIndex + 1]
  if (value === undefined || value.length === 0 || value.startsWith('-')) throw usage('--dsh-root requires a path')
  env.DSH_INSTALL_ROOT = value
  return value
}

/**
 * Call `fn` with `env`, then restore `DSH_INSTALL_ROOT` even when `fn` throws.
 *
 * `run()` is the only writer of that key; without this guard a `--dsh-root`
 * diagnostic permanently redirects every later caller in the same process.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {(env: NodeJS.ProcessEnv) => T} fn
 * @returns {T}
 * @template T
 */
export function withDshRoot(env, fn) {
  const previous = env.DSH_INSTALL_ROOT
  try {
    return fn(env)
  } finally {
    if (previous === undefined) delete env.DSH_INSTALL_ROOT
    else env.DSH_INSTALL_ROOT = previous
  }
}

function locatePackageJson(dshRoot, name, specifier) {
  const direct = join(dshRoot, 'node_modules', '@deepseek-ai', name, 'package.json')
  if (existsSync(direct)) return direct
  try {
    const require = createRequire(join(dshRoot, '__dsh_probe__.js'))
    return require.resolve(specifier, { paths: [dshRoot] })
  } catch {
    return undefined
  }
}

/**
 * Re-read the installed worker sources and return `probeContract().failures`.
 *
 * `locateUpstreamWorker()` throws on a failing probe, so the CLI cannot obtain
 * the failures array from it. `probeContract()` itself is pure and exported;
 * this reconstructs just the three buffers it reads. Anything that cannot be
 * located returns `undefined` so callers can fall back to the raw error.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {readonly string[] | undefined}
 */
export function probeFailures(env) {
  try {
    const { root } = locateDshRoot(env)
    const runtime = locatePackageJson(root, 'dsh-ptc-runtime-node', '@deepseek-ai/dsh-ptc-runtime-node/package.json')
    const subprocess = locatePackageJson(root, 'dsh-subprocess', '@deepseek-ai/dsh-subprocess/package.json')
    if (runtime === undefined || subprocess === undefined) return undefined
    const runtimeDir = dirname(runtime)
    const worker = {
      processSource: readFileSync(join(runtimeDir, 'lib', 'process.js')),
      indexSource: readFileSync(join(runtimeDir, 'lib', 'index.js')),
      controlSource: readFileSync(join(dirname(subprocess), 'lib', 'control.js')),
    }
    return probeContract(worker).failures
  } catch {
    return undefined
  }
}

/**
 * Print one probe failure's guide row, or an honest fallback when the table has
 * no row for it. Used by the reachable `--explain` / locator-error paths.
 *
 * @param {string} failure
 * @param {(line: string) => void} error
 */
export function renderFailureGuide(failure, error) {
  const guide = guideFor(failure)
  if (guide === undefined) {
    error(`  ${failure}`)
    error('      meaning: no guide row matches this probe; add one to scripts/upstream-map.mjs')
    return
  }
  for (const line of renderGuide(guide)) error(line)
}
