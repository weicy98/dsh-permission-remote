/**
 * Real DSH registry behavior the shell surface depends on.
 *
 * The hand-written agent in shell-install.spec.ts can be made to agree with
 * a wrong story about prompts. This file starts SystemPrompt and ToolRuntime,
 * mounts a preset scope the way an agent preset does, and runs `apply`.
 * No SSH server: the working directory is a fake and the pool is never dialed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf, scopeTarget, type Scope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import { mapRemoteToLocal } from '../src/router.ts'
import { isUnknownRestrictError } from '../src/shell-surface.ts'

const remoteCwd = mapRemoteToLocal('host1', '/srv/app')!
const localCwd = '/tmp/local-project'
const OFFICIAL_PWSH = 'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. On Windows a killed process settles as `[exit code: 1]` without a signal marker; treat a bare exit 1 after an interruption as a termination, not a command failure.'
const OFFICIAL_BASH = 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.'

interface HostAgent {
  session: { id: string, header: { cwd: string } }
  ctx: Context
}

function windowsShell(name: string) {
  return defineTool({
    name,
    description: `${name} shell`,
    parameters: {
      command: { type: 'string', description: 'Command', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
      },
      render: () => [{ type: 'text', text: '' }],
    },
    async execute() {
      return { text: name }
    },
  })
}

async function injected(scope: Scope): Promise<Context> {
  let ready: Context | undefined
  await scope.ctx.inject(['systemPrompt', 'tools'], (child: Context) => {
    ready = child
  })
  if (ready === undefined) throw new Error('scoped context did not start')
  return ready
}

async function boot() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    personaPrefix: '',
    personaSuffix: '',
  })
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body' })
  ctx.provide('settings', { configure: () => () => undefined, describe: () => [], update: async () => undefined })
  ctx.provide('workspaceRegistry', { list: () => [] })
  const directories = new Map<string, string>()
  ctx.provide('workingDirectory', {
    get(session: { id?: string, header?: { cwd?: string } }) {
      if (session.id !== undefined && directories.has(session.id)) return directories.get(session.id)
      return session.header?.cwd
    },
  })
  apply(ctx, { hosts: [], maxConnections: 4, tagWorkspaceTitles: false })

  const presetKey = {}
  const presetScope = createScope(ctx, presetKey)
  const scopes: Scope[] = [presetScope]
  // createScope's own fiber does not inject services. A child that lists
  // them inherits the scope tag, which is where a preset plugin registers.
  const preset = await injected(presetScope)
  assert.equal(scopeOf(preset), presetKey)
  preset.systemPrompt.section({
    name: 'tool:pwsh',
    order: preset.systemPrompt.getSectionOrder('TOOL_PWSH'),
    text: OFFICIAL_PWSH,
  })
  preset.systemPrompt.section({
    name: 'tool:bash',
    order: preset.systemPrompt.getSectionOrder('TOOL_BASH'),
    text: OFFICIAL_BASH,
  })

  async function makeAgent(id: string, cwd: string): Promise<HostAgent> {
    const agent = { session: { id, header: { cwd } } } as HostAgent
    const scope = createScope(ctx, agent, { parent: presetKey })
    scopes.push(scope)
    agent.ctx = await injected(scope)
    directories.set(id, cwd)
    assert.equal(scopeOf(agent.ctx), agent)
    return agent
  }

  async function created(agent: HostAgent): Promise<void> {
    const dispatch = ctx as unknown as { serial(name: string, payload: { agent: HostAgent }): Promise<void> }
    await dispatch.serial('agent/created', { agent })
  }

  function emitCwd(agent: HostAgent, cwd: string): void {
    directories.set(agent.session.id, cwd)
    const emit = ctx as unknown as { emit(thisArg: object, name: string, session: object, event: object): void }
    emit.emit(scopeTarget(agent.session, agent), 'session/event', agent.session, {
      type: 'working-directory/change',
      data: { cwd },
    })
  }

  async function rendered(agent: HostAgent): Promise<{ tools: string[], prompt: string }> {
    const assembly = await ctx.systemPrompt.assemble({ scope: agent })
    return {
      tools: assembly.tools.map(tool => tool.name),
      prompt: renderPrompt(assembly),
    }
  }

  return {
    ctx,
    preset,
    makeAgent,
    created,
    emitCwd,
    rendered,
    async close() {
      await Promise.all(scopes.map(scope => scope.dispose()))
    },
  }
}

test('hiding an ancestor pwsh does not blank the static tool:pwsh section', async () => {
  const host = await boot()
  try {
    host.preset.tools.register(windowsShell('pwsh'))
    const agent = await host.makeAgent('ancestor', remoteCwd)
    const other = await host.makeAgent('other', localCwd)
    const hide = agent.ctx.tools.restrict({ deny: ['pwsh'] })
    const hidden = await host.rendered(agent)
    assert.equal(hidden.tools.includes('pwsh'), false)
    assert.match(hidden.prompt, /On Windows a killed process settles/)
    hide()

    await host.created(agent)
    await host.created(other)
    const remote = await host.rendered(agent)
    assert.equal(remote.tools.includes('pwsh'), false)
    assert.equal(remote.tools.includes('bash'), true)
    assert.match(remote.prompt, /POSIX host/)
    assert.match(remote.prompt, /Check the \[exit code: N\] marker/)
    assert.doesNotMatch(remote.prompt, /On Windows a killed process settles/)
    assert.equal(agent.session.header.cwd, remoteCwd)

    const untouched = await host.rendered(other)
    assert.equal(untouched.tools.includes('pwsh'), true)
    assert.equal(untouched.tools.includes('bash'), false)
    assert.match(untouched.prompt, /On Windows a killed process settles/)

    host.emitCwd(agent, localCwd)
    assert.equal(agent.session.header.cwd, remoteCwd)
    const left = await host.rendered(agent)
    assert.equal(left.tools.includes('pwsh'), true)
    assert.equal(left.tools.includes('bash'), false)
    assert.match(left.prompt, /On Windows a killed process settles/)
    assert.doesNotMatch(left.prompt, /POSIX host/)
    const otherAfter = await host.rendered(other)
    assert.equal(otherAfter.tools.includes('bash'), false)

    host.emitCwd(agent, remoteCwd)
    const again = await host.rendered(agent)
    assert.equal(again.tools.includes('bash'), true)
    assert.equal(again.tools.includes('pwsh'), false)
    assert.doesNotMatch(again.prompt, /On Windows a killed process settles/)
    assert.equal((await host.rendered(other)).tools.includes('bash'), false)
  } finally {
    await host.close()
  }
})

test('a complete persona keeps the filtered tool list and drops every section', async () => {
  const host = await boot()
  try {
    host.preset.tools.register(windowsShell('pwsh'))
    host.preset.systemPrompt.section({
      name: 'persona:minimal',
      order: 0,
      complete: true,
      text: 'MINIMAL PERSONA',
    })
    const agent = await host.makeAgent('minimal', remoteCwd)
    await host.created(agent)
    const assembly = await host.ctx.systemPrompt.assemble({ scope: agent })
    assert.deepEqual(assembly.sections.map(section => section.name), ['persona:minimal'])
    assert.equal(renderPrompt(assembly), 'MINIMAL PERSONA')
    assert.equal(assembly.tools.some(tool => tool.name === 'pwsh'), false)
    assert.equal(assembly.tools.some(tool => tool.name === 'bash'), true)
  } finally {
    await host.close()
  }
})

test('ancestor pwsh leaves the PTC SDK and a scope-local pwsh stays in it', async () => {
  const host = await boot()
  try {
    host.preset.tools.register(windowsShell('pwsh'))
    const ancestor = await host.makeAgent('ancestor-ptc', remoteCwd)
    ancestor.ctx.tools.presentAs('ptc')
    await host.created(ancestor)
    const ancestorView = await host.rendered(ancestor)
    assert.deepEqual(ancestorView.tools, ['run_code'])
    assert.doesNotMatch(ancestorView.prompt, /\bpwsh:/)
    assert.match(ancestorView.prompt, /\bbash:/)
    assert.equal(host.ctx.tools.schemas(ancestor).some(tool => tool.name === 'pwsh'), false)

    // The ancestor name is restrictable, so restrict succeeds and still
    // cannot hide the copy registered on the agent itself.
    const overlaid = await host.makeAgent('overlaid-ptc', remoteCwd)
    overlaid.ctx.tools.register(windowsShell('pwsh'))
    overlaid.ctx.tools.presentAs('ptc')
    await host.created(overlaid)
    const overlaidView = await host.rendered(overlaid)
    assert.deepEqual(overlaidView.tools, ['run_code'])
    assert.match(overlaidView.prompt, /\bpwsh:/)
    assert.equal(host.ctx.tools.schemas(overlaid).some(tool => tool.name === 'pwsh'), true)
  } finally {
    await host.close()
  }

  const isolated = await boot()
  try {
    const local = await isolated.makeAgent('local-ptc', remoteCwd)
    local.ctx.tools.register(windowsShell('pwsh'))
    local.ctx.tools.presentAs('ptc')
    assert.equal(isUnknownRestrictError(thrownDeny(local, 'pwsh')), true)
    await isolated.created(local)
    const localView = await isolated.rendered(local)
    assert.deepEqual(localView.tools, ['run_code'])
    assert.match(localView.prompt, /\bpwsh:/)
    assert.equal(isUnknownRestrictError(thrownRestrict(isolated.ctx)), false)
    const reserved = thrownDeny(local, 'run_code')
    assert.equal(isUnknownRestrictError(reserved), false)
    assert.match(reserved instanceof Error ? reserved.message : '', /reserved PTC mode/)
  } finally {
    await isolated.close()
  }
})

function thrownRestrict(scope: { tools: { restrict(filter: { deny: readonly string[] }): () => void } }): unknown {
  try {
    scope.tools.restrict({ deny: ['pwsh'] })
    return undefined
  } catch (error) {
    return error
  }
}

function thrownDeny(agent: HostAgent, name: string): unknown {
  try {
    agent.ctx.tools.restrict({ deny: [name] })
    return undefined
  } catch (error) {
    return error
  }
}
