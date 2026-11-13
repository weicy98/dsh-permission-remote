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
 *
 * Two producers must not be confused:
 * - the runtime `spawnTerminal` method lives in `dsh-subprocess-local`. The
 *   abstract `dsh-subprocess` package only mentions it in a JSDoc `{@link}`
 *   comment, so a substring test on that file is green even when the method is
 *   renamed or removed;
 * - the `DSH_SESSION_ID` that `installTerminalSpawnBridge` authorizes against
 *   is produced by `dsh-api-terminal-controller`. `dsh-terminal-bash` sets the
 *   same variable for its own dumb/model backend, but that is a different
 *   producer and cannot stand in for the controller.
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

/** Approximate one `class Name ... { ... }` block; enough to scope a shape check. */
function classBlock(source: string, name: string): string | undefined {
  const start = new RegExp(`(?:var|let|const)\\s+${name}\\s*=\\s*class`, 'u').exec(source)
    ?? new RegExp(`class\\s+${name}\\b`, 'u').exec(source)
  if (start === null) return undefined
  const bodyStart = source.indexOf('{', start.index)
  if (bodyStart < 0) return undefined
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start.index, index + 1)
    }
  }
  return undefined
}

/**
 * Probe the installed terminal packages under `dshRoot`.
 *
 * `dshRoot` is the `@deepseek-ai/dsh` package root, whose sibling
 * `node_modules/@deepseek-ai/*` directories hold the services this plugin
 * wraps. The plugin supports both 4-parameter (rc.1) and 5-parameter (rc.2)
 * `spawn`; any other shape is drift.
 *
 * A slimmed test/CI install without the terminal controller has no seam to
 * verify and is skipped. Once the controller is present, the install is a real
 * one: a missing companion package is fail-open drift, not a skip.
 */
export function probeTerminalContract(dshRoot: string, version: string): TerminalContractProbe {
  const failures: string[] = []
  const rows: Array<readonly [string, string]> = []
  const pkg = (name: string): string => join(dshRoot, 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')

  const controller = readOptional(pkg('dsh-api-terminal-controller'))
  if (controller === undefined) {
    return { failures: [], rows: [['terminal contract', 'skipped: dsh-api-terminal-controller not installed']] }
  }
  const bash = readOptional(pkg('dsh-terminal-bash'))
  const subprocessLocal = readOptional(pkg('dsh-subprocess-local'))
  const terminalCore = readOptional(pkg('dsh-terminal'))
  const abstractSubprocess = readOptional(pkg('dsh-subprocess'))

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

  const openForAgent = /async openForAgent\s*\(/u.test(controller)
  rows.push(['terminal.openForAgent', openForAgent ? 'present' : 'absent (rc.1)'])
  if (openForAgent) {
    const openAt = controller.indexOf('async openForAgent')
    const openSegment = openAt < 0 ? '' : controller.slice(openAt, openAt + 3000)
    const allocateAt = controller.indexOf('async allocate')
    const allocateSegment = allocateAt < 0 ? '' : controller.slice(allocateAt, allocateAt + 2500)
    if (!/this\.allocate\s*\(/u.test(openSegment) || !/this\.spawn\s*\(/u.test(allocateSegment)) {
      failures.push('dsh-api-terminal-controller: openForAgent -> allocate -> this.spawn path is broken; the sidebar/spawn wrapper may be bypassed')
    }
  }

  // rc.1 sets this inside `spawn`; rc.2 sets it in `userLaunch`/`agentLaunch`
  // and forwards it through `prepare`. Either way the controller is the only
  // producer that reaches `spec.env.DSH_SESSION_ID` for sidebar terminals.
  const controllerSessionCount = [...controller.matchAll(/DSH_SESSION_ID\s*:\s*agent\.id/gu)].length
  const expectedSessionSites = version === '0.2.2-rc.2' ? 2 : 1
  rows.push(['terminal-controller DSH_SESSION_ID', `${controllerSessionCount} site(s)`])
  if (controllerSessionCount < expectedSessionSites) {
    failures.push(`dsh-api-terminal-controller: spawnTerminal receives DSH_SESSION_ID from agent.id at ${controllerSessionCount} site(s); expected at least ${expectedSessionSites}; the spawn bridge cannot authorize every session path`)
  }

  // rc.1 calls `subprocess.spawnTerminal`; rc.2 calls
  // `this.execution(agent).subprocess.spawnTerminal`. Both must be present or
  // the bridge has no method to wrap.
  const controllerCallsSpawnTerminal = /spawnTerminal\s*\(/u.test(controller)
  rows.push(['terminal-controller spawnTerminal call', controllerCallsSpawnTerminal ? 'present' : 'absent'])
  if (!controllerCallsSpawnTerminal) {
    failures.push('dsh-api-terminal-controller: no longer calls subprocess.spawnTerminal; installTerminalSpawnBridge has nothing to wrap')
  }

  const sessionEnv = bash !== undefined && /DSH_SESSION_ID\s*:\s*spec\.owner\.id/u.test(bash)
  rows.push(['terminal-bash DSH_SESSION_ID', sessionEnv ? 'present' : 'absent'])
  if (bash === undefined) {
    failures.push('dsh-terminal-bash: not installed in a DSH build that ships the terminal controller')
  } else if (!sessionEnv) {
    failures.push('dsh-terminal-bash: childEnvironment no longer sets DSH_SESSION_ID from spec.owner.id; the spawn bridge cannot authorize a session')
  }

  // The real runtime method. `dsh-subprocess/lib/index.js` only contains a
  // `{@link spawnTerminal}` comment, so this must be a method-definition shape
  // check against `dsh-subprocess-local`, not a substring test on a comment.
  const localSpawn = signature(subprocessLocal, /^\s*async\s+spawnTerminal\s*\(([^)]*)\)\s*\{/mu)
  rows.push(['dsh-subprocess-local spawnTerminal', localSpawn === undefined ? 'absent' : `${localSpawn} parameter(s)`])
  if (subprocessLocal === undefined) {
    failures.push('dsh-subprocess-local: not installed in a DSH build that ships the terminal controller')
  } else if (localSpawn === undefined) {
    failures.push('dsh-subprocess-local: `async spawnTerminal(spec) {` not found; installTerminalSpawnBridge has nothing to wrap')
  } else if (localSpawn !== 1) {
    failures.push(`dsh-subprocess-local: spawnTerminal has ${localSpawn} parameters; the spawn bridge calls it with one spec`)
  }

  // rc.2 uses this pre-existing API twice per agent terminal (shell resolution
  // and HISTFILE). The plugin answers it with the remote route, so a renamed or
  // removed method would silently fall back to this computer's $SHELL.
  const localEnvironment = subprocessLocal !== undefined && /^\s*async\s+terminalEnvironment\s*\([^)]*\)\s*\{/mu.test(subprocessLocal)
  rows.push(['dsh-subprocess-local terminalEnvironment', localEnvironment ? 'present' : 'absent'])
  if (subprocessLocal !== undefined && !localEnvironment) {
    failures.push('dsh-subprocess-local: `async terminalEnvironment(signal)` not found; rc.2 agentLaunch needs it for the shell and HISTFILE decision')
  }

  // rc.2 made terminal and subprocess failures machine-routable via a stable
  // `code`; rc.1 already had `code` on TerminalError but no SUBPROCESS_*
  // catalogue. Require the shape each supported version actually ships, so a
  // future build that drops `.code` cannot force message-based classification.
  const terminalBlock = terminalCore === undefined ? undefined : classBlock(terminalCore, 'TerminalError')
  const codedTerminal = terminalBlock !== undefined && /this\.code\s*=/u.test(terminalBlock)
  rows.push(['terminal error codes', codedTerminal ? 'present' : 'absent'])
  if (terminalCore === undefined) {
    failures.push('dsh-terminal: not installed in a DSH build that ships the terminal controller')
  } else if (!codedTerminal) {
    failures.push('dsh-terminal: TerminalError no longer carries a stable code; error routing by message is unsafe')
  }

  const hasCodeCatalogue = abstractSubprocess !== undefined && /SUBPROCESS_ERROR_CODES/u.test(abstractSubprocess)
  const subprocessBlock = abstractSubprocess === undefined ? undefined : classBlock(abstractSubprocess, 'SubprocessError')
  const codedSubprocess = subprocessBlock !== undefined && /this\.code\s*=/u.test(subprocessBlock)
  const expectsCatalogue = version !== '0.2.2-rc.1'
  rows.push(['subprocess error codes', hasCodeCatalogue ? (codedSubprocess ? 'present' : 'absent') : 'n/a (rc.1)'])
  if (abstractSubprocess === undefined) {
    failures.push('dsh-subprocess: not installed in a DSH build that ships the terminal controller')
  } else if (expectsCatalogue && !hasCodeCatalogue) {
    failures.push('dsh-subprocess: SUBPROCESS_ERROR_CODES catalogue not found; rc.2+ needs stable subprocess error codes')
  } else if (hasCodeCatalogue && !codedSubprocess) {
    failures.push('dsh-subprocess: SubprocessError no longer carries SUBPROCESS_* codes; error routing by message is unsafe')
  }

  if (!(VERIFIED_TERMINAL_DSH_VERSIONS as readonly string[]).includes(version)) {
    failures.push(`DSH ${version} is not in the verified terminal contract list (${VERIFIED_TERMINAL_DSH_VERSIONS.join(', ')}); run the terminal smoke test and add it before releasing`)
  }
  rows.push(['verified DSH versions', VERIFIED_TERMINAL_DSH_VERSIONS.join(', ')])

  return { failures, rows }
}
