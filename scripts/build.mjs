import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const PACKAGE_NAME = 'dsh-permission-remote'
const SEEDED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
])

const browserPurity = {
  name: 'browser-purity',
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.kind === 'entry-point') return undefined
      if (args.path.startsWith('.') || args.path.startsWith('/')) return undefined
      if (SEEDED.has(args.path)) return { path: args.path, external: true }
      return { errors: [{ text: `browser bundle purity: "${args.path}" is not a platform-seeded module` }] }
    })
  },
}

const host = await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  logLevel: 'silent',
})

const clientResult = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  jsx: 'automatic',
  external: [...SEEDED],
  logLevel: 'silent',
  plugins: [browserPurity],
})

const hostText = host.outputFiles?.[0]?.text
const clientBundled = clientResult.outputFiles?.[0]?.text
if (hostText === undefined || clientBundled === undefined) throw new Error('esbuild produced no bundle')
if (clientBundled.includes('ssh2')) throw new Error('ssh2 leaked into the browser bundle')

const clientText = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${clientBundled}
    return module.exports;
  }
});
`

await mkdir(resolve(root, 'lib'), { recursive: true })
await writeFile(resolve(root, 'lib/index.js'), hostText)
await writeFile(resolve(root, 'lib/client.js'), clientText)
console.log(`wrote lib/index.js (${hostText.length} bytes)`)
console.log(`wrote lib/client.js (${clientText.length} bytes)`)
