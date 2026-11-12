/**
 * Contract probes for the upstream terminal packages this plugin wraps.
 *
 * The PTC worker and sandbox profiles have their own gates in
 * `upstream-worker.ts` / `profile-contract.ts`. This module covers the other
 * upstream seam that has broken in practice: `TerminalController.spawn` changed
 * from four parameters to five between DSH `0.2.2-rc.1` and `0.2.2-rc.2`, and a
 * four-parameter wrapper silently dropped the cancellation signal.
 *
 * The probes are source-shape checks, not a substitute for running the real
 * backend; they fail loudly when a supported DSH version changes the shape.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** DSH versions whose terminal API this plugin is verified against. */
export const VERIFIED_TERMINAL_DSH_VERSIONS = ['0.2.2-rc.1', '0.2.2-rc.2'] as const

export interface TerminalContractProbe {
  readonly failures: string[]
  readonly rows: Array<readonly [string, string]>
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function parameterCount(match: RegExpMatchArray | null): number | undefined {
  if (match === null) return undefined
  const inner = (match[1] ?? '').trim()
  if (inner.length === 0) return 0
  return inner.split(',').map(part => part.trim()).filter(part => part.length > 0).length
}

function signature(source: string | undefined, pattern: RegExp): number | undefined {
  if (source === undefined) return undefined
  return parameterCount(source.match(pattern))
}

/**
 * Probe the installed terminal packages under `dshRoot`.
 *
 * `dshRoot` is the `@deepseek-ai/dsh` package root, whose sibling
 * `node_modules/@deepseek-ai/*` directories hold the services this plugin
 * wraps. The plugin supports both 4-parameter (rc.1) and 5-parameter (rc.2)
 * `spawn`; any other shape is drift.
 */
export function probeTerminalContract(dshRoot: string, version: string): TerminalContractProbe {
  const failures: string[] = []
  const rows: Array<readonly [string, string]> = []
  const pkg = (name: string): string => join(dshRoot, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')

  const controller = readOptional(pkg('dsh-api-terminal-controller'))
  const bash = readOptional(pkg('dsh-terminal-bash'))
  const subprocess = readOptional(pkg('dsh-subprocess'))
  // A slimmed test/CI install may not ship the terminal packages at all. That
  // is not drift: there is no terminal seam to verify. A real DSH install
  // always has them, so a shape change there is still caught.
  if (controller === undefined) {
    return { failures: [], rows: [['terminal contract', 'skipped: dsh-api-terminal-controller not installed']] }
  }

  const spawn = signature(controller, /async spawn\s*\(([^)]*)\)/u)
  rows.push(['terminal.spawn params', String(spawn ?? '(not found)')])
  if (spawn === undefined) {
    failures.push('dsh-api-terminal-controller: `async spawn(...)` not found')
  } else if (spawn !== 4 && spawn !== 5) {
    failures.push(`dsh-api-terminal-controller: TerminalController.spawn has ${spawn} parameters; this plugin supports 4 (rc.1) and 5 (rc.2)`)
  }

  const create = signature(controller, /async create\s*\(([^)]*)\)/u)
  rows.push(['terminal.create params', String(create ?? '(not found)')])
  if (create !== 3) {
    failures.push(`dsh-api-terminal-controller: TerminalController.create has ${create ?? '(not found)'} parameters; expected 3`)
  }

  const shells = signature(controller, /\n\s*shells\s*\(([^)]*)\)\s*\{/u)
  rows.push(['terminal.shells params', String(shells ?? '(not found)')])
  if (shells !== 2) {
    failures.push(`dsh-api-terminal-controller: TerminalController.shells has ${shells ?? '(not found)'} parameters; expected 2`)
  }

  const openForAgent = controller === undefined ? false : /async openForAgent\s*\(/u.test(controller)
  rows.push(['terminal.openForAgent', openForAgent ? 'present' : 'absent (rc.1)'])
  if (openForAgent && !/this\.spawn\s*\(/u.test(controller ?? '')) {
    failures.push('dsh-api-terminal-controller: openForAgent exists but does not call this.spawn; the sidebar/spawn wrapper may be bypassed')
  }

  const sessionEnv = bash !== undefined && /DSH_SESSION_ID\s*:\s*spec\.owner\.id/u.test(bash)
  rows.push(['terminal-bash DSH_SESSION_ID', sessionEnv ? 'present' : 'absent'])
  if (bash !== undefined && !sessionEnv) {
    failures.push('dsh-terminal-bash: childEnvironment no longer sets DSH_SESSION_ID from spec.owner.id; the spawn bridge cannot authorize a session')
  }

  const spawnTerminal = subprocess !== undefined && /spawnTerminal/u.test(subprocess)
  rows.push(['dsh-subprocess spawnTerminal', spawnTerminal ? 'present' : 'absent'])
  if (subprocess !== undefined && !spawnTerminal) {
    failures.push('dsh-subprocess: spawnTerminal is absent; installTerminalSpawnBridge has nothing to wrap')
  }

  if (!(VERIFIED_TERMINAL_DSH_VERSIONS as readonly string[]).includes(version)) {
    failures.push(`DSH ${version} is not in the verified terminal contract list (${VERIFIED_TERMINAL_DSH_VERSIONS.join(', ')}); run the terminal smoke test and add it before releasing`)
  }
  rows.push(['verified DSH versions', VERIFIED_TERMINAL_DSH_VERSIONS.join(', ')])

  return { failures, rows }
}
