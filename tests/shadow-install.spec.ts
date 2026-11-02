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

function agentFor(cwd: string, register: (definition: { name: string }) => () => void, sessionId?: string) {
  const cleanups: Array<() => void> = []
  const agent = {
    session: { id: sessionId, header: { cwd } },
    ctx: {
      tools: {
        get: (_name?: string): { execute: () => Promise<unknown> } | undefined => ({ execute: async () => 'official' }),
        register,
        restrict: () => () => undefined,
        guard: () => () => undefined,
      },
      systemPrompt: {
        section: () => () => undefined,
        getSectionOrder: () => 1000,
        context: () => () => undefined,
        getContextOrder: () => 100,
      },
      on: () => () => undefined,
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

/**
 * A plugin whose registry owns `paths`; the guard reads it, nothing else does.
 * `liveCwd` seeds the working-directory service, which is what decides routing
 * for a session that moved away from its header directory.
 */
function pluginWithWorkspaces(paths: string[], liveCwd?: string): Context {
  const ctx = plugin()
  if (liveCwd !== undefined) ctx.provide('workingDirectory', { get: () => liveCwd })
  ctx.provide('workspaceRegistry', {
    list: () => paths.map((path, index) => ({
      id: `w${index}`,
      path,
      title: path,
      createdAt: '2026-01-01T00:00:00.000Z',
      sessionIds: [],
      setTitle: async () => undefined,
    })),
    create: async () => { throw new Error('not used') },
    delete: async () => true,
  })
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
  const workspace = tools.find(tool => tool.name === 'ssh_workspace')
  assert.equal(exec?.parameters.type, 'object')
  assert.deepEqual(exec?.parameters.required, ['host', 'command'])
  assert.equal(hosts?.parameters.type, 'object')
  assert.deepEqual(hosts?.parameters.properties, {})
  // Opening the new workspace starts a session on that host, so registration
  // uses the same escalation argument as ssh_exec and ssh_write.
  assert.deepEqual(workspace?.parameters.required, ['host', 'directory'])
  assert.deepEqual(Object.keys(workspace?.parameters.properties ?? {}).sort(), ['directory', 'host', 'justification', 'sandbox_permissions', 'title'])
  assert.deepEqual(workspace?.parameters.properties?.sandbox_permissions?.enum, ['danger-full-access'])
  // Only danger-full-access opens the ops approval card; narrower modes would
  // send the model into a retry that can never succeed.
  assert.deepEqual(exec?.parameters.properties?.sandbox_permissions?.enum, ['danger-full-access'])
  assert.deepEqual(write?.parameters.properties?.sandbox_permissions?.enum, ['danger-full-access'])
  await assert.rejects(async () => exec!.execute({}, {}), /invalid arguments/)
  await assert.rejects(async () => workspace!.execute({ host: 'lo' }, {}), /invalid arguments/)
})

test('a session that walks into a placeholder no workspace owns is refused', async () => {
  const ctx = pluginWithWorkspaces([], remoteCwd)
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  // A local session that moved its live directory into the placeholder.
  const { agent } = agentFor('/tmp/local-project', definition => {
    tools.push(definition as { name: string, execute: (args: unknown, exec: object) => Promise<unknown> })
    return () => undefined
  })
  await created(ctx, agent)
  const bash = tools.find(tool => tool.name === 'bash')
  await assert.rejects(
    () => bash!.execute({ command: 'id' }, { agent }),
    /not opened on that host/,
  )
})

test('a local session standing in a registered placeholder is refused', async () => {
  const ctx = pluginWithWorkspaces([remoteCwd], remoteCwd)
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  const { agent } = agentFor('/tmp/local-project', definition => {
    tools.push(definition as { name: string, execute: (args: unknown, exec: object) => Promise<unknown> })
    return () => undefined
  })
  await created(ctx, agent)
  const bash = tools.find(tool => tool.name === 'bash')
  const workingDirectory = tools.find(tool => tool.name === 'working_directory')
  const refused = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    assert.match(message, /not opened on that host/)
    assert.doesNotMatch(message, /ssh_workspace/)
    assert.doesNotMatch(message, /not configured/)
    assert.equal(message.includes(remoteCwd), false)
    return true
  }
  // The header is local. A registered placeholder is not enough, for the
  // current directory or for a cd out of it.
  await assert.rejects(() => bash!.execute({ command: 'id' }, { agent }), refused)
  for (const cd of ['/etc', 'src']) {
    await assert.rejects(() => workingDirectory!.execute({ cd }, { agent }), refused)
  }
})

test('a session already on the host may walk outside its workspace', async () => {
  const etc = mapRemoteToLocal('host1', '/etc')!
  const ctx = pluginWithWorkspaces([remoteCwd], etc)
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  // Header is the workspace itself, so the session is already on host1.
  const { agent } = agentFor(remoteCwd, definition => {
    tools.push(definition as { name: string, execute: (args: unknown, exec: object) => Promise<unknown> })
    return () => undefined
  })
  await created(ctx, agent)
  const bash = tools.find(tool => tool.name === 'bash')
  // Navigation on the same host is not the escalation the guard blocks; the
  // next failure is the deliberately missing host configuration.
  await assert.rejects(() => bash!.execute({ command: 'id' }, { agent }), /not configured/)
})

test('working_directory refuses to commit an unregistered placeholder', async () => {
  const ctx = pluginWithWorkspaces([])
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  let officialCalls = 0
  const { agent } = agentFor('/tmp/local-project', definition => {
    tools.push(definition as { name: string, execute: (args: unknown, exec: object) => Promise<unknown> })
    return () => undefined
  })
  // Capture the official tool before the shadows are installed.
  agent.ctx.tools.get = (name?: string) => name === 'working_directory' || name === 'bash'
    ? { execute: async () => { officialCalls += 1; return { cwd: '/tmp/local-project' } } }
    : undefined
  await created(ctx, agent)
  const workingDirectory = tools.find(tool => tool.name === 'working_directory')
  await assert.rejects(
    () => workingDirectory!.execute({ cd: remoteCwd }, { agent }),
    /not opened on that host/,
  )
  // The directory is never committed, so the session is not stranded inside it.
  assert.equal(officialCalls, 0)
})

test('a session opened on the host may cd outside its workspace', async () => {
  const ctx = pluginWithWorkspaces([remoteCwd], remoteCwd)
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  const { agent } = agentFor(remoteCwd, definition => {
    tools.push(definition as { name: string, execute: (args: unknown, exec: object) => Promise<unknown> })
    return () => undefined
  })
  await created(ctx, agent)
  const workingDirectory = tools.find(tool => tool.name === 'working_directory')
  await assert.rejects(() => workingDirectory!.execute({ cd: '/etc' }, { agent }), /not configured/)
})

test('working_directory refuses a local cd when the filesystem service is missing', async () => {
  const ctx = pluginWithWorkspaces([])
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  let officialCalls = 0
  const { agent } = agentFor('/tmp/local-project', definition => {
    tools.push(definition as { name: string, execute: (args: unknown, exec: object) => Promise<unknown> })
    return () => undefined
  })
  // The official tool would commit the placeholder. The missing service must
  // stop the call before that commit.
  agent.ctx.tools.get = (name?: string) => name === 'working_directory' || name === 'bash'
    ? { execute: async () => { officialCalls += 1; return { cwd: remoteCwd } } }
    : undefined
  await created(ctx, agent)
  const workingDirectory = tools.find(tool => tool.name === 'working_directory')
  await assert.rejects(
    () => workingDirectory!.execute({ cd: 'jump' }, { agent }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /filesystem service is unavailable/)
      assert.equal(message.includes(remoteCwd), false)
      return true
    },
  )
  assert.equal(officialCalls, 0)
})

test('working_directory still reaches the official tool for a placeholder the header already opened', async () => {
  const ctx = pluginWithWorkspaces([], '/tmp/local-project')
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  let officialCalls = 0
  const { agent } = agentFor(remoteCwd, definition => {
    tools.push(definition as { name: string, execute: (args: unknown, exec: object) => Promise<unknown> })
    return () => undefined
  })
  agent.ctx.tools.get = (name?: string) => name === 'working_directory' || name === 'bash'
    ? { execute: async () => { officialCalls += 1; return { cwd: remoteCwd } } }
    : undefined
  await created(ctx, agent)
  const workingDirectory = tools.find(tool => tool.name === 'working_directory')
  const committed = await workingDirectory!.execute({ cd: remoteCwd }, { agent })
  assert.deepEqual(committed, { cwd: remoteCwd })
  assert.equal(officialCalls, 1)
})

test('working_directory follows a symlink before accepting a local cd', async () => {
  const ctx = pluginWithWorkspaces([])
  ctx.provide('fs', {
    resolve: async () => ({ kind: 'followed' }),
    processPath: () => remoteCwd,
  })
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  let officialCalls = 0
  const { agent } = agentFor('/tmp/local-project', definition => {
    tools.push(definition as { name: string, execute: (args: unknown, exec: object) => Promise<unknown> })
    return () => undefined
  })
  agent.ctx.tools.get = (name?: string) => name === 'working_directory' || name === 'bash'
    ? { execute: async () => { officialCalls += 1; return { cwd: '/tmp/local-project' } } }
    : undefined
  await created(ctx, agent)
  const workingDirectory = tools.find(tool => tool.name === 'working_directory')
  await assert.rejects(
    () => workingDirectory!.execute({ cd: 'jump' }, { agent }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /not opened on that host/)
      assert.equal(message.includes(remoteCwd), false)
      return true
    },
  )
  assert.equal(officialCalls, 0)
})

test('working_directory refuses a symlink into a registered placeholder', async () => {
  const ctx = pluginWithWorkspaces([remoteCwd])
  ctx.provide('fs', {
    resolve: async () => ({ kind: 'followed' }),
    processPath: () => remoteCwd,
  })
  apply(ctx, { hosts: [], maxConnections: 4 })
  const tools: Array<{ name: string, execute: (args: unknown, exec: object) => Promise<unknown> }> = []
  let officialCalls = 0
  const { agent } = agentFor('/tmp/local-project', definition => {
    tools.push(definition as { name: string, execute: (args: unknown, exec: object) => Promise<unknown> })
    return () => undefined
  })
  agent.ctx.tools.get = (name?: string) => name === 'working_directory' || name === 'bash'
    ? { execute: async () => { officialCalls += 1; return { cwd: remoteCwd } } }
    : undefined
  await created(ctx, agent)
  const workingDirectory = tools.find(tool => tool.name === 'working_directory')
  await assert.rejects(
    () => workingDirectory!.execute({ cd: 'jump' }, { agent }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /not opened on that host/)
      assert.equal(message.includes(remoteCwd), false)
      return true
    },
  )
  assert.equal(officialCalls, 0)
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

test('working_directory output carries the remote directory as an optional field', async () => {
  const ctx = plugin()
  apply(ctx, { hosts: [], maxConnections: 4 })
  interface Captured {
    name: string
    output?: {
      schema?: { type?: string, additionalProperties?: boolean, required?: string[], properties?: Record<string, { description?: string }> }
      render?: (args: unknown, value: { cwd?: unknown, remote?: unknown }) => Array<{ type: string, text: string }>
    }
  }
  const tools: Captured[] = []
  const { agent } = agentFor(remoteCwd, () => () => undefined)
  agent.ctx.tools.register = ((definition: unknown) => {
    tools.push(definition as Captured)
    return () => undefined
  }) as typeof agent.ctx.tools.register
  await created(ctx, agent)

  const wd = tools.find(tool => tool.name === 'working_directory')
  assert.ok(wd?.output?.render)
  const render = wd!.output!.render!
  assert.equal(render({}, { cwd: 'C:/x', remote: '/srv/app' })[0]?.text, 'C:/x\n(remote: /srv/app)')
  assert.equal(render({}, { cwd: 'C:/x' })[0]?.text, 'C:/x')
  assert.deepEqual(wd!.output!.schema?.required, ['cwd'])
  // With no official output available, the fallback still describes `cwd` and
  // keeps the closed object shape; `remote` stays optional.
  assert.equal(wd!.output!.schema?.type, 'object')
  assert.equal(wd!.output!.schema?.additionalProperties, false)
  assert.equal(wd!.output!.schema?.properties?.cwd?.description, 'Current absolute working directory.')
  assert.ok(wd!.output!.schema?.properties?.remote)
})

test('working_directory merges remote into the real official schema, not a replacement', async () => {
  const ctx = plugin()
  apply(ctx, { hosts: [], maxConnections: 4 })
  interface Captured {
    name: string
    output?: {
      schema?: { type?: string, additionalProperties?: boolean, required?: string[], properties?: Record<string, { description?: string }> }
      render?: (args: unknown, value: { cwd?: unknown, remote?: unknown }) => Array<{ type: string, text: string }>
    }
  }
  const tools: Captured[] = []
  const { agent } = agentFor(remoteCwd, () => () => undefined)
  const official = {
    description: 'Read or change the calling Session working directory.',
    parameters: { type: 'object', properties: { cd: { type: 'string' } }, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { cwd: { type: 'string', description: 'Current absolute working directory.' } },
        required: ['cwd'],
      },
      render: () => [{ type: 'text', text: 'official' }],
    },
    execute: async () => 'official',
  }
  const baseGet = agent.ctx.tools.get
  agent.ctx.tools.get = ((name: string) => name === 'working_directory' ? official : baseGet()) as typeof agent.ctx.tools.get
  agent.ctx.tools.register = ((definition: unknown) => {
    tools.push(definition as Captured)
    return () => undefined
  }) as typeof agent.ctx.tools.register
  await created(ctx, agent)

  const schema = tools.find(tool => tool.name === 'working_directory')?.output?.schema
  assert.ok(schema)
  assert.equal(schema!.type, 'object')
  assert.equal(schema!.additionalProperties, false)
  // The official property and its description survive the merge.
  assert.equal(schema!.properties?.cwd?.description, 'Current absolute working directory.')
  assert.ok(schema!.properties?.remote)
  // `remote` is optional: required still lists only cwd.
  assert.deepEqual(schema!.required, ['cwd'])
})
