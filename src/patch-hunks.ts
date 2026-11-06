/**
 * Typed re-export of the installed official patch implementation.
 *
 * The pure Codex-style patch parser and LF updater live in
 * `@deepseek-ai/dsh-fs-patch`; this module only keeps the plugin's import
 * surface stable so remote-fs does not depend on the package path directly.
 */
export { applyHunks, parsePatch } from '@deepseek-ai/dsh-fs-patch'
export type { PatchHunk, ApplyHunksResult, HunkApplyFailure, PatchOperation } from '@deepseek-ai/dsh-fs-patch'
