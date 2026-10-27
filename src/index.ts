import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { ESCALATION_TARGETS } from '@deepseek-ai/dsh-sandbox'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials/types'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { Config, readConfig, type HostConfig, type PluginConfig } from './config.ts'
import {
  buildResolveMode,
  installBubblewrap,
  probeHost,
  runBash,
  runEdit,
  runGlob,
  runGrep,
  runWorkingDirectory,
  runRead,
  runReadImage,
  runWrite,
  type RunnerStatus,
  type ToolExec,
  type ToolHost,
} from './execute.ts'
import { sniffImage } from './image.ts'
import { isValidHostId, mapRemoteToLocal, routeByCwd } from './router.ts'
import { dispatchShadow, planShadows, type RoutedToolName } from './shadow.ts'
import { SshPool, type SecretMaterial } from './ssh-pool.ts'

export const name = 'dsh-permission-remote'
export const inject = ['sandboxPolicy', 'tools', 'settings', 'credentials', 'workspaceRegistry']
export { Config }

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

interface HostContext {
  sandboxPolicy: Parameters<typeof buildResolveMode>[0]['sandboxPolicy']
  tools: {
    get(toolName: string, scope?: object): { execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
    register(definition: object): () => void
  }
  settings: {
    configure(presentation: { auto?: boolean }): () => void
    describe(): Array<{ ns: string }>
    update(ns: string, patch: object): Promise<void>
  }
  credentials: {
    readRecord(key: ReturnType<typeof credentialKey>): Promise<CredentialRecord | undefined>
    modifyRecord(key: ReturnType<typeof credentialKey>, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined>
  }
  workspaceRegistry: { create(dir: string, title?: string): Promise<unknown> }
  get(service: string): unknown
  on(event: 'agent/created', listener: (payload: { agent: AgentLike }) => void): () => void
  effect(dispose: () => void): void
  logger?: { info(message: string): void, warn(message: string): void }
}

interface AgentLike {
  ctx: HostContext & { tools: HostContext['tools'] }
  session?: { header?: { cwd?: string }, id?: string }
}

interface GrantPayload {
  password?: string
  passphrase?: string
}

class SshApi extends TypertRemoteService {
  constructor(ctx: Context, private readonly core: Core) {
    super(ctx, 'sshPermission')
    markRemote(this)
  }

  async testConnection(input: { hostId: string }): Promise<{ fingerprint: string, trusted: boolean, banner: string }> {
    const host = this.core.requireHost(input.hostId)
    return this.core.pool.offerFingerprint(host, await this.core.secret(host))
  }

  async trustFingerprint(input: { hostId: string, fingerprint: string }): Promise<{ ok: true }> {
    await this.core.trust(input.hostId, input.fingerprint)
    return { ok: true }
  }

  async probe(input: { hostId: string, refresh?: boolean }): Promise<RunnerStatus> {
    return this.core.probe(input.hostId, input.refresh === true)
  }

  async installDeps(input: { hostId: string }): Promise<{ code: number | null, stdout: string, stderr: string, status: RunnerStatus }> {
    const host = this.core.requireHost(input.hostId)
    const status = await this.core.probe(input.hostId)
    const result = await installBubblewrap(this.core.pool, host, await this.core.secret(host), status)
    this.core.forgetStatus(input.hostId)
    const next = await this.core.probe(input.hostId)
    return { code: result.code, stdout: result.stdout, stderr: result.stderr, status: next }
  }

  async listDir(input: { hostId: string, path: string }): Promise<{ path: string, entries: Array<{ name: string, path: string }> }> {
    const host = this.core.requireHost(input.hostId)
    const entries = await this.core.pool.sftpList(host, await this.core.secret(host), input.path || '/')
    return { path: input.path || '/', entries }
  }

  async createWorkspace(input: { hostId: string, path: string, title?: string }): Promise<{ path: string }> {
    const host = this.core.requireHost(input.hostId)
    await this.core.pool.sftpRealpath(host, await this.core.secret(host), input.path)
    const local = mapRemoteToLocal(input.hostId, input.path)
    if (local === null) throw new Error('remote path must be absolute')
    await mkdir(local, { recursive: true })
    const title = input.title?.trim() || basename(input.path)
    await this.core.workspaces.create(local, title)
    return { path: local }
  }

  async saveHost(input: HostConfig): Promise<{ ok: true }> {
    await this.core.saveHost(input)
    return { ok: true }
  }

  async deleteHost(input: { hostId: string }): Promise<{ ok: true }> {
    await this.core.deleteHost(input.hostId)
    return { ok: true }
  }

  async saveSecret(input: { hostId: string, password?: string, passphrase?: string }): Promise<{ ok: true }> {
    await this.core.saveSecret(input.hostId, { password: input.password, passphrase: input.passphrase })
    return { ok: true }
  }
}

class Core {
  readonly pool: SshPool
  private config: PluginConfig
  private readonly status = new Map<string, Promise<RunnerStatus>>()

  constructor(
    private readonly ctx: HostContext,
    config: PluginConfig,
    readonly workspaces: HostContext['workspaceRegistry'],
  ) {
    this.config = config
    this.pool = new SshPool(config.maxConnections)
  }

  requireHost(hostId: string): HostConfig {
    const host = this.config.hosts.find(item => item.id === hostId)
    if (host === undefined) throw new Error(`unknown SSH host ${hostId}`)
    return host
  }

  async trust(hostId: string, fingerprint: string): Promise<void> {
    this.requireHost(hostId)
    this.config.hosts = this.config.hosts.map(item => item.id === hostId ? { ...item, fingerprint } : item)
    this.pool.invalidate(hostId)
    this.status.delete(hostId)
    await this.persistHosts()
  }

  forgetStatus(hostId: string): void {
    this.status.delete(hostId)
    this.pool.invalidate(hostId)
  }

  async secret(host: HostConfig): Promise<SecretMaterial> {
    const record = await this.ctx.credentials.readRecord(credentialKey('dsh-permission-remote', host.id))
    if (record === undefined || record.kind !== 'grant' || !isPayload(record.payload)) return {}
    return { password: record.payload.password, passphrase: record.payload.passphrase }
  }

  async saveSecret(hostId: string, material: SecretMaterial): Promise<void> {
    assertHostId(hostId)
    this.requireHost(hostId)
    const key = credentialKey('dsh-permission-remote', hostId)
    await this.ctx.credentials.modifyRecord(key, async current => {
      const previous = current?.kind === 'grant' && isPayload(current.payload) ? current.payload : {}
      return {
        kind: 'grant',
        payload: {
          password: material.password !== undefined ? material.password : previous.password,
          passphrase: material.passphrase !== undefined ? material.passphrase : previous.passphrase,
        },
      }
    })
  }

  async saveHost(host: HostConfig): Promise<void> {
    assertHostId(host.id)
    const hosts = this.config.hosts.filter(item => item.id !== host.id)
    this.config.hosts = [...hosts, host]
    await this.persistHosts()
  }

  async deleteHost(hostId: string): Promise<void> {
    this.config.hosts = this.config.hosts.filter(item => item.id !== hostId)
    this.pool.invalidate(hostId)
    this.status.delete(hostId)
    await this.persistHosts()
  }

  private async persistHosts(): Promise<void> {
    const row = this.ctx.settings.describe().find(item => String(item.ns) === 'permission-remote')
    if (row === undefined) return
    await this.ctx.settings.update(String(row.ns), { hosts: this.config.hosts })
  }

  probe(hostId: string, refresh = false): Promise<RunnerStatus> {
    if (refresh) this.status.delete(hostId)
    const cached = this.status.get(hostId)
    if (cached !== undefined) return cached
    const pending = (async () => {
      const host = this.requireHost(hostId)
      return probeHost(this.pool, host, await this.secret(host))
    })()
    this.status.set(hostId, pending)
    pending.catch(() => {
      if (this.status.get(hostId) === pending) this.status.delete(hostId)
    })
    return pending
  }

  toolHost(jobs: ToolHost['jobs']): ToolHost {
    return {
      pool: this.pool,
      hostOf: id => this.config.hosts.find(item => item.id === id),
      secretOf: host => this.secret(host),
      statusOf: host => this.probe(host.id),
      resolveMode: buildResolveMode(this.ctx),
      jobs,
    }
  }
}

function assertHostId(hostId: string): void {
  if (!isValidHostId(hostId)) throw new Error('host id must be a lowercase credential key: it starts with a letter and contains only letters, digits, and hyphens')
}

function isPayload(value: unknown): value is GrantPayload {
  return typeof value === 'object' && value !== null
}

function markRemote(service: SshApi): void {
  const methods = ['testConnection', 'trustFingerprint', 'probe', 'installDeps', 'listDir', 'createWorkspace', 'saveSecret', 'saveHost', 'deleteHost']
  Object.defineProperty(Object.getPrototypeOf(service), REMOTE_METHODS, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map(method => Object.freeze({
        method,
        invocation: Object.freeze({ kind: 'direct' }),
      }))),
    }),
  })
}

const RUNNERS: Record<RoutedToolName, (host: ToolHost, route: NonNullable<ReturnType<typeof routeByCwd> & { kind: 'remote' }>, args: Record<string, unknown>, exec: ToolExec, ctx: HostContext) => Promise<unknown>> = {
  bash: (host, route, args, exec) => runBash(host, route, args, exec),
  read: (host, route, args, exec) => runRead(host, route, args, exec),
  write: (host, route, args, exec) => runWrite(host, route, args, exec),
  edit: (host, route, args, exec) => runEdit(host, route, args, exec),
  read_image: (host, route, args, exec, ctx) => runReadImage(host, route, args, async (data, fileName) => {
    const attachments = ctx.get('attachments') as { saveImage(input: { data: Buffer, mediaType: string, name: string }): Promise<Record<string, unknown>> } | undefined
    if (attachments === undefined) throw new Error('no attachment service is mounted')
    const mediaType = sniffImage(data)
    if (mediaType === undefined) throw new Error(`cannot read "${fileName}": the file content is not a PNG, JPEG, WebP, or GIF`)
    return attachments.saveImage({ data, mediaType, name: fileName })
  }, exec),
  glob: (host, route, args, exec) => runGlob(host, route, args, exec),
  grep: (host, route, args, exec) => runGrep(host, route, args, exec),
  working_directory: (host, route, args, exec, ctx) => runWorkingDirectory(host, route, args, exec, async directory => {
    const directories = ctx.get('workingDirectory') as { set(agent: object, path: string, signal?: AbortSignal): Promise<string> } | undefined
    if (directories === undefined || exec.agent === undefined) throw new Error('working_directory requires an agent Session')
    return directories.set(exec.agent, directory, exec.signal)
  }),
}

export function apply(rawCtx: Context, rawConfig?: unknown): void {
  const ctx = rawCtx as unknown as HostContext
  const core = new Core(ctx, readConfig(rawConfig), ctx.workspaceRegistry)
  const api = new SshApi(rawCtx, core)
  const unregisters = new Set<() => void>()
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  ctx.effect(() => () => {
    for (const unregister of unregisters) unregister()
    unregisters.clear()
    void core.pool.dispose()
  })
  void api

  ctx.on('agent/created', ({ agent }) => {
    const cwd = agent.session?.header?.cwd
    const initial = routeByCwd(cwd)
    const plans = planShadows(name => agent.ctx.tools.get(name, agent))
    const host = core.toolHost(agent.ctx.get('jobs') as ToolHost['jobs'])
    const disposers: Array<() => void> = []
    for (const plan of plans) {
      if (plan.official === undefined && !(plan.name === 'bash' && initial.kind === 'remote')) continue
      const official = plan.official
      const runner = RUNNERS[plan.name]
      const unregister = agent.ctx.tools.register(withRemoteTimeout({
        ...capturedSchema(agent.ctx, plan.name, agent),
        name: plan.name,
        async execute(args: unknown, exec: ToolExec) {
          const current = routeByCwd(effectiveCwd(ctx, exec, cwd))
          if (current.kind !== 'remote') {
            return dispatchShadow(official as ((value: unknown, execution: ToolExec) => Promise<unknown>) | undefined, false, async () => {
              throw new Error('dsh-permission-remote: local call has no official tool')
            }, args, exec)
          }
          return runner(host, current, args as Record<string, unknown>, exec, ctx)
        },
      }))
      disposers.push(unregister)
    }
    const drop = () => {
      for (const unregister of disposers) unregister()
    }
    unregisters.add(drop)
    agent.ctx.effect(() => () => {
      drop()
      unregisters.delete(drop)
    })
  })
  ctx.logger?.info('[@dsh-permission-remote] loaded')
}

function withRemoteTimeout(definition: object): object {
  const parameters = (definition as { parameters?: Record<string, { description?: string }> }).parameters
  if (parameters?.timeoutMs === undefined) return definition
  return {
    ...definition,
    parameters: {
      ...parameters,
      timeoutMs: {
        ...parameters.timeoutMs,
        description: 'Timeout in milliseconds. When it expires this remote command is killed. Without a sandbox runner, child processes of the command may keep running on the remote host.',
      },
    },
  }
}

function effectiveCwd(ctx: HostContext, exec: ToolExec, fallback: string | undefined): string | undefined {
  const directories = ctx.get('workingDirectory') as { get(session: object): string } | undefined
  const session = exec.agent?.session
  if (directories !== undefined && session !== undefined) {
    try {
      return directories.get(session)
    } catch {
      // A session without a recorded directory falls through to the header.
    }
  }
  return session?.header?.cwd ?? fallback
}

function capturedSchema(ctx: HostContext, toolName: string, agent: object): object {
  const official = ctx.tools.get(toolName, agent)
  if (official === undefined) return fallbackSchema(toolName)
  const { execute: _execute, ...rest } = official as object & { execute?: unknown }
  return rest
}

function fallbackSchema(toolName: string): object {
  if (toolName !== 'bash') return { description: toolName, parameters: {}, output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '' }] } }
  return {
    description: 'Execute a bash command on the remote workspace.',
    parameters: {
      command: { type: 'string', required: true },
      description: { type: 'string', required: true },
      timeoutMs: { type: 'number' },
      workdir: { type: 'string' },
      run_in_background: { type: 'boolean' },
      sandbox_permissions: { type: 'string', enum: [...ESCALATION_TARGETS] },
      justification: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args: unknown, value: { kind?: string, stdout?: { text?: string }, stderr?: { text?: string }, exitCode?: number | null }) => [{
        type: 'text',
        text: value.kind === 'background' ? 'started background job' : `${value.stdout?.text ?? ''}${value.stderr?.text ?? ''}\n[exit code: ${value.exitCode ?? 'null'}]`,
      }],
    },
  }
}
