---
name: official-upstream-reuse
description: Use when replacing a plugin's hand-written tool, protocol, worker, or runner with the installed DeepSeek Harness upstream package. Covers locating the host install, contract probes, hash manifests, worker uploads, fd 7 control shims, seam adapters, offline/live gates, and the remaining hand-written-tool candidates in dsh-permission-remote.
---

# Official upstream reuse

## Rule

The installed DSH package is the source of truth. Resolve it, hash it, probe
its contract, and run a real smoke test. Never vendor a copy and never silently
fall back to a plugin-authored implementation.

## Worker/process recipe

1. Locate `@deepseek-ai/dsh-ptc-runtime-node` from `DSH_INSTALL_ROOT` or the DSH
   CLI entry (`process.argv[1]`), not from the plugin's own dev tree.
2. Read `lib/process.js`, `lib/index.js`, and
   `@deepseek-ai/dsh-subprocess/lib/control.js`. `process.js` serves
   `function-body`, `repl`, and `script`; `persistent-process.js` is only a
   legacy REPL-default entry and is neither read nor uploaded.
3. Probe: entry line, `fd: 7`, `DSH_SUBPROCESS_CONTROL`, Node-builtins-only
   imports, `bootstrapArgs` mapping, `stdio.control: 'pipe'`.
4. Upload `lib/process.js` as `process.mjs`; never `.js` without a
   `package.json` with `"type":"module"`.
5. Shim: full argv, fd 7 socket, `DSH_SUBPROCESS_CONTROL=pipe`, PATH/TEMP/TMP,
   detached process group, Unix + loopback TCP handshake, token validation.
6. Translate the control-frame cwd in a thin runtime wrapper; keep an
   AsyncLocalStorage world for the seams. Do not parse or rewrite frames.
7. Verify with `tests/ptc-offline.spec.ts` and `tests/ptc-live.e2e.ts`; record
   the version in `vendor/upstream/ptc-worker.manifest.json`.

## Service/tool recipe

- Keep the official tool definition and patch the execution seams beneath it:
  `ctx.fs`, `ctx.sandbox.confine`, `ctx.subprocess.spawn`,
  `ctx.subprocess.resolveExecutable`, and `ctx.workingDirectory`.
- A generic remote world must implement the full `SubprocessSpawnSpec`:
  `stdin: ignore|pipe|{data}`, `stdout/stderr: pipe|collect{maxBytes,spill}`,
  `collected` readers, `control`, `signal`, `graceMs`, `terminate`,
  `waitForExit`.
- Route by session cwd / policy root; never route local calls. Clear the
  AsyncLocalStorage world for nested local runs.

## Upgrade gates

One command runs the whole gate:

```bash
npm run upgrade:ptc                    # probe + full suite, print the diff
npm run upgrade:ptc -- --write         # ... and record the host overlay
npm run upgrade:ptc -- --live --write  # add the real-SSH suite
npm run upgrade:ptc -- --ptc-only      # fast loop: PTC subset, not a release gate
npm run upgrade:ptc -- --dry-run       # probe only, never writes
npm run upgrade:ptc -- --reset         # delete the host overlay

npm run upgrade:ptc:live               # = --live --write; writes the HOST OVERLAY only
```

Exit codes: `0` passed, `1` a gate failed, `2` the gate could not run, or the
flags did not make sense. **Unknown or misspelled flags are a `2`**, not a
silent no-op: both scripts print `unknown option(s)` plus the valid flag list
before probing or writing anything. Contradictory combinations are refused
rather than silently dropped: `--ptc-only --write` (also under `--dry-run`),
`--reset` combined with `--write`/`--live`/`--ptc-only`/`--dry-run`,
`--dry-run --write`/`--live`, `check:upstream -- --check --dry-run`, and
`check:upstream -- --reset --explain`. `--adapt --reset` and
`--dry-run --ptc-only` stay allowed.

**A run that reports `tests 0` is a `2`, not a pass** — `tests/` is not
published with the plugin, so the offline command matches nothing on an
installed package and would otherwise look green. The live file skips every
test without its environment, so `--live` requires a real pass, not an exit 0.
**Skips are a `2` as well**: the offline step sets `DSH_REQUIRE_OFFICIAL_TOOLS=1`
and refuses a summary with any skipped test, because a skip proves nothing.
That variable only converts the official-package skips, so the summary check is
what covers the bash and `rg` skips too; `npm test` prints each reason. The live
step applies the same rule: at least one pass, and zero skips.
**`--ptc-only --write` is a `2`**: the subset omits the adapter specs the gate
exists to cover, so it may inform but never certifies.

On an installed plugin `--write` refuses before probing and names
`adapt:upstream`. `--dry-run` and `--reset` still run there.

Recording and releasing are different writes. `upgrade:ptc -- --write` (and
`upgrade:ptc:live`) write `$DSH_HOME/permission-remote/upstream-ptc.manifest.json`
— one machine, not packaged. A release promotes the entry with
`check:upstream -- --update` into `vendor/upstream/ptc-worker.manifest.json`,
then rebuilds. Do not call the overlay a release.

`--reset` deletes the host overlay and runs before the locator, so it works even
when the DSH install is broken. `--adapt --reset` is the same thing;
`--update --reset` is refused.

The equivalent steps by hand are `npm run check:upstream`,
`npm run test:ptc`, `DSH_PTC_LIVE=1 ... npm run e2e:ptc`, then
`npm run check:upstream -- --update`.

### Decision table: probe failure to file

`npm run check:upstream -- --explain` prints this table for the probes that
actually failed. `scripts/upstream-map.mjs` is the machine-readable copy, and
`tests/upstream-map.spec.ts` reads the probe source itself, so it fails when a
failure string is reworded or a new probe has no guide row.

| Probe failure | Change |
| --- | --- |
| `process.js entry line changed` | `src/upstream-worker.ts` `probeContract`, `src/ptc-shim.mjs` argv order |
| `process.js imports a non-Node module` | `src/upstream-worker.ts` `probeContract` |
| `fd 7 control descriptor not found` | `src/ptc-shim.mjs` `spawnWorker` stdio array, `src/remote-world.ts` |
| `DSH_SUBPROCESS_CONTROL marker not found` | `src/ptc-shim.mjs` `spawnWorker` env |
| `control environment marker changed to X` | `PTC_CONTROL_ENV`, then the shim env block |
| `bootstrapArgs no longer maps process.js` | `src/remote-world.ts` `installWorkerPathMap` |
| `subprocess.spawn no longer requests a control pipe` | `src/remote-world.ts` `installRemoteWorld` |
| Handshake or auth failure | `src/ptc-shim.mjs` handshake/auth, `src/remote-world.ts` `consumeStderr` |
| Control-frame failure | `src/ptc-remote.ts` `dispatch`, `src/remote-world.ts` bridge |

### Two channels

- **Record only** (probes all pass, bytes changed): `npm run upgrade:ptc -- --write`.
  No code change.
- **Contract changed** (a probe fails): change the probe or adapter first, then
  `npm run upgrade:ptc -- --live --write`.

### Package manifest vs host overlay

- `--update` writes the package manifest and is for **releases only**; on an
  installed plugin that path is often read-only, and the script then points at
  `--adapt` instead of printing a stack.
- `npm run adapt:upstream` writes
  `$DSH_HOME/permission-remote/upstream-ptc.manifest.json`: no `node_modules`,
  no rebuild, effective on the next PTC call. It proves shape, not behavior.
- The plugin merges package and overlay entries on every remote run.
  Unknown drift must fail closed: never fall back to a local process.

### Anti-patterns

Do not vendor the worker, hand-edit the manifest, skip the live suite for a
contract change, or quietly run the program on the local host when the remote
worker is unavailable.

Scope of `scripts/check-upstream.mjs`:

- Does: locate the host install (`DSH_INSTALL_ROOT` or the running DSH entry),
  hash `process.js` / `lib/index.js` / `dsh-subprocess` control.js, run the six
  static probes, diff against the manifest, and with `--update`/`--adapt` record
  the entry in `vendor/upstream/ptc-worker.manifest.json` or the `$DSH_HOME`
  overlay. `--dry-run` reports the target without writing; `--explain` prints
  the guide row for each failure.
- Does not: run the test gates, bump version ranges, `engines`, docs, or release
  notes, verify the remote Node major, or adapt automatically at startup. A
  failed probe needs a code change to the probe/adapter first. That is what
  `scripts/upgrade.mjs` adds: the offline and live suites, and a refusal to
  record anything after a zero-test or all-skipped run.
- The runtime gate and `--check` match on worker bytes (hashes + control
  fd/env); version labels are metadata, so a DSH version bump with identical
  bytes is already usable. A drift report means the worker contract changed,
  not merely that the release label changed.

The same runbook ships to installed plugins as the runtime skill
`upstream-ptc-upgrade`, registered from `src/skills.ts` because
`.agents/skills/` is not a discovery root inside `node_modules`. The skill body
is `docs/upstream-ptc-worker.md`, so keep that file self-contained.

## Current migration status

See `docs/upstream-reuse-playbook.md`. The official surface for
`read`/`write`/`edit`/`apply_patch` is already used; `read_image` is now the
official `dsh-tool-fs` tool over remote `fs.readBytes`. `bash` delegates to
`dsh-tool-bash` with a thin `workdir` + login-env adapter; `grep`/`glob` delegate
to `dsh-tool-fs-search` with a thin `args.path` adapter; the vendored
`@deepseek-ai/dsh-fs-patch` copy is gone. Keep remote `fs`, `ssh-pool`, uploads,
ops, login-env, and present staging.
