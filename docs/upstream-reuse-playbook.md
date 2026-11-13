# Replacing hand-written implementations with installed upstream packages

This is the reusable playbook behind the remote PTC worker migration. It is
deliberately a script-first process: prose says what to check; the script and
manifest make the check reproducible.

## Four reuse patterns

| Pattern | Example | How to reuse |
| --- | --- | --- |
| Pure library | `@deepseek-ai/dsh-fs-patch` | Import the installed package as a peer/dev dependency; do not vendor a source copy. |
| Worker/process binary | `@deepseek-ai/dsh-ptc-runtime-node` | Resolve the host package, hash the exact files, upload as `.mjs`, keep the upstream fd 7 control protocol. |
| Service implementation | `dsh-bash-local` / `dsh-bash-sandbox` | Keep the official tool and patch the execution seams (`sandbox.confine` + `subprocess.spawn`) instead of reimplementing the tool. |
| Filesystem backend | `dsh-fs-local` | Implement a `FileSystem` provider/remote backend; reuse pure algorithms such as `dsh-fs-patch`, not `node:fs`. |

## Non-negotiable steps

1. **Locate the host installation, never guess.** Prefer `DSH_INSTALL_ROOT` for
   diagnostics, then `process.argv[1]` / `process.execPath` package discovery.
   Never silently load the plugin's own dev copy in production.
2. **Hash and probe before use.** Entry line, descriptor/control contract,
   imports, bootstrap mapping, and package versions go into
   `vendor/upstream/<component>.manifest.json`.
3. **Run a real smoke or e2e.** A static probe proves shape, not behavior. For
   PTC the gate is `tests/ptc-offline.spec.ts` (real upstream runtime + real
   worker + real shim) and `tests/ptc-live.e2e.ts` (real SSH host).
4. **Map execution, do not rewrite frames.** For worker protocols keep the
   upstream control channel; for tools keep the official tool definition and
   provide the execution world beneath it.
5. **Fail closed on unknown drift.** The control protocol has no version
   handshake. An unverified upstream version must produce an actionable error,
   never a silent fallback to a local process.

## What “dynamic upstream” means

The worker is the peer of the **plugin host's** `NodePtcRuntime`, not of the
remote machine's DSH installation. The remote machine only needs Node.js; its
DSH version is irrelevant. Pulling a 0.2.3 worker while the plugin host still
runs the 0.2.2 runtime would be a version mismatch because the control protocol
has no handshake. The supported adaptation is:

- installed plugin host upgraded to DSH 0.2.3 and contract unchanged:
  `npm run adapt:upstream` records the host's 0.2.3 worker in the writable
  `$DSH_HOME/permission-remote/upstream-ptc.manifest.json` overlay; the next
  remote run uploads that worker;
- contract changed: update the probe/adapter and ship a plugin release that
  declares the new entry;
- plugin host stays 0.2.2: it keeps using its 0.2.2 worker, even if the remote
  machine has a newer DSH package installed.

## Upstream upgrade flow

```bash
npm run check:upstream                 # compare installed host against manifest
npm run test:ptc                       # offline contract + real worker
DSH_PTC_LIVE=1 ... npm run e2e:ptc     # real SSH host
npm run check:upstream -- --update     # record the verified version
```

On an installed host, `npm run adapt:upstream` performs the same static
probes and records the host version. It is intentionally **not** a substitute
for the test gates; the command prints that reminder. If a probe fails, fix the
probe/adapter or refuse remote execution in `docs/upstream-ptc-worker.md`.

## Current migration status

| Current implementation | Official source | State |
| --- | --- | --- |
| `read` / `write` / `edit` / `apply_patch` tool surface | `@deepseek-ai/dsh-tool-fs` | Official tools already call `ctx.fs`; remote-fs supplies `writeText` / `editText` / `patchText` and is covered by the official-tools integration test. |
| `read_image` shadow | `@deepseek-ai/dsh-tool-fs` `read_image` | Removed; the official tool reads through `ctx.fs.readBytes` and the attachment store. |
| `runGlob` / `runGrep` runners | `@deepseek-ai/dsh-tool-fs-search` | Removed. A thin `runOfficialSearch` shadow rewrites `args.path` from placeholder/relative to the remote path, then delegates the official tool. |
| `runBash` / `commandArgv` | `dsh-tool-bash` + `dsh-bash-sandbox` | Default path delegates to official `dsh-tool-bash`; a thin `runOfficialBash` maps `workdir` and `installRemoteShell` injects the login snapshot. The old runner remains only as a fallback for compositions without official bash. |
| `patch-hunks.ts` + `vendor/fs-patch` | `@deepseek-ai/dsh-fs-patch` | Replaced with the official package; vendored copy deleted. |
| `str_replace_editor` shadow | `@deepseek-ai/dsh-tool-str-replace-editor` | Keep the small path-rewrite adapter; official `resolveTarget` has no cwd. |
| `working_directory` shadow | `@deepseek-ai/dsh-tool-working-directory` | Keep only remote validation; the official service commit does the work. |
| `present` staging | `@deepseek-ai/dsh-tool-present` | Cannot be replaced: the official card opens a local path, so staging is required. Staged bytes are a content-addressed snapshot under `<placeholder root>/.deliverables/<sha256>/`; the remote-fs patch carves that one path out so a remote session's `cwd` does not translate it back into a remote path, and the five mutating methods refuse it. `scripts/check-upstream.mjs` probes that `present` still calls `lstat`/`resolve` with the Session cwd and records `processPath(target)`. A future upstream `DeliverableResolver` would remove the copy; see `docs/present-resolver-proposal.md`. |
| `terminal_open` / sidebar PTY | `@deepseek-ai/dsh-tool-terminal` / `dsh-terminal-bash` | Official tools stay. A thin shadow rewrites `cwd` onto the session host's placeholder. `spawnTerminal` is installed by its own `rawCtx.inject(['subprocess'], …)`; `sandbox.confine` is installed by a separate `rawCtx.inject(['sandbox','subprocess'], …)`. A model `terminal_open` requires both `worldReady` and `spawnReady`; the sidebar requires only `spawnReady`. A placeholder cwd routes to the remote PTY: sidebar xterm keeps its login shell, every other remote cwd runs the official argv and environment. Foreground probes use one shared SSH channel per host with per-request cancellation isolation; pid capture, signal delivery, and cleanup use one-shot execs. `check:upstream` probes `TerminalController.spawn/create/shells` arity (4 or 5 for `spawn`), `openForAgent`, the controller's `DSH_SESSION_ID: agent.id` and `spawnTerminal(` call, the runtime `async spawnTerminal(spec)` / `async terminalEnvironment(signal)` in `dsh-subprocess-local` (not the `{@link}` comment in `dsh-subprocess`), the `TerminalError.code` / `SubprocessError.code` error classes, and the verified DSH version list; `npm run smoke:terminal` exercises the real controller path. rc.2's `agentLaunch` consults `terminalEnvironment()` twice: an `AsyncLocalStorage` mark held only for the wrapped `terminal.spawn` makes it answer `posix` with the remote login shell (falling back to `/bin/sh`); local sessions are unaffected. The post-exit history `rm` is routed once by terminal id through a 24-hour TTL map and an exact argv match. |
| bash / PTC confinement argv | `@deepseek-ai/dsh-sandbox-local` profile region | Constructors are not exported. `src/profile-contract.ts` extracts them, calls them, and refuses a different argv. The file-write profile reuses the official read-only bwrap base, then bind-mounts the remote temp dirs. |

## Sandbox profile contract

`bwrapProfileArgs` and `seatbeltProfileArgs` live inside the installed
`dsh-sandbox-local` bundle and are not part of its public export. Remote bash
and PTC call those functions. The file-write profile does not: it needs the
real remote temp directories to stay on disk, so it reuses only the official
read-only bwrap base and then adds its own binds.

This extractor is a bridge. The installed package publishes
`lib/types/profiles.d.ts`, which declares `bwrapProfileArgs` and
`seatbeltProfileArgs` under `@module @deepseek-ai/dsh-sandbox-local/profiles`,
and the package `exports` map has no `./profiles` JavaScript entry. When that
subpath exists, call it and delete the region extractor. Until then,
`engines.dsh` (`>=0.2.2-rc.1 <0.3.0`) is the intended window, and the probe is
the real constraint: a bundle that drops the `lib/types/profiles.js` region
comment, or that returns a different argv, refuses remote confinement.
`@deepseek-ai/dsh-sandbox-local` is read from that DSH install. It is not a
`peerDependency`: the plugin does not import it, and listing it would make
`npm ci` fetch a second copy.

`npm run check:upstream` calls the constructors with sentinel roots and
requires that argv. It also calls `workspaceWritableRoots` and `writableRoots`
with inert `canonicalPath` / `additionalRoot` / `tmpdir` hooks, so a comment
that still spells the old calls does not keep the old meaning. It prints
`sandbox profile sha256`. The hash is a diagnostic: it is not compared, and it
is not a second manifest. A source edit that leaves the literals the shape
probes check unchanged, and that still returns the accepted argv and helper
lists, stays usable. Rewording one of those literals fails the shape probe
before the calls run. A different argv fails the gate before a remote command,
including when the source still mentions the old flags. The sandbox probe runs even when the worker locator fails, and
`upgrade:ptc` runs it on `--dry-run` and `--ptc-only` as well. Every load reads
the installed files again. The command does not fall back to a copied argv.

The injected root helpers keep remote paths as spelled. Official
`workspaceWritableRoots` / `writableRoots` realpath on this computer, so they
must not be called on a remote path. `fileWritableRoots` in `src/profile.ts`
is the remote translation of `writableRoots`.

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

Do **not** replace `remote-fs.ts`, `remote-write.ts`, `ssh-pool.ts`, `uploads.ts`,
`ops.ts`, `login-env.ts`, or `rg-fetch.ts`: they are remote transport or
cross-platform packaging, not duplicated DSH logic. In particular,
`writeText` / `editText` / `patchText` are `ctx.fs` backend methods; delegating
them to `dsh-fs-local` would write to the local placeholder, not the SSH host.

## Suggested next order

1. Keep the official file tools on `ctx.fs`; no tool-surface rewrite is needed.
2. Generalize `RemoteProcessHandle` to full spill/collect semantics and use it
   for any remaining official process-based tool.
3. Leave `present` and the remote PTY for separate designs.
