# Implementation log

One row per commit. Every row records the step, the commit subject, and the
verification actually run. Do not mark a row complete from static inspection
alone.

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
| S9 | fix: PTC 安全与生命周期审查修复 | pinned sandbox root + session host gate, handshake timer, authenticated shim/worker cleanup, byte-based manifest matching, strict realpath, stale ready flags | `npm test` 683/683、`npm run test:ptc` 18/18、local host PTC e2e 4/4 通过 |
