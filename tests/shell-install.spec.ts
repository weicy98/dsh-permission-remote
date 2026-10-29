import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { mapRemoteToLocal } from '../src/router.ts'
import { PWSH_SECTION, REMOTE_POSIX_SECTION, WINDOWS_SHELL_DENIED } from '../src/shell-surface.ts'

const remoteCwd = mapRemoteToLocal('host1', '/srv/app')!
const localCwd = '/tmp/local-project'
const OFFICIAL_BASH = 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.'
const OFFICIAL_PWSH = 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.'

interface RegisteredTool {
  name: string
  description?: string
  active: boolean
  execute: (args: unknown, exec: object) => Promise<unknown>
}

interface RegisteredSection {
  name: string
  order: number
  text: string | (() => string)
  active: boolean
}

interface SurfaceOptions {
  headerCwd: string
  liveCwd?: string
  /** `missing` skips the service so the header is the fallback. `throw` falls through the same way. */
  directory?: 'live' | 'throw' | 'missing'
  officialBash?: boolean
  restrictable?: ReadonlySet<string>
  restrictError?: (name: string) => Error | undefined
  /** The first dynamic `tool:pwsh` disposer deactivates, then throws once. */
  failSectionDispose?: boolean
}

function surface(options: SurfaceOptions) {
  const ctx = new Context()
  const warnings: string[] = []
  const logger = (ctx as unknown as { logger: { warn: (format: unknown, ...rest: unknown[]) => void } }).logger
  const warn = logger.warn.bind(logger)
  logger.warn = (format: unknown, ...rest: unknown[]) => {
    warnings.push(typeof format === 'string' ? format : String(format))
    warn(format, ...rest)
  }
  ctx.provide('settings', { configure: () => () => undefined, describe: () => [], update: async () => undefined })
  const live = { current: options.liveCwd ?? options.headerCwd }
  if (options.directory === 'throw') {
    ctx.provide('workingDirectory', { get: () => { throw new Error('no recorded directory') } })
  } else if (options.directory !== 'missing') {
    ctx.provide('workingDirectory', { get: () => live.current })
  }
  const pluginDisposers: Array<() => void> = []
  const writable = ctx as unknown as { effect(execute: () => unknown): unknown }
  const originalEffect = writable.effect.bind(ctx)
  writable.effect = execute => originalEffect(() => {
    const dispose = execute()
    if (typeof dispose === 'function') pluginDisposers.push(dispose as () => void)
    return dispose
  })
  apply(ctx, { hosts: [], maxConnections: 4 })

  const tools: RegisteredTool[] = []
  const sections: RegisteredSection[] = []
  const denies: string[] = []
  const restrictCalls: string[] = []
  const guards: Array<{ active: boolean, fn: (execution: { name: string, agent?: object }) => string | undefined }> = []
  const listeners: Array<{ event: string, active: boolean, fn: (...args: unknown[]) => unknown }> = []
  const cleanups: Array<() => void> = []
  let sectionDisposeFailures = options.failSectionDispose === true ? 1 : 0
  const restrictable = options.restrictable ?? new Set(['pwsh', 'powershell', 'cmd'])
  const officialCalls: string[] = []
  const header = { cwd: options.headerCwd }
  const agent = {
    session: { header },
    ctx: {
      tools: {
        get: (name: string) => {
          if (name === 'bash' && options.officialBash !== true) return undefined
          if (!['bash', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'working_directory', 'terminal_open'].includes(name)) return undefined
          return {
            execute: async () => {
              officialCalls.push(name)
              return 'official'
            },
          }
        },
        register: (definition: { name: string, description?: string, execute: (args: unknown, exec: object) => Promise<unknown> }) => {
          const entry: RegisteredTool = { name: definition.name, description: definition.description, active: true, execute: definition.execute }
          tools.push(entry)
          return () => { entry.active = false }
        },
        restrict: (filter: { deny?: readonly string[] }) => {
          const name = filter.deny?.[0]
          if (name === undefined) throw new Error('tools.restrict() called with an empty deny list')
          restrictCalls.push(name)
          const failure = options.restrictError?.(name)
          if (failure !== undefined) throw failure
          if (!restrictable.has(name)) throw new Error(`tools.restrict() names unknown global tool "${name}"; known global tools: bash`)
          denies.push(name)
          return () => {
            const index = denies.indexOf(name)
            if (index >= 0) denies.splice(index, 1)
          }
        },
        guard: (fn: (execution: { name: string, agent?: object }) => string | undefined) => {
          const entry = { active: true, fn }
          guards.push(entry)
          return () => { entry.active = false }
        },
      },
      systemPrompt: {
        section: (spec: { name: string, order: number, text: string | (() => string) }) => {
          if (spec.name === PWSH_SECTION && sections.some(section => section.name === PWSH_SECTION && section.active)) {
            throw new Error(`prompt section "${spec.name}" is already registered in this scope`)
          }
          const entry: RegisteredSection = { name: spec.name, order: spec.order, text: spec.text, active: true }
          sections.push(entry)
          return () => {
            entry.active = false
            if (spec.name === PWSH_SECTION && sectionDisposeFailures > 0) {
              sectionDisposeFailures -= 1
              throw new Error('section dispose failed')
            }
          }
        },
        getSectionOrder: (name: string) => {
          if (name === 'TOOL_PWSH') return 1010
          if (name === 'TOOL_BASH') return 1000
          throw new Error(`unknown section order ${name}`)
        },
      },
      on: (event: string, fn: (...args: unknown[]) => unknown) => {
        const entry = { event, active: true, fn }
        listeners.push(entry)
        return () => { entry.active = false }
      },
      get: () => undefined,
      effect: (execute: () => unknown) => {
        const dispose = execute()
        if (typeof dispose === 'function') cleanups.push(dispose as () => void)
      },
    },
  }

  const activeTools = (name?: string) => tools.filter(tool => tool.active && (name === undefined || tool.name === name))
  const activeSections = (name?: string) => sections.filter(section => section.active && (name === undefined || section.name === name))
  const textOf = (section: RegisteredSection): string => typeof section.text === 'function' ? section.text() : section.text
  const render = (): string => {
    const byName = new Map<string, string>([['tool:bash', OFFICIAL_BASH], [PWSH_SECTION, OFFICIAL_PWSH]])
    for (const section of activeSections()) byName.set(section.name, textOf(section))
    return [...byName.values()].filter(text => text.length > 0).join('\n\n')
  }
  const listener = (event: string) => listeners.find(entry => entry.event === event && entry.active)
  const emit = (type: string, cwd?: string) => {
    if (cwd !== undefined) live.current = cwd
    const sessionListener = listener('session/event')
    assert.ok(sessionListener)
    sessionListener.fn(agent.session as never, { type, data: cwd === undefined ? {} : { cwd } } as never)
  }
  const guard = (name: string) => {
    const entry = guards.find(item => item.active)
    assert.ok(entry)
    return entry.fn({ name, agent })
  }
  const assemble = async (names: string[], scope: object = agent) => {
    const entry = listener('system-prompt/assemble')
    assert.ok(entry)
    const toolsForModel = names.map(name => ({ name }))
    const result = await entry.fn({ tools: toolsForModel } as never, { scope } as never, (async () => ({ tools: toolsForModel })) as never) as { tools: Array<{ name: string }> }
    return result.tools.map(tool => tool.name)
  }

  return {
    agent,
    header,
    live,
    officialCalls,
    restrictCalls,
    denies,
    warnings,
    pluginDisposers,
    cleanups,
    activeTools,
    activeSections,
    render,
    emit,
    guard,
    assemble,
    activeGuards: () => guards.filter(entry => entry.active).length,
    toolCount: (name: string) => tools.filter(tool => tool.name === name).length,
    sectionCount: (name: string) => sections.filter(section => section.name === name).length,
    created: async () => {
      const dispatch = ctx as unknown as { serial(name: string, payload: { agent: object }): Promise<void> }
      await dispatch.serial('agent/created', { agent })
    },
  }
}

test('a Windows-shaped remote install hides pwsh and registers bash without replacing tool:bash', async () => {
  const session = surface({ headerCwd: remoteCwd, officialBash: false })
  await session.created()
  assert.deepEqual(session.denies, ['pwsh', 'powershell', 'cmd'])
  assert.equal(session.activeTools('bash').length, 1)
  assert.match(session.activeTools('bash')[0]?.description ?? '', /remote workspace/)
  const pwsh = session.activeSections(PWSH_SECTION)
  assert.equal(pwsh.length, 1)
  assert.equal(pwsh[0]?.text, '')
  assert.equal(pwsh[0]?.order, 1010)
  const posix = session.activeSections(REMOTE_POSIX_SECTION)
  assert.equal(posix.length, 1)
  assert.equal(posix[0]?.order, 1005)
  assert.equal(session.activeSections('tool:bash').length, 0)
  const rendered = session.render()
  assert.match(rendered, /POSIX host/)
  assert.match(rendered, /Check the \[exit code: N\] marker/)
  assert.doesNotMatch(rendered, /On Windows a killed process settles/)
  assert.deepEqual(await session.assemble(['pwsh', 'powershell', 'cmd', 'bash', 'read']), ['bash', 'read'])
  assert.deepEqual(await session.assemble(['pwsh', 'bash'], {}), ['pwsh', 'bash'])
  assert.equal(session.guard('pwsh'), WINDOWS_SHELL_DENIED)
  assert.equal(session.guard('bash'), undefined)
})

test('a scope-local pwsh is skipped by restrict, removed from the schema, and denied by the guard', async () => {
  const session = surface({ headerCwd: remoteCwd, restrictable: new Set() })
  await session.created()
  assert.deepEqual(session.restrictCalls, ['pwsh', 'powershell', 'cmd'])
  assert.deepEqual(session.denies, [])
  assert.equal(session.activeSections(PWSH_SECTION).length, 1)
  assert.deepEqual(await session.assemble(['pwsh', 'bash']), ['bash'])
  assert.equal(session.guard('pwsh'), WINDOWS_SHELL_DENIED)
})

test('powershell and cmd are denied only when they are restrictable', async () => {
  const session = surface({ headerCwd: remoteCwd, restrictable: new Set(['pwsh']) })
  await session.created()
  assert.deepEqual(session.restrictCalls, ['pwsh', 'powershell', 'cmd'])
  assert.deepEqual(session.denies, ['pwsh'])
})

test('a non-unknown restrict error fails remote agent creation and drops both registration sets', async () => {
  const session = surface({
    headerCwd: remoteCwd,
    restrictError: name => name === 'powershell' ? new Error('tools registry is closed') : undefined,
  })
  await assert.rejects(() => session.created(), /tools registry is closed/)
  assert.ok(session.toolCount('read') > 0)
  assert.equal(session.activeTools().length, 0)
  assert.deepEqual(session.denies, [])
  assert.equal(session.activeSections().length, 0)
  assert.equal(session.activeGuards(), 0)
  assert.equal(session.restrictCalls.includes('powershell'), true)
  assert.equal(session.restrictCalls.includes('cmd'), false)
})

test('a local agent does not deny Windows shells or cover tool:pwsh', async () => {
  const session = surface({ headerCwd: localCwd, officialBash: false })
  await session.created()
  assert.deepEqual(session.restrictCalls, [])
  assert.deepEqual(session.denies, [])
  assert.equal(session.activeSections(PWSH_SECTION).length, 0)
  assert.equal(session.activeTools('bash').length, 0)
  assert.equal(session.guard('pwsh'), undefined)
  const posix = session.activeSections(REMOTE_POSIX_SECTION)[0]
  assert.ok(posix)
  assert.equal(typeof posix.text === 'function' ? posix.text() : posix.text, '')
  assert.deepEqual(await session.assemble(['pwsh', 'bash']), ['pwsh', 'bash'])
})

test('working-directory/change mounts, removes, and remounts the bash fallback', async () => {
  const session = surface({ headerCwd: localCwd, officialBash: false })
  await session.created()
  assert.equal(session.header.cwd, localCwd)
  assert.equal(session.activeTools('bash').length, 0)

  session.emit('working-directory/change', remoteCwd)
  assert.equal(session.header.cwd, localCwd)
  assert.equal(session.agent.session.header, session.header)
  assert.equal(session.activeTools('bash').length, 1)
  assert.deepEqual(session.denies, ['pwsh', 'powershell', 'cmd'])
  assert.equal(session.activeSections(PWSH_SECTION).length, 1)

  session.emit('working-directory/change', path.join(remoteCwd, 'src'))
  assert.equal(session.toolCount('bash'), 1)
  assert.equal(session.sectionCount(PWSH_SECTION), 1)

  session.emit('turn/start')
  assert.equal(session.activeTools('bash').length, 1)

  session.emit('working-directory/change', localCwd)
  assert.equal(session.header.cwd, localCwd)
  assert.equal(session.activeTools('bash').length, 0)
  assert.deepEqual(session.denies, [])
  assert.equal(session.activeSections(PWSH_SECTION).length, 0)
  assert.equal(session.guard('pwsh'), undefined)

  session.emit('working-directory/change', remoteCwd)
  assert.equal(session.activeTools('bash').length, 1)
  assert.deepEqual(session.denies, ['pwsh', 'powershell', 'cmd'])
  assert.equal(session.header.cwd, localCwd)
})

test('an official bash shadow stays after leaving and a local call uses it', async () => {
  const session = surface({ headerCwd: localCwd, officialBash: true })
  await session.created()
  session.emit('working-directory/change', remoteCwd)
  assert.equal(session.activeTools('bash').length, 1)
  session.emit('working-directory/change', localCwd)
  const bash = session.activeTools('bash')
  assert.equal(bash.length, 1)
  const result = await bash[0]!.execute({}, { agent: session.agent })
  assert.equal(result, 'official')
  assert.deepEqual(session.officialCalls, ['bash'])
})

test('the guard and prompt follow workingDirectory while the dynamic set follows the event', async () => {
  const session = surface({ headerCwd: localCwd, liveCwd: remoteCwd, officialBash: false })
  await session.created()
  assert.equal(session.header.cwd, localCwd)
  assert.equal(session.activeTools('bash').length, 1)
  assert.equal(session.guard('pwsh'), WINDOWS_SHELL_DENIED)

  session.live.current = localCwd
  assert.equal(session.guard('pwsh'), undefined)
  assert.equal(session.activeTools('bash').length, 1)
  const posix = session.activeSections(REMOTE_POSIX_SECTION)[0]
  assert.equal(typeof posix?.text === 'function' ? posix.text() : posix?.text, '')
  assert.deepEqual(await session.assemble(['pwsh', 'bash']), ['pwsh', 'bash'])
})

test('a directory service that throws falls back to the remote header', async () => {
  const session = surface({ headerCwd: remoteCwd, directory: 'throw', officialBash: false })
  await session.created()
  assert.equal(session.activeTools('bash').length, 1)
  assert.equal(session.guard('pwsh'), WINDOWS_SHELL_DENIED)
})

test('a failed leave drops the remote dynamic set instead of restoring it', async () => {
  const session = surface({ headerCwd: remoteCwd, officialBash: false, failSectionDispose: true })
  await session.created()
  session.emit('working-directory/change', localCwd)
  assert.equal(session.header.cwd, remoteCwd)
  assert.equal(session.activeTools('bash').length, 0)
  assert.equal(session.activeSections(PWSH_SECTION).length, 0)
  assert.deepEqual(session.denies, [])
  assert.equal(session.guard('pwsh'), undefined)
  assert.equal(session.warnings.some(warning => warning.includes('shell surface sync failed')), true)
  assert.equal(session.warnings.some(warning => warning.includes('section dispose failed')), true)

  session.emit('working-directory/change', remoteCwd)
  assert.equal(session.activeTools('bash').length, 1)
  assert.deepEqual(session.denies, ['pwsh', 'powershell', 'cmd'])
  assert.equal(session.activeSections(PWSH_SECTION).length, 1)
})

test('a later restrict failure is not swallowed and does not keep a partial deny', async () => {
  let closed = true
  const session = surface({
    headerCwd: localCwd,
    officialBash: false,
    restrictError: name => closed && name === 'powershell' ? new Error('tools registry is closed') : undefined,
  })
  await session.created()
  session.emit('working-directory/change', remoteCwd)
  assert.deepEqual(session.denies, [])
  assert.equal(session.activeSections(PWSH_SECTION).length, 0)
  assert.equal(session.activeTools('bash').length, 0)
  assert.equal(session.guard('pwsh'), WINDOWS_SHELL_DENIED)
  assert.deepEqual(await session.assemble(['pwsh', 'cmd', 'bash']), ['bash'])
  assert.equal(session.warnings.some(warning => warning.includes('tools registry is closed')), true)
  assert.equal(session.warnings.some(warning => warning.includes('No bash tool was registered')), true)
  assert.equal(session.warnings.some(warning => warning.includes('A later working-directory change retries')), true)

  closed = false
  session.emit('working-directory/change', remoteCwd)
  assert.equal(session.activeTools('bash').length, 1)
  assert.deepEqual(session.denies, ['pwsh', 'powershell', 'cmd'])
  assert.equal(session.activeSections(PWSH_SECTION).length, 1)
})

test('a later restrict failure leaves the official bash shadow in place', async () => {
  const session = surface({
    headerCwd: localCwd,
    officialBash: true,
    restrictError: name => name === 'cmd' ? new Error('tools registry is closed') : undefined,
  })
  await session.created()
  assert.equal(session.activeTools('bash').length, 1)
  session.emit('working-directory/change', remoteCwd)
  assert.equal(session.activeTools('bash').length, 1)
  assert.deepEqual(session.denies, [])
  assert.equal(session.warnings.some(warning => warning.includes('The preset bash tool is still registered.')), true)
  session.live.current = localCwd
  const result = await session.activeTools('bash')[0]!.execute({}, { agent: session.agent })
  assert.equal(result, 'official')
  assert.deepEqual(session.officialCalls, ['bash'])
})

test('a disposer failure during destroy still removes the permanent surface', async () => {
  const session = surface({ headerCwd: remoteCwd, officialBash: false, failSectionDispose: true })
  await session.created()
  assert.equal(session.activeGuards(), 1)
  for (const cleanup of session.cleanups) cleanup()
  assert.equal(session.activeTools('bash').length, 0)
  assert.equal(session.activeSections().length, 0)
  assert.equal(session.activeGuards(), 0)
  assert.deepEqual(session.denies, [])
  assert.equal(session.warnings.some(warning => warning.includes('shadow cleanup failed')), true)
  assert.equal(session.warnings.some(warning => warning.includes('section dispose failed')), true)
  await session.created()
  assert.equal(session.activeTools('bash').length, 1)
  assert.equal(session.activeGuards(), 1)
})

test('agent destroy and plugin unload can install the shell surface again', async () => {
  const session = surface({ headerCwd: remoteCwd, officialBash: false })
  await session.created()
  assert.equal(session.activeTools('bash').length, 1)
  for (const cleanup of session.cleanups) cleanup()
  assert.equal(session.activeTools('bash').length, 0)
  assert.equal(session.activeSections().length, 0)
  await session.created()
  assert.equal(session.activeTools('bash').length, 1)
  assert.equal(session.activeSections(PWSH_SECTION).length, 1)

  // The plugin effect that walks `unregisters` is the unload path. Later
  // effects belong to the host service and tear the context down; stopping
  // once the shell surface is gone keeps `agent/created` installed.
  for (const dispose of session.pluginDisposers) {
    dispose()
    if (session.activeTools('bash').length === 0 && session.activeSections().length === 0) break
  }
  assert.equal(session.activeTools('bash').length, 0)
  assert.deepEqual(session.denies, [])
  await session.created()
  assert.equal(session.activeTools('bash').length, 1)
  assert.deepEqual(session.denies, ['pwsh', 'powershell', 'cmd'])
})
