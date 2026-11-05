/**
 * Thin ambient declaration shim for the verbatim-vendored fs-patch runtime.
 * The executable implementation lives in ./index.js (see SOURCE.md); this file
 * declares only its public surface and re-exports the vendored types. No algorithm.
 */
import type { ApplyHunksResult, HunkApplyFailure, PatchHunk, PatchOperation } from './types.js'

export type { ApplyHunksResult, HunkApplyFailure, PatchHunk, PatchOperation }

export declare function applyHunks(before: string, hunks: readonly PatchHunk[]): ApplyHunksResult
export declare function parsePatch(patch: string): PatchOperation[]
export declare class PatchParseError extends Error {
    readonly lineNumber: number
    readonly reason: string
    constructor(lineNumber: number, message: string)
}
