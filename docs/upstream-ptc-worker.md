# Remote PTC worker: upstream contract and upgrade runbook

This document records the contract the plugin relies on when it borrows the
host's official `@deepseek-ai/dsh-ptc-runtime-node` worker for a remote
workspace. The plugin never vendors the worker: it reads the installed package,
hashes it, and uploads the exact bytes to the SSH host.

## Contract

| Fact | Value |
| --- | --- |
| Worker entry | `lib/process.js`, `runNodeMain(openInheritedControlChannel(), Number(process.argv[2]), process)` |
| Persistent worker entry | `lib/persistent-process.js`, `runPersistentMain(...)` |
| Control descriptor | fd 7 |
| Control environment marker | `DSH_SUBPROCESS_CONTROL=pipe` |
| Host launch chain | `resolveExecutable` -> `bootstrapArgs` -> `sandbox.confine` -> `subprocess.spawn({ stdio: { control: 'pipe' } })` |
| Default bootstrap mapping | `fs.processPathFromHostPath(fileURLToPath(new URL('./process.js', import.meta.url)))` |
| Worker imports | Node built-ins only (birpc/acorn are bundled into the file) |
| Minimum remote Node | 22 (the worker uses `Promise.withResolvers`) |
| Worker upload name | `process.mjs` / `persistent-process.mjs` (ESM; never `.js` without a package.json) |

The manifest `vendor/upstream/ptc-worker.manifest.json` records the DSH and
package versions, hashes of `process.js`, `persistent-process.js`,
`lib/index.js`, and `dsh-subprocess/lib/control.js`, the contract probe results,
and the minimum remote Node major.

## Upgrade runbook

1. Run `npm run check:upstream`.
2. If it is green: run the offline e2e suite and the live e2e suite, then
   `npm run check:upstream -- --update`, rebuild, and release. No code change
   should be needed.
3. If a contract probe failed: use the reported probe name to locate the
   changed contract. Usually only `src/upstream-worker.ts` probe code and the
   manifest need updating; `src/ptc-remote.ts`, `src/remote-world.ts`, and
   `src/ptc-shim.mjs` only change when the control descriptor, `bootstrapArgs`,
   or `subprocess.spawn` shape changes.
4. If the upstream runtime no longer uses fd 7 or `stdio.control`, the plugin
   must refuse remote PTC with an actionable error. It must never silently fall
   back to running the program on the local host.

## Environment and diagnostics

- `DSH_INSTALL_ROOT` points the locator at a DSH install root. It is intended
  for tests and diagnostics; it is not exposed to the model.
- The runtime locator also uses the running DSH CLI entry (`process.argv[1]`)
  and its module resolution path. It never falls back to the plugin's own dev
  dependency or to the old self-authored bootstrap.
- A drift between the installed worker and the manifest is an error, not a
  warning: run the upgrade runbook first.
