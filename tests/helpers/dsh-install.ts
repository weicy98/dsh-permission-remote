/**
 * Resolve a peer package from the same DSH installation the plugin itself uses.
 *
 * Tests that need an installed-DSH module (the skill registry, for instance)
 * must not hard-code a machine path: the plugin already knows how to find the
 * host install, so specs reuse that logic instead of repeating it.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { locateDshRoot } from '../../src/upstream-worker.ts'

/**
 * Resolve `specifier` as if required from inside the installed DSH package.
 *
 * @param specifier module specifier, e.g. `@deepseek-ai/dsh-skill/lib/index.js`
 * @param env environment used to locate the install; defaults to `process.env`
 * @returns absolute path to the resolved module
 * @throws when the install cannot be found, or when it lacks the package
 */
export function resolveFromDshInstall(specifier: string, env: NodeJS.ProcessEnv = process.env): string {
  let root: string
  try {
    root = locateDshRoot(env).root
  } catch (error) {
    // `locateDshRoot` already tells the reader to set DSH_INSTALL_ROOT, and it
    // lists every path it tried; repeating the advice doubles the message.
    throw new Error(
      `cannot resolve ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const require = createRequire(join(root, '__dsh_resolve__.js'))
  try {
    return require.resolve(specifier, { paths: [root] })
  } catch {
    throw new Error(
      `the installed DSH at ${root} does not provide ${specifier}. Set DSH_INSTALL_ROOT to a complete @deepseek-ai/dsh install.`,
    )
  }
}
