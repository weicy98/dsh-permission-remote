# Implementation log

One row per logical step. A row may be written while the work is still
uncommitted; its `Commit` cell then holds the intended subject. Every row records
the verification actually run **at the time of that step** — a test count is a
point-in-time snapshot, not a running total, because later steps add tests. Do
not mark a row complete from static inspection alone.

| Step | Commit | Change | Verification |
| --- | --- | --- | --- |
| S0 | chore: 从 main 建立 PTC 上游 worker 骨架 | Worktree `ptc-upstream-worker-main`, docs, script skeleton | `git merge-base --is-ancestor main HEAD` 通过 |
| S1 | feat: 定位宿主 PTC worker 与契约 manifest | Locator, contract probes, manifest | `npm run check:upstream` 通过（DSH 0.2.2-rc.1） |
| S2 | feat: ptc-shim | fd7 socket shim | `tests/ptc-shim.spec.ts` 3/3 通过 |
| S3 | feat: remote-world | confine/spawn adapter, local transport, offline e2e | `tests/ptc-offline.spec.ts` 5/5、`tests/remote-world.spec.ts` 2/2 通过 |
| S4 | feat: 接入插件 apply 与 SSH transport | SSH transport, Node status, plugin wiring | `npm test` 667/667、`npm run typecheck` 通过 |
| S5 | test/docs: 真机 e2e 与用户文档 | Live e2e, README/advanced docs | `DSH_PTC_LIVE=1 ... npm run e2e:ptc` 4/4 通过（local host `h680183c9af9ceca4`） |
| S6 | feat: 持久模式（可选） | official runtime persistent-in-memory / vm-script; persistent worker uploaded | 离线 persistent 2/2、真机 persistent 1/1 通过 |
| S7 | chore: 版本、lib 与发布 | version 0.14.0, build, release checks | `npm run check:upstream`、`npm test` 667/667、`npm run build` 通过 |
| S8 | feat: 复用官方文件工具与通用远端执行世界 | official `dsh-fs-patch` + `read_image`, generic `RemoteProcessHandle`, official bash/search adapters | `npm test` 675/675、`npm run test:ptc` 11/11、local host PTC e2e 4/4 通过 |
| S9 | fix: PTC 安全、生命周期与官方工具适配审查修复 | pinned sandbox root + session host gate, handshake timer, authenticated shim/worker cleanup, byte-based manifest matching, strict realpath, stale ready flags | `npm test` 686/686、`npm run test:ptc` 18/18、local host PTC e2e 4/4 通过 |
| S10 | feat: 上游升级脚本与运行时 runbook skill | `npm run upgrade:ptc` four-step gate over the full suite (zero-test and all-skipped runs are exit 2), `check:upstream --explain` + guide table, install-state-aware advice, `--reset` deletes the overlay, runtime skill `upstream-ptc-upgrade`, `isRemotePtcRuntime` guard | `npm run typecheck`、`npm test` 751/751（0 skipped）、`npm run test:ptc` 22/22、`npm run build` 通过；version 0.16.0 |
| S11 | fix: 远端文件工具减少重复读取与锁改进 | version evidence reuses captured bytes across write/edit/patch/delete/move, structured `limitExceeded`, normalized target lock key (incl. move's two locks), line-ending parity documented | `npm run typecheck`、`npm test` 760/760、`npm run build` 通过 |
| S12 | fix: 二轮审查（探针守卫、CLI 参数、写入校验、wrap 隔离） | probe guard reads source instead of a hardcoded copy, reachable `--explain` guide rows, unknown/contradictory CLI flags refused, `--dsh-root` restore, live skip parity, shared `scripts/cli-common.mjs`, post-write hash reuses committed bytes (CRLF-correct), bounded identity cache, realpath lock keys, exit-75 mapping, wrap rollback (no fail-open), probe self-heal, empty spill-dir cleanup | `npm run typecheck`、`npm test` 799/799、`npm run test:ptc` 33/33、`npm run check:upstream`、`npm run build` 通过 |
| S13 | fix: 三轮审查（identity LRU、runbook 覆盖、spill 保留） | `containsRemote` touches both identities so an actively checked root survives unrelated resolves; runbook decision table pinned to `PROBE_GUIDES` by a test; spill artifacts bounded to newest 64 files / 256 MiB (never pruning the current file); probe self-heal covers `ripgrep: upload-failed`; stale test-count comment removed | `npm run typecheck`、`npm test` 804/804、`npm run build` 通过 |

S10–S13 are still uncommitted work in progress; their `Commit` cells are the
intended subjects. The test counts are what each step's own `npm test` printed
at the time, not the current total. Add a new row for a step rather than editing
an earlier row's count.
