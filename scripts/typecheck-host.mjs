#!/usr/bin/env node
/**
 * Type-check this plugin against the DSH install that is actually running,
 * not the machine-specific v22.20.0 paths hardcoded in tsconfig.json.
 *
 * `npm run typecheck` remains the fast, pinned check used by CI. This script
 * rewrites every `@deepseek-ai/*` path in tsconfig.json to the located DSH
 * install (or `DSH_INSTALL_ROOT`) and runs the same `tsc --noEmit`, so a host
 * upgrade cannot pass typecheck against the wrong API surface.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { locateDshRoot } from '../src/upstream-worker.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = JSON.parse(readFileSync(join(repo, 'tsconfig.json'), 'utf8'))
const { root: dshRoot, version } = locateDshRoot()
const paths = config.compilerOptions?.paths ?? {}
for (const [name, values] of Object.entries(paths)) {
  const current = values[0]
  const marker = current.lastIndexOf('@deepseek-ai/')
  if (marker < 0) throw new Error(`cannot rewrite tsconfig path ${name}: ${current}`)
  const suffix = current.slice(marker + '@deepseek-ai/'.length)
  paths[name] = [`${dshRoot}/node_modules/@deepseek-ai/${suffix}`]
}
config.compilerOptions.paths = paths
const temp = join(repo, '.tsconfig.host.json')
try {
  writeFileSync(temp, JSON.stringify(config, null, 2) + '\n')
  console.log(`typecheck:host: DSH ${version} at ${dshRoot}`)
  execFileSync(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', temp], {
    cwd: repo,
    stdio: 'inherit',
  })
  console.log('typecheck:host: OK')
} finally {
  rmSync(temp, { force: true })
}
