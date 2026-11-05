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
2. Read `lib/process.js`, `lib/persistent-process.js`, `lib/index.js`, and
   `@deepseek-ai/dsh-subprocess/lib/control.js`.
3. Probe: entry line, `fd: 7`, `DSH_SUBPROCESS_CONTROL`, Node-builtins-only
   imports, `bootstrapArgs` mapping, `stdio.control: 'pipe'`.
4. Upload as `process.mjs` / `persistent-process.mjs`; never `.js` without a
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

```bash
npm run check:upstream
npm run test:ptc
DSH_PTC_LIVE=1 ... npm run e2e:ptc
npm run check:upstream -- --update
```

`npm run adapt:upstream` is the one-command installed-host static adaptation;
it writes a writable `$DSH_HOME/permission-remote/upstream-ptc.manifest.json`
overlay only after contract probes pass, and reminds you to run the e2e gates.
Unknown drift must fail closed.

## Remaining hand-written candidates

See `docs/upstream-reuse-playbook.md`. Highest value: `read_image` (try the
official tool over remote `fs.readBytes`), `bash` (official `dsh-tool-bash` with
a full remote `SubprocessRuntime`), `grep`/`glob` (official
`dsh-tool-fs-search` builders plus a path adapter), and the vendored
`@deepseek-ai/dsh-fs-patch` copy. Keep remote `fs`, `ssh-pool`, uploads, ops,
login-env, and present staging.
