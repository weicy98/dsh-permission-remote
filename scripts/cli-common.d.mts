/** Flags accepted by `upgrade.mjs`. */
export declare const UPGRADE_FLAGS: readonly string[]

/** Flags accepted by `check-upstream.mjs`. */
export declare const CHECK_UPSTREAM_FLAGS: readonly string[]

/** Arguments that are not known flags; `--dsh-root` consumes its next argument. */
export declare function unknownFlags(argv: readonly string[], knownFlags: readonly string[]): string[]

/** The two lines printed when an unknown flag is refused. */
export declare function unknownFlagLines(unknown: readonly string[], knownFlags: readonly string[], label: string): string[]

/** Whether this copy came from the npm package rather than a source checkout. */
export declare function isInstalledPackage(): boolean

/** Whether the caller was invoked as the CLI entry point. */
export declare function isEntryPoint(metaUrl: string): boolean

/** Set `process.exitCode` so stdout can drain before the process exits. */
export declare function exitAfterFlush(code: number): void

/** An error whose `code` is `USAGE`; the CLI entry maps it to exit code 2. */
export declare function usage(message: string): Error & { code: 'USAGE' }

/** Apply `--dsh-root <path>` to `env`; throws a USAGE error when the value is missing. */
export declare function applyDshRoot(argv: readonly string[], env: NodeJS.ProcessEnv): string | undefined

/** Run `fn`, then restore `env.DSH_INSTALL_ROOT` even if `fn` throws. */
export declare function withDshRoot<T>(env: NodeJS.ProcessEnv, fn: (env: NodeJS.ProcessEnv) => T): T

/** Re-read the installed worker sources and return `probeContract().failures`. */
export declare function probeFailures(env: NodeJS.ProcessEnv): readonly string[] | undefined

/** Print one probe failure's guide row, or an honest no-row fallback. */
export declare function renderFailureGuide(failure: string, error: (line: string) => void): void
