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
| `present` staging | `@deepseek-ai/dsh-tool-present` | Cannot be replaced: the official card opens a local path, so staging is required. |
| `terminal_open` / sidebar PTY | `@deepseek-ai/dsh-tool-terminal` / `dsh-terminal-bash` | Separate remote `spawnTerminal`/TerminalBackend work; not the PTC seam. |

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
