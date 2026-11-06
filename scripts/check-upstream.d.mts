export interface RunOptions {
  /** Arguments after the script name. Defaults to `process.argv.slice(2)`. */
  readonly argv?: readonly string[]
  readonly log?: (line: string) => void
  readonly error?: (line: string) => void
  /** Overrides the installed-package detection; defaults to `isInstalledPackage()`. */
  readonly installed?: boolean
}

export interface RunResult {
  readonly code: number
  readonly wrote?: string
}

/**
 * Whether this copy came from the npm package rather than a source checkout.
 *
 * `tests/` is not in `package.json` `files`, so its absence is the signal.
 */
export declare function isInstalledPackage(): boolean

/**
 * Run the check/update/adapt/reset flow.
 *
 * Unknown flags return code 2; `--dsh-root` is applied only for this call and
 * `DSH_INSTALL_ROOT` is restored before `run()` returns.
 */
export declare function run(options?: RunOptions): RunResult
