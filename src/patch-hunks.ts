/**
 * Thin typed wrapper around the verbatim-vendored fs-patch runtime.
 * Consumers use: import { applyHunks, type PatchHunk } from './patch-hunks.ts'
 * The runtime implementation is the byte-for-byte copy in ../vendor/fs-patch/index.js;
 * the types come from the declaration shim ../vendor/fs-patch/index.d.ts.
 */
import type {
  PatchHunk,
  ApplyHunksResult,
  HunkApplyFailure,
  PatchOperation,
} from '../vendor/fs-patch/index.js'

export { applyHunks } from '../vendor/fs-patch/index.js'
export type { PatchHunk, ApplyHunksResult, HunkApplyFailure, PatchOperation }
