export interface TestCounts {
  readonly tests: number
  readonly pass?: number
  readonly fail?: number
  readonly skipped?: number
}

export interface ExecuteResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** Set when the command could not run at all (ENOBUFS, EAGAIN, missing binary). */
  readonly error?: string
}

export interface RunOptions {
  readonly argv?: readonly string[]
  readonly log?: (line: string) => void
  readonly error?: (line: string) => void
  /** Overrides the installed-package detection; defaults to `isInstalledPackage()`. */
  readonly installed?: boolean
  /** Replaces the real `npm`/`node` invocation; used to simulate gate outcomes. */
  readonly execute?: (command: string, args: string[], env?: Record<string, string | undefined>) => ExecuteResult
}

export interface RunResult {
  readonly code: number
  readonly wrote?: string
  readonly entry?: object
}

/**
 * Whether this copy came from the npm package rather than a source checkout.
 *
 * `tests/` is not in `package.json` `files`, so its absence is the signal.
 */
export declare function isInstalledPackage(): boolean

/** Parse the `node --test` summary; undefined when no summary was printed. */
export declare function testCounts(text: string): TestCounts | undefined

/**
 * Run the four-step upgrade gate.
 *
 * Unknown flags and contradictory combinations return code 2; `--dsh-root` is
 * applied only for this call and `DSH_INSTALL_ROOT` is restored before
 * `run()` returns.
 */
export declare function run(options?: RunOptions): RunResult
