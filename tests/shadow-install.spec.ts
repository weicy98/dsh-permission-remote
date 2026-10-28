import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { mapRemoteToLocal } from '../src/router.ts'

const remoteCwd = mapRemoteToLocal('host1', '/srv/app')!

function settings() {
  return {
    configure: () => () => undefined,
    describe: () => [],
    update: async () => undefined,
  }
}

function agentFor(cwd: string, register: () => () => void) {
  const cleanups: Array<() => void> = []
  const agent = {
    session: { header: { cwd } },
    ctx: {
      tools: {
        get: () => ({ execute: async () => 'official' }),
        register,
      },
      get: () => undefined,
      effect: (execute: () => unknown) => {
        const dispose = execute()
        if (typeof dispose === 'function') cleanups.push(dispose as () => void)
      },
    },
  }
  return { agent, cleanups }
}

function plugin(): Context {
  const ctx = new Context()
  ctx.provide('settings', settings())
  return ctx
}

async function created(ctx: Context, agent: object): Promise<void> {
  const dispatch = ctx as unknown as { serial(name: string, payload: { agent: object }): Promise<void> }
  await dispatch.serial('agent/created', { agent })
}

test('a remote shadow install failure fails agent creation', async () => {
  const ctx = plugin()
  apply(ctx, { hosts: [], maxConnections: 4 })
  const { agent } = agentFor(remoteCwd, () => {
    throw new Error('register failed')
  })
  await assert.rejects(() => created(ctx, agent), /register failed/)
})

test('a local shadow install failure leaves the local tools in place', async () => {
  const ctx = plugin()
  apply(ctx, { hosts: [], maxConnections: 4 })
  const { agent } = agentFor('/tmp/not-a-remote-workspace', () => {
    throw new Error('register failed')
  })
  await created(ctx, agent)
})

test('ending the agent effect lets the same agent install again', async () => {
  const ctx = plugin()
  apply(ctx, { hosts: [], maxConnections: 4 })
  let registered = 0
  const { agent, cleanups } = agentFor(remoteCwd, () => {
    registered += 1
    return () => undefined
  })
  await created(ctx, agent)
  const first = registered
  assert.ok(first > 0)
  for (const cleanup of cleanups) cleanup()
  await created(ctx, agent)
  assert.equal(registered, first * 2)
})

test('ops tools publish object JSON Schemas and reject missing arguments', async () => {
  const ctx = plugin()
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, parameters: { type?: string, properties?: Record<string, { enum?: string[] }>, required?: string[] }, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  const { agent } = agentFor('/tmp/not-a-remote-workspace', () => () => undefined)
  agent.ctx.tools.register = ((definition: { name: string, parameters: { type?: string, properties?: Record<string, { enum?: string[] }>, required?: string[] }, execute: (args: unknown, exec: object) => Promise<unknown> }) => {
    tools.push(definition)
    return () => undefined
  }) as typeof agent.ctx.tools.register
  await created(ctx, agent)
  const exec = tools.find(tool => tool.name === 'ssh_exec')
  const write = tools.find(tool => tool.name === 'ssh_write')
  const hosts = tools.find(tool => tool.name === 'ssh_hosts')
  assert.equal(exec?.parameters.type, 'object')
  assert.deepEqual(exec?.parameters.required, ['host', 'command'])
  assert.equal(hosts?.parameters.type, 'object')
  assert.deepEqual(hosts?.parameters.properties, {})
  // Only danger-full-access opens the ops approval card; narrower modes would
  // send the model into a retry that can never succeed.
  assert.deepEqual(exec?.parameters.properties?.sandbox_permissions?.enum, ['danger-full-access'])
  assert.deepEqual(write?.parameters.properties?.sandbox_permissions?.enum, ['danger-full-access'])
  await assert.rejects(async () => exec!.execute({}, {}), /invalid arguments/)
})

test('terminal_open refuses on a remote workspace and still calls the local tool', async () => {
  const ctx = plugin()
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  const official: string[] = []
  const { agent } = agentFor(remoteCwd, () => () => undefined)
  const toolsApi = agent.ctx.tools as { get: (name: string) => { execute: () => Promise<string> } | undefined, register: typeof agent.ctx.tools.register }
  toolsApi.get = (name: string) => {
    if (name !== 'terminal_open' && name !== 'bash') return undefined
    return {
      execute: async () => {
        official.push(name)
        return 'official'
      },
    }
  }
  agent.ctx.tools.register = ((definition: { name: string, execute: (args: unknown, exec: object) => Promise<unknown> }) => {
    tools.push(definition)
    return () => undefined
  }) as typeof agent.ctx.tools.register
  await created(ctx, agent)

  const open = tools.find(tool => tool.name === 'terminal_open')
  assert.ok(open)
  await assert.rejects(() => open.execute({}, { agent }), /terminal_open is not available in a remote workspace/)
  assert.deepEqual(official, [])

  const local = await open.execute({}, { agent: { session: { header: { cwd: '/tmp/project' } } } })
  assert.equal(local, 'official')
  assert.deepEqual(official, ['terminal_open'])
})

test('an existing remote agent that cannot be shadowed fails plugin load', () => {
  const ctx = plugin()
  const { agent } = agentFor(remoteCwd, () => {
    throw new Error('register failed')
  })
  ctx.provide('agents', { list: () => [agent] })
  assert.throws(() => apply(ctx, { hosts: [], maxConnections: 4 }), /register failed/)
})
