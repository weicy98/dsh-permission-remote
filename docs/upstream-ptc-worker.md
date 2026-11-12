# Remote PTC worker: upstream contract and upgrade runbook

This document records the contract the plugin relies on when it borrows the
host's official `@deepseek-ai/dsh-ptc-runtime-node` worker for a remote
workspace. The plugin never vendors the worker: it reads the installed package,
hashes it, and uploads the exact bytes to the SSH host.

## Contract

| Fact | Value |
| --- | --- |
| Worker entry | `lib/process.js`, `runNodeMain(openInheritedControlChannel(), Number(process.argv[2]), process)` |
| Persistent worker entry | Not used/uploaded: the 0.2.2 runtime uses `process.js` for `repl`/`script` modes |
| Persistent mode | Built `process.js` handles `programFormat: repl` or `script`; `persistent-process.js` is the REPL-default legacy entry |
| Control descriptor | fd 7 |
| Shim handshake | `__DSH_PTC_READY__ <token> [unix:<path>] [tcp:127.0.0.1:<port>]`; short private Unix socket path first, authenticated TCP fallback |
| Control environment marker | `DSH_SUBPROCESS_CONTROL=pipe` |
| Host launch chain | `resolveExecutable` -> `bootstrapArgs` -> `sandbox.confine` -> `subprocess.spawn({ stdio: { control: 'pipe' } })` |
| Default bootstrap mapping | `fs.processPathFromHostPath(fileURLToPath(new URL('./process.js', import.meta.url)))` |
| Worker imports | Node built-ins only (birpc/acorn are bundled into the file) |
| Minimum remote Node | 22 (the worker uses `Promise.withResolvers`) |
| Worker upload name | `process.mjs` (ESM; never `.js` without a package.json) |

The manifest `vendor/upstream/ptc-worker.manifest.json` records the DSH and
package versions, hashes of `process.js`, `lib/index.js`, and `dsh-subprocess/lib/control.js`, the contract probe results,
and the minimum remote Node major.

## Which version is used

The worker must match the **plugin host's** NodePtcRuntime package, not the
remote machine's DSH version. The remote host needs Node.js plus a POSIX `sha256sum` or `shasum` for upload verification; a DSH 0.2.3
installation on the remote does not let a 0.2.2 host speak a 0.2.3 worker. The
overlay adaptation therefore records the version installed on the plugin host.

## Upgrade runbook

`check:upstream`（因此 `upgrade:ptc`）还包含 `probeTerminalContract`：它校验 `TerminalController.spawn`（4/5 参）、`create`（3 参）、`shells`（2 参）、`openForAgent`、`dsh-terminal-bash` 的 `DSH_SESSION_ID`、`dsh-subprocess.spawnTerminal`，并拒绝不在 `VERIFIED_TERMINAL_DSH_VERSIONS` 里的 DSH 版本。终端路径的实机冒烟另有 `npm run smoke:terminal`。

`npm run typecheck:host` 会按当前安装的 DSH 重写 `tsconfig` 的 `@deepseek-ai/*` 路径后跑 `tsc --noEmit`，避免类型检查对着旧版本头文件；`npm run smoke:terminal` 覆盖终端契约与真实 controller 路径。升级时两者都应通过。

`npm run upgrade:ptc` is the whole gate in one command:

```bash
npm run upgrade:ptc                    # probe + full suite, then print the diff
npm run upgrade:ptc -- --write         # ... and record the host overlay
npm run upgrade:ptc -- --live --write  # add the real-SSH suite before recording
npm run upgrade:ptc -- --ptc-only      # fast loop: PTC subset instead of the full suite
npm run upgrade:ptc -- --dry-run       # probe only, never writes
npm run upgrade:ptc -- --reset         # delete the host overlay and exit

npm run upgrade:ptc:live               # probe + full suite + live suite, then record
```

`npm run upgrade:ptc:live` is the same as `upgrade:ptc -- --live --write`. It is
the strongest gate, and it records nothing until the real-host suite passes —
but note *where* it writes.

**`upgrade:ptc -- --write` records the host overlay, not the release baseline.**
It writes `$DSH_HOME/permission-remote/upstream-ptc.manifest.json`, which exists
on one machine and is not packaged. A release still needs the package manifest:

```bash
npm run upgrade:ptc:live                      # full gate + real host, writes the overlay
npm run check:upstream -- --update            # promotes the entry into vendor/upstream/ptc-worker.manifest.json
npm run build                                 # rebuild lib/
```

The two files are deliberate: the overlay is how an already-installed host
adapts without a rebuild, and the package manifest is what ships a new baseline.

The offline step runs the **full** suite by default. `--write` certifies "this
build works with this worker", and the adapter modules this gate protects
(`remote-world`, `ssh-pool`, the tool gates) are covered outside
`tests/ptc-*.spec.ts`, so the subset alone would miss their regressions.
`--ptc-only` keeps a fast inner loop but is not a release gate: it is refused
together with `--write` — including under `--dry-run`, where the combination
used to slip through — because the subset omits the adapter specs the full gate
exists to cover.

Both scripts validate their flags. An unknown or misspelled option is a `2`, not
a silent no-op: `upgrade:ptc: unknown option(s): --writ` plus the list of valid
flags, before anything is probed or written. Contradictory combinations are also
refused instead of being silently dropped:

- `upgrade:ptc -- --ptc-only --write` → `2` (subset cannot certify).
- `upgrade:ptc -- --reset --write|--live|--ptc-only|--dry-run` → `2` (`--reset`
  only deletes the overlay; `--reset --dsh-root <path>` still works).
- `upgrade:ptc -- --dry-run --write|--live` → `2` (`--dry-run` never writes and
  never runs a suite). `--dry-run --ptc-only` stays allowed.
- `check:upstream -- --dry-run` without `--update`, `--adapt` or `--reset` → `2`
  (a plain check never writes; `--dry-run` would be a no-op).
- `check:upstream -- --reset --explain` → `2` (reset deletes before any probe
  can run). `--update --reset` is refused; `--adapt --reset` still works.

It stops at the first failing gate and writes nothing. Exit codes: `0` the gate
passed, `1` a gate failed, `2` the gate could not run or the flags did not make
sense.

`--reset` deletes `$DSH_HOME/permission-remote/upstream-ptc.manifest.json`
rather than writing an empty entry list, so its absence and an empty file are
not two different states to reason about. It runs **before** the locator, so it
still works when the DSH install cannot be found — which is exactly when an
operator wants to get back to a clean state. `--adapt --reset` is the same as
`--reset`. Only a literal `--update --reset` is refused: that would wipe the
release baseline, which this command never touches.

The offline step also sets `DSH_REQUIRE_OFFICIAL_TOOLS=1` and refuses to record
anything when the summary reports skips. The suite skips tests three ways —
missing official packages, missing bash, missing `rg` — and a skipped test
proves nothing about the build. `DSH_REQUIRE_OFFICIAL_TOOLS=1` only converts the
first kind into failures, so the skip check covers all three; the error names
the sources and points at `npm test`, which prints each reason next to its test.
The live step applies the same rule: at least one real pass is required (an
all-skipped file exits 0), and **any** skip in the live summary is a `2` as
well, so a partially-skipped real-host run cannot record the overlay.

On an installed plugin `tests/` is absent, so `--write` refuses before probing
and names `adapt:upstream` instead. `--dry-run` and `--reset` keep working there.

**A zero-test run is a `2`, not a pass.** `tests/` is not published with the
plugin, so `node --test tests/ptc-*.spec.ts` on an installed package matches no
files and still exits 0. `node --test` reports `tests 0`, and both the offline
and live steps treat that as "proved nothing". The live file also skips every
test when its environment is incomplete, so `--live` requires at least one real
pass rather than an exit code.

### Doing it by hand

1. Run `npm run check:upstream`. Add `--explain` to print, for each failing
   probe, what it looked for and which file and function to change.
2. If it is green: run the offline and live suites, then
   `npm run check:upstream -- --update`, rebuild, and release. No code change
   should be needed.
3. If a contract probe failed: use the reported probe name to locate the
   changed contract. `scripts/upstream-map.mjs` maps every probe failure string
   to its file, function, and next command; `tests/upstream-map.spec.ts` reads
   the probe source itself, so it fails when a failure string is reworded or a
   new probe is added without a matching guide row. Usually only
   `src/upstream-worker.ts` probe code and the manifest need updating;
   `src/ptc-remote.ts`, `src/remote-world.ts`, and `src/ptc-shim.mjs` only change
   when the control descriptor, `bootstrapArgs`, or `subprocess.spawn` shape
   changes.
4. If the upstream runtime no longer uses fd 7 or `stdio.control`, the plugin
   must refuse remote PTC with an actionable error. It must never silently fall
   back to running the program on the local host.

| Probe failure | Meaning | Change |
| --- | --- | --- |
| `process.js entry line changed` | The shim's argv handoff no longer matches | `src/upstream-worker.ts` `probeContract`, `src/ptc-shim.mjs` argv order |
| `process.js imports a non-Node module` | The worker is no longer one self-contained file | `src/upstream-worker.ts` `probeContract` |
| `fd 7 control descriptor not found` | The control socket moved | `src/ptc-shim.mjs` `spawnWorker` stdio array |
| `DSH_SUBPROCESS_CONTROL marker not found` | The worker never opens the channel | `src/ptc-shim.mjs` `spawnWorker` env |
| `control environment marker changed to <name>` | Upstream renamed the variable | `PTC_CONTROL_ENV` and the shim env block |
| `bootstrapArgs no longer maps process.js through fs.processPathFromHostPath` | The upload swap lost its hook | `src/remote-world.ts` `installWorkerPathMap` |
| `subprocess.spawn no longer requests a control pipe` | The remote spawn seam stopped taking over | `src/remote-world.ts` `installRemoteWorld` |

## Sandbox profile contract

Remote bash and PTC call the installed `bwrapProfileArgs` and
`seatbeltProfileArgs`. Those functions are not a public JavaScript export.
`src/profile-contract.ts` reads the installed bundle, calls the constructors,
and calls the official root helpers with inert path hooks. `npm run check:upstream`
runs this contract beside the worker probe. A worker locate error does not hide
a sandbox failure: `--explain` prints both. `npm run upgrade:ptc` runs the same
sandbox probe on `--dry-run` and `--ptc-only`, because the PTC subset does not
include the profile tests.

This is a bridge. `lib/types/profiles.d.ts` already declares the two functions.
When `@deepseek-ai/dsh-sandbox-local` exports `./profiles`, call that entry and
delete the extractor. `engines.dsh` names the intended window; the probe is what
accepts a bundle. A missing region comment or a different argv refuses remote
confinement, including `danger-full-access`, because `probeHost` builds the
read-only bwrap argv before the session mode is applied. File reads do not use
that probe.

| Probe failure | Change |
| --- | --- |
| `sandbox profile package could not be read` | Install a complete DSH, or set `DSH_INSTALL_ROOT`. `src/profile-contract.ts` `locateSources` |
| `sandbox profile region markers changed` | `src/profile-contract.ts` `extractProfileRegion` |
| `bwrapProfileArgs function not found` | `src/profile-contract.ts` `extractFunction` |
| `bwrap base flags changed` | `src/profile-contract.ts` `bwrapBaseIntact`, then `src/profile.ts` if the file-write base must diverge |
| `bwrap workspace-write no longer mounts a private /tmp` | `src/profile-contract.ts` `bwrapPrivateTmp`, then `src/profile.ts` |
| `bwrap workspace binds no longer come from workspaceWritableRoots` | `src/profile-contract.ts` `bwrapUsesWorkspaceRoots` and `remoteWorkspaceRoots` |
| `seatbelt profile skeleton changed` | `src/profile-contract.ts` `seatbeltSkeleton` |
| `seatbelt grants no longer come from writableRoots` | `src/profile-contract.ts` `seatbeltUsesWritableRoots` and `remoteWritableRoots` |
| `workspaceWritableRoots no longer means the workspace plus explicit extra directories` | `src/profile-contract.ts` `workspaceRootsMeanWorkspace` and `remoteWorkspaceRoots` |
| `writableRoots no longer adds the host temp directories on top of the workspace` | `src/profile-contract.ts` `writableRootsMeanTemp`, then `src/profile.ts` `fileWritableRoots` |
| `sandbox root helpers did not return the accepted directories` | `src/profile-contract.ts` `acceptedRootHelpers`, then `remoteWorkspaceRoots` |
| `sandbox profile argv does not match the accepted contract` | `src/profile-contract.ts` `acceptedProfileArgv`, then `src/profile.ts` when the file-write base must follow |
| `sandbox profile constructors did not evaluate` | `src/profile-contract.ts` `compileProfiles` |

### Package manifest vs host overlay

- `npm run check:upstream -- --update` writes the package manifest and is for
  **releases only**. On an installed plugin that directory is usually read-only;
  the script then reports the `EACCES`/`EPERM`/`EROFS` case and points at
  `--adapt` instead of printing a stack.
- `npm run adapt:upstream` writes
  `$DSH_HOME/permission-remote/upstream-ptc.manifest.json` and is the
  **installed-host** path. It runs the same static probes, needs no
  `node_modules` and no rebuild, and takes effect on the next PTC call because
  the plugin merges package and overlay entries on every lookup.
- `--adapt` proves shape, not behavior. `upgrade:ptc` is the version that also
  runs the offline suite.

## Environment and diagnostics

- `DSH_INSTALL_ROOT` points the locator at a DSH install root. It is intended
  for tests and diagnostics; the model never receives it as a tool argument.
  `npm run upgrade:ptc -- --dsh-root <path>` is the script-level equivalent.
- `npm run adapt:upstream` is the one-command adaptation for an already-installed
  host. It writes `$DSH_HOME/permission-remote/upstream-ptc.manifest.json`
  (a writable overlay), not the package manifest. The plugin merges package and
  overlay entries, so the next PTC call uses the installed host's worker without
  rebuilding the plugin. Static probes alone are not a production approval: run
  `npm run test:ptc` and `npm run e2e:ptc` after it.
- The runtime locator also uses the running DSH CLI entry (`process.argv[1]`)
  and its module resolution path. It never falls back to the plugin's own dev
  dependency or to the old self-authored bootstrap.
- A drift between the installed worker and the manifest is an error, not a
  warning: run the upgrade runbook first.
- The upgrade runbook is also registered as a runtime skill
  (`upstream-ptc-upgrade`). `docs/` ships with the package, but
  `.agents/skills/` is only discovered from a project root or a user skill
  directory, so an installed plugin publishes this file through
  `src/skills.ts` instead of leaving it on disk. A project-local skill of the
  same name outranks it.
