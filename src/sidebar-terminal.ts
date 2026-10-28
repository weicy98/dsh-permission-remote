/**
 * Sidebar terminals on a remote workspace.
 *
 * The web sidebar asks `terminalController` for shells and then
 * `subprocess.spawnTerminal` with `terminalType: "xterm-256color"` and
 * `shellActivity: true`. The persistent-terminal backend uses `"dumb"` and
 * stays on the local provider. Both services are cordis proxies, so the
 * replacement is installed on `symbols.original` and removed by deleting that own property.
 */
import { PassThrough, type Readable } from 'node:stream'
import { symbols } from '@deepseek-ai/cordis'
import type { HostConfig } from './config.ts'
import { routeByCwd, type RemoteRoute } from './router.ts'
import { shJoin, shQuote } from './shell-quote.ts'
import type { OpenPty, PtyChannel, PtyRequest, SecretMaterial } from './ssh-pool.ts'
import { hostTag } from './workspaces.ts'

export interface SidebarShell {
  readonly path: string
  readonly name: string
  readonly args: readonly string[]
}

export interface SidebarSpawnSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly rows: number
  readonly cols: number
  readonly terminalType: string
  readonly shellActivity?: boolean
  readonly signal?: AbortSignal
}

export interface SidebarCore {
  requireHost(hostId: string): HostConfig
  secret(host: HostConfig): Promise<SecretMaterial>
  pool: { openPty(host: HostConfig, secret: SecretMaterial, request: PtyRequest): Promise<OpenPty> }
  loadShells(hostId: string, candidates: readonly string[]): Promise<SidebarShell[]>
}

export interface BridgeContext {
  get(name: string): unknown
  logger?: { warn(message: string): void }
}

interface WorkingDirectoryService {
  get(session: object): string
}

interface ShellHost {
  config?: { shellCandidates?: readonly string[] }
  shells(agent: { session?: object }, signal: AbortSignal): Promise<SidebarShell[]>
  create(agent: { session?: object }, request: CreateRequest, signal: AbortSignal): Promise<unknown>
}

interface CreateRequest {
  shellPath?: string
  readonly [key: string]: unknown
}

interface SpawnHost {
  spawnTerminal(spec: SidebarSpawnSpec): Promise<unknown>
}

const WINDOWS_SHELLS = new Set(['cmd', 'powershell', 'pwsh'])
const LOGIN_SHELLS = new Set(['bash', 'zsh', 'fish'])

let nextPid = 1

/** Sidebar allocation, as opposed to the dumb PTY the persistent terminal opens. */
export function isSidebarTerminal(spec: { terminalType?: string, shellActivity?: boolean }): boolean {
  return spec.terminalType === 'xterm-256color' && spec.shellActivity === true
}

/** `cd` then replace the non-login `$SHELL -c` with the selected interactive shell. */
export function sidebarCommand(remoteCwd: string, argv: readonly string[]): string {
  return `cd ${shQuote(remoteCwd)} && exec ${shJoin(argv)}`
}

export function shellKind(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return base.toLowerCase().replace(/\.exe$/u, '')
}

export function shellArgs(kind: string): readonly string[] {
  if (WINDOWS_SHELLS.has(kind)) return []
  if (kind === 'sh' || kind === 'dash') return ['-i']
  if (LOGIN_SHELLS.has(kind)) return ['-l', '-i']
  return ['-i']
}

/** POSIX `command -v` probe. Windows candidate names are left out. */
export function shellProbeCommand(candidates: readonly string[]): string {
  const checks = candidates.filter(candidate => !WINDOWS_SHELLS.has(shellKind(candidate))).map(candidate => {
    const quoted = shQuote(candidate)
    return `p=$(command -v ${quoted} 2>/dev/null) || true; if [ -n "$p" ]; then printf 'HAVE %s\\n' "$p"; fi`
  })
  return [`printf 'SHELL %s\\n' "$SHELL"`, ...checks].join('; ')
}

/**
 * `$SHELL` wins, then each `command -v` hit. The same basename is listed once.
 * Paths that are not absolute are ignored: the sidebar stores the path it
 * will exec.
 */
export function parseShellProbe(text: string, label: string): SidebarShell[] {
  const shells: SidebarShell[] = []
  const seen = new Set<string>()
  const add = (path: string) => {
    if (!path.startsWith('/')) return
    const kind = shellKind(path)
    if (kind.length === 0 || WINDOWS_SHELLS.has(kind) || seen.has(kind)) return
    seen.add(kind)
    shells.push({ path, name: `${label} · ${kind}`, args: shellArgs(kind) })
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('SHELL ')) add(trimmed.slice('SHELL '.length).trim())
    else if (trimmed.startsWith('HAVE ')) add(trimmed.slice('HAVE '.length).trim())
  }
  return shells
}

export function installSidebarBridge(ctx: BridgeContext, core: SidebarCore): (() => void) | undefined {
  const terminalService = ctx.get('terminalController')
  const subprocessService = ctx.get('subprocess')
  const directoryService = ctx.get('workingDirectory')
  if (terminalService == null || subprocessService == null || directoryService == null) {
    ctx.logger?.warn('[@dsh-permission-remote] sidebar bridge is missing terminalController, subprocess, or workingDirectory')
    return undefined
  }
  const terminal = unwrap(terminalService) as ShellHost
  const subprocess = unwrap(subprocessService) as SpawnHost
  const directories = directoryService as WorkingDirectoryService
  if (Object.hasOwn(subprocess, 'spawnTerminal') || Object.hasOwn(terminal, 'shells') || Object.hasOwn(terminal, 'create')) {
    ctx.logger?.warn('[@dsh-permission-remote] sidebar bridge already installed')
    return undefined
  }
  const originalSpawn = subprocess.spawnTerminal.bind(subprocess)
  const originalShells = terminal.shells.bind(terminal)
  const originalCreate = terminal.create.bind(terminal)

  subprocess.spawnTerminal = async spec => {
    if (!isSidebarTerminal(spec)) return originalSpawn(spec)
    const route = routeByCwd(spec.cwd)
    if (route.kind !== 'remote') return originalSpawn(spec)
    return openRemoteTerminal(core, route, spec)
  }
  terminal.shells = async (agent, signal) => {
    signal.throwIfAborted()
    const route = sessionRoute(directories, agent)
    if (route === undefined) return originalShells(agent, signal)
    return core.loadShells(route.hostId, shellCandidatesOf(terminal))
  }
  terminal.create = async (agent, request, signal) => {
    const route = sessionRoute(directories, agent)
    if (route !== undefined && typeof request.shellPath === 'string' && request.shellPath.length > 0) {
      const shells = await terminal.shells(agent, signal)
      if (!shells.some(shell => shell.path === request.shellPath)) {
        const fallback = shells[0]
        if (fallback === undefined) throw new Error('no interactive shell found on the remote host')
        request = { ...request, shellPath: fallback.path }
      }
    }
    return originalCreate(agent, request, signal)
  }
  return () => {
    Reflect.deleteProperty(subprocess, 'spawnTerminal')
    Reflect.deleteProperty(terminal, 'shells')
    Reflect.deleteProperty(terminal, 'create')
  }
}

async function openRemoteTerminal(core: SidebarCore, route: RemoteRoute, spec: SidebarSpawnSpec): Promise<SshTerminalHandle> {
  if (spec.argv.length === 0) throw new Error('sidebar terminal is missing a shell')
  const host = core.requireHost(route.hostId)
  const opened = await core.pool.openPty(host, await core.secret(host), {
    command: sidebarCommand(route.remoteCwd, spec.argv),
    term: spec.terminalType,
    cols: spec.cols,
    rows: spec.rows,
    signal: spec.signal,
  })
  return new SshTerminalHandle(opened.channel, opened.onTransportClosed)
}

function sessionRoute(directories: WorkingDirectoryService, agent: { session?: object }): RemoteRoute | undefined {
  if (agent.session === undefined) return undefined
  let cwd: string
  try {
    cwd = directories.get(agent.session)
  } catch {
    return undefined
  }
  const route = routeByCwd(cwd)
  return route.kind === 'remote' ? route : undefined
}

function shellCandidatesOf(terminal: ShellHost): readonly string[] {
  const listed = terminal.config?.shellCandidates
  if (listed === undefined || listed.length === 0) return ['zsh', 'bash', 'fish', 'sh']
  return listed
}

function unwrap(service: object): object {
  const branded = service as { [symbols.original]?: object }
  return branded[symbols.original] ?? service
}

export interface TerminalExit {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

/**
 * One remote PTY. `terminate` closes the channel; OpenSSH does not deliver
 * `channel.signal`, and the session ends when the pty goes away (SIGHUP).
 * `output` is ended before `done` settles so the sidebar's `for await` can
 * observe the exit.
 */
export class SshTerminalHandle {
  readonly pid: number
  readonly output: PassThrough
  readonly done: Promise<TerminalExit>
  private settled = false
  private exitCode: number | null = null
  private exitSignal: NodeJS.Signals | null = null
  private revision = 0
  private readonly pending = new Set<Promise<unknown>>()
  /** Writes blocked on `drain`. A dead connection must release them or `terminate` never returns. */
  private readonly wakeups: Array<() => void> = []
  private stopTransport: () => void = () => undefined
  private resolveDone: (exit: TerminalExit) => void = () => undefined
  private rejectDone: (error: Error) => void = () => undefined

  constructor(private readonly channel: PtyChannel, onTransportClosed: OpenPty['onTransportClosed']) {
    this.pid = nextPid
    nextPid += 1
    this.output = new PassThrough()
    this.done = new Promise<TerminalExit>((resolve, reject) => {
      this.resolveDone = resolve
      this.rejectDone = reject
    })
    this.stopTransport = onTransportClosed(error => this.finish(error))
    channel.on('data', chunk => this.push(chunk))
    channel.stderr?.on('data', chunk => this.push(chunk))
    channel.on('close', (code, signal) => {
      this.exitCode = typeof code === 'number' ? code : null
      this.exitSignal = nodeSignal(signal)
      this.finish(null)
    })
  }

  write(data: string): Promise<void> {
    return this.track(new Promise((resolve, reject) => {
      if (this.settled) {
        reject(new Error('terminal is closed'))
        return
      }
      this.revision += 1
      let accepted = true
      try {
        accepted = this.channel.write(data)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (accepted !== false || this.channel.once === undefined) {
        resolve()
        return
      }
      let finished = false
      const settle = (error?: Error) => {
        if (finished) return
        finished = true
        if (error === undefined) resolve()
        else reject(error)
      }
      this.channel.once('drain', () => settle())
      this.wakeups.push(() => settle(new Error('terminal is closed')))
      // `write` can close the channel before the waiter is registered.
      if (this.settled) settle(new Error('terminal is closed'))
    }))
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.track(Promise.resolve().then(() => {
      if (this.settled) throw new Error('terminal is closed')
      this.revision += 1
      this.channel.setWindow(rows, cols, 0, 0)
    }))
  }

  inspectForeground(): Promise<undefined> {
    return Promise.resolve(undefined)
  }

  inspectActivity(): Promise<{ state: 'unknown', revision: number }> {
    return Promise.resolve({ state: 'unknown', revision: this.revision })
  }

  signalForeground(signal: string): Promise<number> {
    return this.track(Promise.resolve().then(() => {
      if (this.settled) throw new Error('terminal is closed')
      this.channel.signal(signal)
      return this.pid
    }))
  }

  async terminate(): Promise<void> {
    await Promise.allSettled([...this.pending])
    try {
      this.channel.close()
    } catch (error) {
      this.finish(error instanceof Error ? error : new Error(String(error)))
    }
    await this.done.then(() => undefined, () => undefined)
  }

  private push(chunk: Buffer | string): void {
    if (this.settled || this.output.writableEnded) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    this.output.write(bytes)
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    // `finally` re-rejects. Swallow that copy so a caller that handles `work` is the only observer.
    void work.finally(() => this.pending.delete(work)).catch(() => undefined)
    return work
  }

  /** End the screen stream first, then settle `done`, exactly once. */
  private finish(error: Error | null): void {
    if (this.settled) return
    this.settled = true
    this.stopTransport()
    if (!this.output.writableEnded) this.output.end()
    const wakeups = this.wakeups.splice(0)
    for (const wake of wakeups) wake()
    if (error === null) this.resolveDone({ exitCode: this.exitCode, signal: this.exitSignal })
    else this.rejectDone(error)
  }
}

function nodeSignal(signal: string | null | undefined): NodeJS.Signals | null {
  if (signal == null || signal.length === 0) return null
  const name = signal.startsWith('SIG') ? signal : `SIG${signal}`
  if (!/^SIG[A-Z0-9]+$/u.test(name)) return null
  return name as NodeJS.Signals
}

/** Readable side of the handle, kept as a named export for the consume-shaped test. */
export type TerminalOutput = Readable
