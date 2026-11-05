# Vendored: @deepseek-ai/dsh-fs-patch@0.2.2-rc.1

Verbatim, byte-for-byte copy of the pure Codex-style patch parser / LF text
updater shipped with DSH 0.2.2-rc.1. The three files below are copied with
`cp` and MUST NOT be hand-edited.

- Package: `@deepseek-ai/dsh-fs-patch@0.2.2-rc.1`
- Copy date: 2026-11-05
- License: MIT for the DeepSeek contributions, plus Apache License 2.0 for the
  portions adapted from OpenAI Codex (`rust-v0.158.0`). The vendored
  [LICENSE](./LICENSE) is the package's own LICENSE file and carries both the
  MIT text, the OpenAI copyright notice, the modification notice and the full
  Apache-2.0 text. `index.js` refers to it from its header.
- Rule: verbatim copy, do not hand-edit; verify with `node vendor/fs-patch/verify.mjs`.

## Provenance (upstream paths inside the package)

| Vendored file | Upstream path inside `@deepseek-ai/dsh-fs-patch@0.2.2-rc.1` |
| --- | --- |
| `index.js` | `lib/index.js` |
| `types.d.ts` | `lib/types/types.d.ts` |
| `LICENSE` | `LICENSE` |

`index.d.ts` (this directory) is an authored thin declaration shim, not a
verbatim copy; `src/patch-hunks.ts` is an authored typed wrapper.

## SHA-256 checksums

- `index.js`: `c70df243ca6524ef1f2209736a4c1b4609b683f35ff6f031d35c22397379ca8a`
- `types.d.ts`: `407515c8b25cf75e5d87b7b56ef5de460f76315940acd26536a9d3a316831247`
- `LICENSE`: `02a4a4d8618e067a703c59495da27a60e7579f70639230a35f0a0cec6ae125f4`

Recompute and compare with:

```
node vendor/fs-patch/verify.mjs
```
