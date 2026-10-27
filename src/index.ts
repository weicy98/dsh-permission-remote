import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
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
  runRead,
  runReadImage,
  runWrite,
  type RunnerStatus,
  type ToolExec,
  type ToolHost,
} from './execute.ts'
import { mapRemoteToLocal, routeByCwd } from './router.ts'
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

  async probe(input: { hostId: string }): Promise<RunnerStatus> {
    return this.core.probe(input.hostId)
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
    const local = mapRemoteToLocal(input.hostId, input.path)
    if (local === null) throw new Error('remote path must be absolute')
    await mkdir(local, { recursive: true })
    const title = input.title?.trim() || basename(input.path)
    await this.core.workspaces.create(local, title)
    return { path: local }
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

  update(config: PluginConfig): void {
    this.config = config
    this.status.clear()
  }

  hosts(): HostConfig[] {
    return this.config.hosts
  }

  requireHost(hostId: string): HostConfig {
    const host = this.config.hosts.find(item => item.id === hostId)
    if (host === undefined) throw new Error(`unknown SSH host ${hostId}`)
    return host
  }

  async trust(hostId: string, fingerprint: string): Promise<void> {
    this.requireHost(hostId)
    this.config = {
      ...this.config,
      hosts: this.config.hosts.map(item => item.id === hostId ? { ...item, fingerprint } : item),
    }
    this.pool.invalidate(hostId)
    this.status.delete(hostId)
    const row = this.ctx.settings.describe().find(item => String(item.ns) === 'permission-remote')
    if (row === undefined) return
    try {
      await this.ctx.settings.update(String(row.ns), { hosts: this.config.hosts })
    } catch (error) {
      this.ctx.logger?.warn(`[@dsh-permission-remote] fingerprint was trusted in this process but not saved: ${error instanceof Error ? error.message : String(error)}`)
    }
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

  probe(hostId: string): Promise<RunnerStatus> {
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

function isPayload(value: unknown): value is GrantPayload {
  return typeof value === 'object' && value !== null
}

function markRemote(service: SshApi): void {
  const methods = ['testConnection', 'trustFingerprint', 'probe', 'installDeps', 'listDir', 'createWorkspace', 'saveSecret']
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
  read: (host, route, args) => runRead(host, route, args),
  write: (host, route, args, exec) => runWrite(host, route, args, exec),
  edit: (host, route, args, exec) => runEdit(host, route, args, exec),
  read_image: (host, route, args, exec, ctx) => runReadImage(host, route, args, async (data, fileName) => {
    const attachments = ctx.get('attachments') as { saveImage(input: { data: Buffer, mediaType: string, name: string }): Promise<Record<string, unknown>> } | undefined
    if (attachments === undefined) throw new Error('no attachment service is mounted')
    const mediaType = mediaOf(fileName)
    return attachments.saveImage({ data, mediaType, name: fileName })
  }),
  glob: (host, route, args) => runGlob(host, route, args),
  grep: (host, route, args) => runGrep(host, route, args),
}

function mediaOf(fileName: string): string {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return 'application/octet-stream'
}

export function apply(rawCtx: Context, rawConfig?: unknown): void {
  const ctx = rawCtx as unknown as HostContext
  const core = new Core(ctx, readConfig(rawConfig), ctx.workspaceRegistry)
  const api = new SshApi(rawCtx, core)
  ctx.effect(() => ctx.settings.configure({ auto: false }))
  ctx.effect(() => () => {
    void core.pool.dispose()
  })
  void api

  ctx.on('agent/created', ({ agent }) => {
    try {
      const cwd = agent.session?.header?.cwd
      const route = routeByCwd(cwd)
      if (route.kind !== 'local') {
        const plans = planShadows(name => agent.ctx.tools.get(name, agent))
        const host = core.toolHost(agent.ctx.get('jobs') as ToolHost['jobs'])
        for (const plan of plans) {
          const official = plan.official
          const runner = RUNNERS[plan.name]
          agent.ctx.tools.register({
            ...capturedSchema(agent.ctx, plan.name, agent),
            name: plan.name,
            async execute(args: unknown, exec: ToolExec) {
              const current = routeByCwd(effectiveCwd(ctx, exec, cwd))
              return dispatchShadow(
                official as ((value: unknown, execution: ToolExec) => Promise<unknown>) | undefined,
                current.kind === 'remote',
                () => runner(host, current.kind === 'remote' ? current : route, args as Record<string, unknown>, exec, ctx),
                args,
                exec,
              )
            },
          })
        }
      }
    } catch (error) {
      ctx.logger?.warn(`[@dsh-permission-remote] agent/created failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  ctx.logger?.info('[@dsh-permission-remote] loaded')
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
      sandbox_permissions: { type: 'string', enum: ['workspace-write', 'danger-full-access'] },
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
