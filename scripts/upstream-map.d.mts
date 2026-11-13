/** One row of the upgrade decision table. */
export interface Guide {
  /** Stable identifier, also the test fixture key. */
  readonly id: string
  /** Exact probe failure string, or its stable prefix when it embeds a value. */
  readonly match: string
  /** What the probe looked for and why the plugin needs it. */
  readonly meaning: string
  /** File and function to change. */
  readonly where: string
  /** Command to run after the change. */
  readonly next: string
}

export declare const PROBE_GUIDES: readonly Guide[]
/** Sandbox-profile probes. Separate from the PTC worker table. */
export declare const SANDBOX_PROFILE_GUIDES: readonly Guide[]
/** Terminal seam probes from src/upstream-terminal.ts. */
export declare const TERMINAL_GUIDES: readonly Guide[]
export declare const CHANNEL_GUIDES: readonly Guide[]

/** Match a failure message against the guide table; undefined when no row fits. */
export declare function guideFor(message: string): Guide | undefined

/** Render one guide as the lines to print. */
export declare function renderGuide(guide: Guide): string[]
