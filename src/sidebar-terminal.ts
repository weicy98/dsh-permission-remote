/**
 * Remote terminals.
 *
 * The web sidebar asks `terminalController` for shells and then
 * `subprocess.spawnTerminal` with `terminalType: "xterm-256color"` and
 * `shellActivity: true`. The model persistent terminal asks for a fully
 * specified argv and environment, usually with `terminalType: "dumb"`. A
 * placeholder cwd means either one runs on the SSH host. One `spawnTerminal`
 * wrapper routes them. The sidebar's shell menu stays on `terminalController`.
 * Both services are cordis proxies, so a replacement is installed on
 * `symbols.original` and removed by deleting that own property.
 */
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { PassThrough, type Readable } from 'node:stream'
import { symbols } from '@deepseek-ai/cordis'
import type { HostConfig } from './config.ts'
import { routeByCwd, type RemoteRoute } from './router.ts'
import { rememberTerminalHistory, runRemoteTerminal } from './terminal-remote-state.ts'
import { shJoin, shQuote } from './shell-quote.ts'
import type { ExecResult, OpenPty, PtyChannel, PtyRequest, SecretMaterial } from './ssh-pool.ts'
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
  /** Explicit environment for the spawned shell. The sidebar bridge forwards it into the remote command. */
  readonly env?: Readonly<Record<string, string>>
  /** TERM-to-KILL grace for a model terminal. The sidebar closes the channel. */
  readonly graceMs?: number
}

export interface TerminalSpawnCore {
  requireHost(hostId: string): HostConfig
  secret(host: HostConfig): Promise<SecretMaterial>
  /**
   * Whether the session that asked for this PTY was opened on the host.
   * `spawnTerminal` has no other session identity: the official terminal
   * services pass the agent/session id in `spec.env.DSH_SESSION_ID`.
   */
  allowsRemoteSession?(sessionId: string, hostId: string): boolean
  pool: {
    openPty(host: HostConfig, secret: SecretMaterial, request: PtyRequest): Promise<OpenPty>
    exec(host: HostConfig, secret: SecretMaterial, command: string, timeoutMs: number, signal?: AbortSignal): Promise<Pick<ExecResult, 'code' | 'stdout'> & { stderr?: string }>
    /** One long-lived probe shell. Absent pools keep a fresh exec per probe. */
    openEval?(host: HostConfig, secret: SecretMaterial, command: string, signal?: AbortSignal): Promise<ProbeStream>
  }
}

export interface SidebarCore extends TerminalSpawnCore {
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
  /**
   * Official `create` calls this before `spawnTerminal`. `workingDirectory.ensure`
   * runs inside it, so a missing placeholder has to be created here.
   */
  spawn?(agent: { session?: object }, owner: unknown, request: CreateRequest, signal: AbortSignal): Promise<unknown>
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

/** Shell-safe `env KEY='value' ...` prefix, or an empty string. */
function environmentPrefix(env: Readonly<Record<string, string>> | undefined): string {
  const assignments = Object.entries(env ?? {}).map(([key, value]) => {
    if (!ENV_NAME.test(key)) throw new Error(`refusing terminal environment name ${key}`)
    return `${key}=${shQuote(value)}`
  })
  return assignments.length > 0 ? `env ${assignments.join(' ')} ` : ''
}

/**
 * Point a confined bwrap terminal argv at the directory the command will
 * `cd` into.
 *
 * The generic `sandbox.confine` branch only knows `policy.workspaceRoot`, which
 * is the Session workspace root — not `terminal_open`'s requested subdirectory.
 * It therefore leaves `--chdir` out. Bubblewrap without `--chdir` silently
 * starts in `$HOME` (or `/`) when the inherited cwd is shadowed by
 * `--tmpfs /tmp` and not bound back, so the terminal path adds the real cwd
 * here, after routing, where it is known.
 *
 * `seatbelt` keeps its external `cd` (it inherits the calling directory); a
 * `danger-full-access` argv is a bare shell and is left untouched.
 */
export function confineTerminalCwd(argv: readonly string[], remoteCwd: string): readonly string[] {
  if (argv[0] !== 'bwrap') return argv
  const separator = argv.indexOf('--')
  if (separator < 0) return argv
  const at = argv.lastIndexOf('--chdir', separator)
  const out = [...argv]
  if (at >= 0 && at + 1 < separator) out[at + 1] = remoteCwd
  else out.splice(separator, 0, '--chdir', remoteCwd)
  return out
}

/**
 * `cd` then replace the non-login `$SHELL -c` with the selected interactive
 * shell. The whole line runs through POSIX `sh`, because sshd runs a PTY
 * command with the user's *login* shell (csh/fish would reject this syntax).
 */
export function sidebarCommand(remoteCwd: string, argv: readonly string[], env?: Readonly<Record<string, string>>): string {
  const inner = `cd ${shQuote(remoteCwd)} && exec ${environmentPrefix(env)}${shJoin(argv)}`
  return `sh -c ${shQuote(inner)}`
}

const PTY_ID = /^[a-f0-9]{16}$/u
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
/** Shell exit status for the SIGKILL-of-shell guard; distinct from probe errors. */
const SIGKILL_REFUSED_CODE = 42
const TERMINAL_SIGNAL = /^(?:SIGINT|SIGTERM|SIGKILL|SIGTSTP|SIGHUP)$/u
const PROBE_MARK = /^DSHPROBE[a-f0-9]{16}$/u
const PTY_DIR = '"$HOME"/.dsh-permission-remote/pty'

function assertPtyId(id: string): void {
  if (!PTY_ID.test(id)) throw new Error('terminal pid file id is not a 16-digit hex string')
}

function ptyFile(id: string): string {
  assertPtyId(id)
  return `${PTY_DIR}/${id}.pid`
}

/**
 * Model terminal command. The pid file is written before `exec`, so the
 * process id stays the id of whatever argv replaces the shell. The second
 * line is `ps -o lstart=`: exec does not change it, and a later probe refuses
 * the file when the live process no longer has that start time. `$HOME` is
 * expanded by the remote shell on both the PTY and the later probe.
 */
export function modelTerminalCommand(remoteCwd: string, argv: readonly string[], env: Readonly<Record<string, string>> | undefined, id: string): string {
  if (argv.length === 0) throw new Error('terminal is missing a command')
  const prefix = environmentPrefix(env)
  const file = ptyFile(id)
  const record = `pid=$$; started=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'); [ -n "$started" ] || exit 1; printf '%s\\n' "$pid" "$started" > ${file}`
  // `cd ... || exit 1` matters: the old `cd ... && ... && pid=$$; started=...`
  // parsed as two lists, so a missing remote directory skipped the pid write
  // but still ran the `ps` probe with an empty pid, hiding the real cause.
  // `sh -c` keeps the POSIX syntax independent of the login shell.
  const inner = `cd ${shQuote(remoteCwd)} || exit 1; mkdir -p -- ${PTY_DIR} || exit 1; ${record}; exec ${prefix}${shJoin(argv)}`
  return `sh -c ${shQuote(inner)}`
}

/**
 * Load the pid file and stop unless that pid is still the process that wrote
 * it. A reused pid has a different `lstart` and must not be signalled.
 */
function recordedProcess(file: string): string {
  return `rec=$(cat ${file} 2>/dev/null) || exit 1; pid=$(printf '%s\\n' "$rec" | head -n 1); started=$(printf '%s\\n' "$rec" | tail -n +2); [ -n "$pid" ] && [ "$started" != "$pid" ] || exit 1; now=$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'); [ -n "$now" ] && [ "$now" = "$started" ] || exit 1`
}

/**
 * Read the host-visible foreground process group.
 * A missing process, a stale pid file, or a tpgid that is not a positive
 * integer stays a failure so the official backend can fall back to silence.
 */
export function foregroundProbeCommand(id: string): string {
  return `${recordedProcess(ptyFile(id))}; tpgid=$(ps -o tpgid= -p "$pid" | tr -d '[:space:]'); case $tpgid in ''|0|*[!0-9]*) exit 1 ;; esac; printf '%s\\n' "$tpgid"`
}

/**
 * Signal the host-visible foreground group.
 *
 * `ps` reports `-1` or `0` when the recorded process has no controlling
 * terminal. Those values are not process groups: `kill -- -1` is rejected
 * and `kill -- -0` signals the probe's own group. Fall back to the recorded
 * pid, which is the host-visible leader (the shell, or bwrap after exec).
 * A missed `kill` still prints that id and exits 0: the group may already
 * have exited, and the official interrupt treats a thrown probe as a dead
 * transport and would close the session. A stale pid file still exits
 * before any `kill`. `channel.signal` is not used: OpenSSH does not deliver it.
 */
export function signalProbeCommand(id: string, signal: string): string {
  if (!TERMINAL_SIGNAL.test(signal)) throw new Error(`refusing terminal signal ${signal}`)
  // dash's builtin `kill` rejects `-s SIGTERM` (only `TERM`); strip the prefix
  // so the command works under sh, bash, and zsh alike.
  const killName = signal.slice('SIG'.length)
  // The official local provider refuses SIGKILL when the foreground group is
  // the shell itself. After a tpgid fallback the target is a real PGID, so
  // comparing it with the recorded pid only refuses when the shell leads the
  // group it would kill; a foreground child has its own PGID and is allowed.
  const guard = signal === 'SIGKILL'
    ? ` if [ "$target" = "$pid" ]; then printf '%s\\n' 'refusing to SIGKILL the terminal shell; terminate the terminal session instead' >&2; exit ${SIGKILL_REFUSED_CODE}; fi;`
    : ''
  // A missed SIGINT is the common "foreground command already exited" case:
  // the official interrupt treats a thrown probe as a dead transport, so it
  // still reports the target. Every other signal fails loudly so
  // `terminal_signal` never claims a delivery that did not happen.
  const onMiss = signal === 'SIGINT'
    ? ` || { printf '%s\\n' "$target"; exit 0; }`
    : ' || exit 1'
  return `${recordedProcess(ptyFile(id))}; target=$(ps -o tpgid= -p "$pid" | tr -d '[:space:]'); case $target in ''|0|*[!0-9]*) target=$(ps -o pgid= -p "$pid" | tr -d '[:space:]') ;; esac; case $target in ''|0|*[!0-9]*) target=$pid ;; esac;${guard} kill -s ${killName} -- "-$target"${onMiss}; printf '%s\\n' "$target"`
}

/**
 * Signal every descendant of the recorded pid, then the pid itself.
 * A process that has double-forked out of this tree is no longer attributable
 * and is left alone. A stale pid file exits before any `kill`.
 */
export function treeSignalCommand(id: string, signal: string): string {
  if (!TERMINAL_SIGNAL.test(signal)) throw new Error(`refusing terminal signal ${signal}`)
  const killName = signal.slice('SIG'.length)
  const list = `list=$(ps -A -o pid=,ppid= | awk -v root="$pid" '{ p=$1; pp=$2; parent[p]=pp; ids[p]=1 } END { for (p in ids) { cur=p; guard=0; while (cur+0 > 1 && guard < 64) { if (cur+0 == root+0) { if (p+0 != root+0) print p; break } cur=parent[cur]; guard++ } } }')`
  return `${recordedProcess(ptyFile(id))}; ${list}; for child in $list; do kill -s ${killName} -- "$child" || true; done; kill -s ${killName} -- "$pid" || true; printf '%s\\n' "$pid"`
}

export function pidProbeCommand(id: string): string {
  return `${recordedProcess(ptyFile(id))}; printf '%s\\n' "$pid"`
}

export function pidCleanupCommand(id: string): string {
  return `rm -f ${ptyFile(id)}`
}

/**
 * One long-lived remote shell that runs probe lines. A fresh SSH exec per
 * poll would open a channel every 50ms for the whole send. The loop is one
 * channel; each line runs in a subshell so `exit` inside a probe cannot
 * kill the loop, and the marker is printed from that subshell so it is
 * flushed before the next read.
 */
export function probeLoopScript(mark: string): string {
  if (!PROBE_MARK.test(mark)) throw new Error('probe mark is not a DSHPROBE token')
  return `while IFS= read -r __dsh_line; do ( (eval "$__dsh_line"); __dsh_status=$?; printf '\\n${mark} %s\\n' "$__dsh_status" ); done`
}

/** What `ssh` execs for {@link probeLoopScript}. Prefer POSIX `sh`; do not require bash on the host. */
export function probeShellCommand(mark: string): string {
  return `sh -c ${shQuote(probeLoopScript(mark))}`
}

/** Byte stream of one remote probe shell. */
export interface ProbeStream {
  readonly stdout: Readable
  write(data: string): void
  close(): void
}

/**
 * Serialize probe lines onto one shell and read each line's status back.
 * A timeout or a closed stream drops the channel: the next opener starts
 * a fresh one, because a half-read marker would desync every later command.
 */
export class ProbeChannel {
  private buf = ''
  private closed = false
  /** Markers for commands whose caller gave up before their status arrived. */
  private abandoned = 0
  private tail: Promise<void> = Promise.resolve()
  private waiter: (() => void) | undefined

  constructor(private readonly stream: ProbeStream, private readonly mark: string) {
    if (!PROBE_MARK.test(mark)) throw new Error('probe mark is not a DSHPROBE token')
    stream.stdout.on('data', (chunk: Buffer | string) => {
      this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      this.waiter?.()
    })
    const fail = () => {
      this.closed = true
      this.waiter?.()
    }
    stream.stdout.on('end', fail)
    stream.stdout.on('error', fail)
  }

  exec(command: string, timeoutMs: number, signal?: AbortSignal): Promise<Pick<ExecResult, 'code' | 'stdout'>> {
    if (command.includes('\n')) return Promise.reject(new Error('probe command must be one line'))
    const run = this.tail.then(() => this.once(command, timeoutMs, signal))
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.stream.close()
    } catch {
      // The stream is already gone.
    }
    this.waiter?.()
  }

  private once(command: string, timeoutMs: number, signal?: AbortSignal): Promise<Pick<ExecResult, 'code' | 'stdout'>> {
    if (this.closed) return Promise.reject(new Error('probe channel is closed'))
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise((resolve, reject) => {
      const token = `\n${this.mark} `
      let settled = false
      let sent = false
      const finish = (error?: Error, value?: Pick<ExecResult, 'code' | 'stdout'>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (this.waiter === take) this.waiter = undefined
        if (error !== undefined) reject(error)
        else resolve(value!)
      }
      const onAbort = () => {
        // A per-call cancellation must not close the host-shared probe shell:
        // another terminal may be using it. If the command was already sent,
        // remember that its marker still has to be drained before the next
        // command's status can be trusted.
        if (sent) this.abandoned += 1
        finish(abortError(signal!))
      }
      const timer = setTimeout(() => {
        // A timed-out command leaves the shell's marker queue unknown; closing
        // the channel is safer than pairing a stale marker with a new command.
        finish(new Error('probe channel timed out'))
        this.close()
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      const take = () => {
        if (this.closed) {
          finish(new Error('probe channel is closed'))
          return
        }
        // Commands share one probe shell. When a caller aborted after writing
        // its line, consume the marker it will eventually produce before
        // parsing this caller's status.
        while (this.abandoned > 0) {
          const stale = this.buf.indexOf(token)
          if (stale < 0) return
          const staleRest = this.buf.slice(stale + token.length)
          const staleNewline = staleRest.indexOf('\n')
          if (staleNewline < 0) return
          this.buf = staleRest.slice(staleNewline + 1)
          this.abandoned -= 1
        }
        const at = this.buf.indexOf(token)
        if (at < 0) return
        const rest = this.buf.slice(at + token.length)
        const nl = rest.indexOf('\n')
        if (nl < 0) return
        const codeText = rest.slice(0, nl).trim()
        if (!/^-?[0-9]+$/u.test(codeText)) {
          this.buf = rest.slice(nl + 1)
          finish(new Error('probe channel returned a non-numeric status'))
          return
        }
        const stdout = this.buf.slice(0, at)
        this.buf = rest.slice(nl + 1)
        finish(undefined, { code: Number(codeText), stdout })
      }
      this.waiter = take
      take()
      if (settled) return
      try {
        sent = true
        this.stream.write(`${command}\n`)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        this.close()
      }
    })
  }
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

export function installSidebarBridge(ctx: BridgeContext, core: SidebarCore, terminalReady: () => boolean): (() => void) | undefined {
  const terminalService = ctx.get('terminalController')
  const directoryService = ctx.get('workingDirectory')
  if (terminalService == null || directoryService == null) {
    ctx.logger?.warn('[@dsh-permission-remote] sidebar bridge is missing terminalController or workingDirectory')
    return undefined
  }
  const terminal = unwrap(terminalService) as ShellHost
  const directories = directoryService as WorkingDirectoryService
  if (Object.hasOwn(terminal, 'shells') || Object.hasOwn(terminal, 'create') || Object.hasOwn(terminal, 'spawn')) {
    ctx.logger?.warn('[@dsh-permission-remote] sidebar bridge already installed')
    return undefined
  }
  const originalShells = terminal.shells.bind(terminal)
  const originalCreate = terminal.create.bind(terminal)
  const spawnSession = terminal.spawn
  const originalSessionSpawn = typeof spawnSession === 'function' ? spawnSession.bind(terminal) : undefined
  // rc.1 exposes 4 parameters, rc.2 exposes 5. The wrapper is variadic so both
  // work; log anything else instead of letting a future shape fail with a
  // downstream `TypeError` on the user's terminal.
  if (originalSessionSpawn !== undefined) {
    const arity = originalSessionSpawn.length
    if (arity !== 4 && arity !== 5) {
      ctx.logger?.warn(`[@dsh-permission-remote] terminal.spawn has ${arity} parameters; expected 4 (rc.1) or 5 (rc.2); forwarding arguments verbatim`)
    }
  }
  const requireRemoteTerminalReady = (route: RemoteRoute | undefined): void => {
    if (route === undefined || terminalReady()) return
    throw new Error('remote terminal is not ready: the terminal spawn bridge is not installed; refusing to fall back to the local PTY')
  }

  terminal.shells = async (agent, signal) => {
    // A terminal RPC may ask for the shell list without a cancellation signal.
    // Upstream `shells` still dereferences it, so give both it and this wrapper
    // a never-aborting default instead of throwing on the optional argument.
    const opSignal = signal ?? new AbortController().signal
    signal?.throwIfAborted()
    const route = sessionRoute(directories, agent)
    if (route === undefined) return originalShells(agent, opSignal)
    return core.loadShells(route.hostId, shellCandidatesOf(terminal))
  }
  terminal.create = async (agent, request, signal) => {
    const route = sessionRoute(directories, agent)
    requireRemoteTerminalReady(route)
    // The RPC may omit the signal; upstream `allocate` needs a real one for
    // `AbortSignal.any`, so supply a never-aborting default rather than
    // crashing on a missing optional.
    const opSignal = signal ?? new AbortController().signal
    if (route !== undefined && typeof request.shellPath === 'string' && request.shellPath.length > 0) {
      const shells = await terminal.shells(agent, opSignal)
      if (!shells.some(shell => shell.path === request.shellPath)) {
        const fallback = shells[0]
        if (fallback === undefined) throw new Error('no interactive shell found on the remote host')
        request = { ...request, shellPath: fallback.path }
      }
    }
    return originalCreate(agent, request, opSignal)
  }
  if (originalSessionSpawn !== undefined) {
    // Forward every argument: the official `spawn` signature changed from
    // (agent, owner, request, signal) to (agent, owner, id, prepare, signal)
    // between DSH 0.2.2-rc.1 and rc.2, and this wrapper must not drop the
    // signal of the newer shape. It is also the common funnel for `create`
    // and `openForAgent`, so the readiness guard lives here.
    terminal.spawn = async (...args: unknown[]) => {
      const agent = args[0] as { session?: object }
      const route = sessionRoute(directories, agent)
      requireRemoteTerminalReady(route)
      await materializeRemotePlaceholder(directories, agent)
      if (route === undefined) return (originalSessionSpawn as (...all: unknown[]) => Promise<unknown>)(...args)
      // rc.2's `prepare()` runs inside this call, and it consults
      // `subprocess.terminalEnvironment()` without a cwd. Run the allocation in
      // an async scope so only calls made by it see the remote route; a
      // concurrent local session keeps its own default shell.
      const id = typeof args[2] === 'string'
        ? args[2]
        : (args[2] as { id?: unknown } | undefined)?.id
      if (typeof id === 'string') rememberTerminalHistory(id, route)
      return runRemoteTerminal(route, () => (originalSessionSpawn as (...all: unknown[]) => Promise<unknown>)(...args))
    }
  }
  return () => {
    Reflect.deleteProperty(terminal, 'shells')
    Reflect.deleteProperty(terminal, 'create')
    Reflect.deleteProperty(terminal, 'spawn')
  }
}

/**
 * The only owner of `subprocess.spawnTerminal`.
 *
 * A placeholder cwd never reaches the local PTY. The sidebar shape keeps the
 * login shell it already built. Every other remote cwd is the model terminal:
 * its argv and environment are the official backend's, including a confined
 * `bwrap` or `sandbox-exec` argv.
 */
export function installTerminalSpawnBridge(ctx: BridgeContext, core: TerminalSpawnCore): (() => void) | undefined {
  const subprocessService = ctx.get('subprocess')
  if (subprocessService == null) {
    ctx.logger?.warn('[@dsh-permission-remote] terminal spawn bridge is missing subprocess')
    return undefined
  }
  const subprocess = unwrap(subprocessService) as SpawnHost
  if (Object.hasOwn(subprocess, 'spawnTerminal')) {
    ctx.logger?.warn('[@dsh-permission-remote] terminal spawn bridge already installed')
    return undefined
  }
  // `spawnTerminal` is a prototype method on dsh-subprocess-local, not an own
  // property. A DSH build that renamed or removed it must fail here with an
  // actionable message instead of a TypeError on `.bind` (or, worse, silently
  // leaving the official tool to open a local PTY). `check:upstream` probes the
  // same shape; this is the runtime backstop for an already-installed plugin.
  const runtimeSpawn = subprocess.spawnTerminal
  if (typeof runtimeSpawn !== 'function') {
    throw new Error('[@dsh-permission-remote] the installed DSH subprocess service has no spawnTerminal(); run `npm run check:upstream` against this DSH install')
  }
  const originalSpawn = runtimeSpawn.bind(subprocess)
  subprocess.spawnTerminal = async spec => {
    const route = routeByCwd(spec.cwd)
    if (route.kind !== 'remote') return originalSpawn(spec)
    // Preserve the existing unknown-host error before authorization probes.
    core.requireHost(route.hostId)
    // `spawnTerminal` has no session argument. The official terminal services
    // put the agent/session id in `spec.env.DSH_SESSION_ID`; a missing id is
    // not proof of anything, so refuse it instead of routing by cwd alone.
    const sessionId = spec.env?.DSH_SESSION_ID
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('refusing remote terminal: the spawn request does not carry DSH_SESSION_ID')
    }
    if (core.allowsRemoteSession === undefined || !core.allowsRemoteSession(sessionId, route.hostId)) {
      throw new Error(`refusing to use ${route.remoteCwd} on SSH host ${route.hostId}: this session was not opened on that host. Open the workspace from the list.`)
    }
    if (isSidebarTerminal(spec)) return openRemoteTerminal(core, route, spec)
    return openModelTerminal(core, route, spec)
  }
  return () => {
    Reflect.deleteProperty(subprocess, 'spawnTerminal')
    closeSharedProbes()
  }
}

interface SharedProbe {
  opening?: Promise<ProbeChannel>
  channel?: ProbeChannel
}

/** One foreground probe shell per host; every model terminal shares it. */
const sharedProbes = new Map<string, SharedProbe>()

/**
 * Release host-level probe shells. Called when the spawn bridge is removed
 * (no argument clears every host) and when a host is deleted or its connection
 * identity changes (with that host id), so a stale probe shell cannot be reused
 * after the connection is replaced.
 */
export function closeSharedProbes(hostId?: string): void {
  const entries = hostId === undefined
    ? [...sharedProbes.values()]
    : [sharedProbes.get(hostId)].filter((entry): entry is SharedProbe => entry !== undefined)
  if (hostId === undefined) sharedProbes.clear()
  else sharedProbes.delete(hostId)
  for (const entry of entries) {
    entry.channel?.close()
    entry.opening?.then(value => value.close()).catch(() => undefined)
  }
}

/**
 * Probes for one model terminal. The foreground shell is shared per host, so
 * N terminals do not spend N extra SSH sessions; capturePid and signal
 * delivery use one-shot execs and never contend with it. A pool without
 * `openEval` falls back to one fresh exec per probe.
 */
export function probeExecutor(core: TerminalSpawnCore, host: HostConfig, secret: SecretMaterial): TerminalProbe {
  const oneShot = (command: string, timeout: number, signal?: AbortSignal) => core.pool.exec(host, secret, command, timeout, signal)
  const opener = core.pool.openEval
  if (opener === undefined) {
    return { exec: oneShot, oneShot }
  }
  const entry = sharedProbes.get(host.id) ?? {}
  sharedProbes.set(host.id, entry)
  const open = (): Promise<ProbeChannel> => {
    if (entry.channel !== undefined) return Promise.resolve(entry.channel)
    if (entry.opening !== undefined) return entry.opening
    const mark = `DSHPROBE${randomBytes(8).toString('hex')}`
    // Keep `this` on the pool: `openEval` is a prototype method and `this`
    // is where `openPtcExec` (and therefore the SSH connection) lives.
    const started = opener.bind(core.pool)(host, secret, probeShellCommand(mark))
      .then(stream => {
        const channel = new ProbeChannel(stream, mark)
        if (entry.opening === started) {
          entry.channel = channel
          entry.opening = undefined
        }
        return channel
      }, error => {
        if (entry.opening === started) entry.opening = undefined
        throw error
      })
    entry.opening = started
    return started
  }
  return {
    async exec(command, timeout, signal) {
      const active = await open()
      try {
        return await active.exec(command, timeout, signal)
      } catch (error) {
        // A caller cancellation must not tear down the host-shared shell:
        // ProbeChannel drains that command's late marker instead. A timeout
        // or transport failure invalidates the shell for the next caller.
        const cancelled = signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
        if (entry.channel === active && !cancelled) {
          entry.channel = undefined
          if (sharedProbes.get(host.id) === entry) sharedProbes.delete(host.id)
          active.close()
        }
        throw error
      }
    },
    oneShot,
    // The probe shell is host-scoped; bridge removal closes it. A terminal
    // handle finishing must not close a shell another terminal is using.
    close() {},
  }
}

/**
 * `TerminalController.spawn` calls `workingDirectory.ensure` before `spawnTerminal`.
 * `ensure` restores the workspace root when the session directory is missing, and
 * tells the conversation. Creating that directory first keeps the new terminal
 * in the directory the session is already using. A failure leaves `ensure` to
 * report the same problem it would have reported on its own.
 */
async function materializeRemotePlaceholder(directories: WorkingDirectoryService, agent: { session?: object }): Promise<void> {
  if (agent.session === undefined) return
  let cwd: string
  try {
    cwd = directories.get(agent.session)
  } catch {
    return
  }
  if (routeByCwd(cwd).kind !== 'remote') return
  await mkdir(cwd, { recursive: true }).catch(() => undefined)
}

async function openRemoteTerminal(core: TerminalSpawnCore, route: RemoteRoute, spec: SidebarSpawnSpec): Promise<SshTerminalHandle> {
  if (spec.argv.length === 0) throw new Error('sidebar terminal is missing a shell')
  const host = core.requireHost(route.hostId)
  const opened = await core.pool.openPty(host, await core.secret(host), {
    command: sidebarCommand(route.remoteCwd, confineTerminalCwd(spec.argv, route.remoteCwd), spec.env),
    term: spec.terminalType,
    cols: spec.cols,
    rows: spec.rows,
    signal: spec.signal,
  })
  return new SshTerminalHandle(opened.channel, opened.onTransportClosed)
}

const PID_WAIT_MS = 1_000
const PROBE_TIMEOUT_MS = 5_000

async function openModelTerminal(core: TerminalSpawnCore, route: RemoteRoute, spec: SidebarSpawnSpec): Promise<ModelTerminalHandle> {
  if (spec.argv.length === 0) throw new Error('terminal is missing a command')
  const id = randomBytes(8).toString('hex')
  const host = core.requireHost(route.hostId)
  const secret = await core.secret(host)
  const opened = await core.pool.openPty(host, secret, {
    command: modelTerminalCommand(route.remoteCwd, confineTerminalCwd(spec.argv, route.remoteCwd), spec.env, id),
    term: spec.terminalType,
    cols: spec.cols,
    rows: spec.rows,
    signal: spec.signal,
  })
  const handle = new ModelTerminalHandle(opened.channel, opened.onTransportClosed, id, spec.graceMs ?? 3_000, probeExecutor(core, host, secret))
  try {
    await handle.capturePid(spec.signal)
  } catch (error) {
    await handle.terminate().catch(() => undefined)
    throw error
  }
  return handle
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
  /** The channel is paused because the screen consumer is behind. */
  private paused = false
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
    this.output.on('drain', () => this.resume())
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

  /**
   * Close the channel first, then wait for in-flight calls.
   *
   * A remote program that never reads stdin (`sleep`, a stopped job, a pager)
   * leaves the channel window full, so `write` parks on `drain` indefinitely.
   * `close()` is the only thing that can release it: it ends the channel, the
   * `close` event runs `finish`, and `finish` wakes every blocked write. Waiting
   * on `pending` first would deadlock against that.
   */
  async terminate(): Promise<void> {
    try {
      this.channel.close()
    } catch (error) {
      this.finish(error instanceof Error ? error : new Error(String(error)))
    }
    await Promise.allSettled([...this.pending])
    await this.done.then(() => undefined, () => undefined)
  }

  /**
   * Forward bytes, pausing the channel while the screen consumer is behind.
   *
   * `output` is read by the controller's headless emulator. A `PassThrough`
   * nobody drains would buffer without bound — one `yes` or `journalctl -f`
   * fills it in seconds — so the channel is paused until `drain`, exactly as the
   * local provider does.
   */
  private push(chunk: Buffer | string): void {
    if (this.settled || this.output.writableEnded) return
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    if (!this.output.write(bytes) && !this.paused && !this.settled) {
      this.paused = true
      this.channel.pause?.()
    }
  }

  private resume(): void {
    if (!this.paused) return
    this.paused = false
    if (!this.settled) this.channel.resume?.()
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

export interface TerminalProbe {
  exec(command: string, timeoutMs: number, signal?: AbortSignal): Promise<Pick<ExecResult, 'code' | 'stdout'> & { stderr?: string }>
  /** Fresh-channel probe for pid capture/cleanup; never shares the foreground shell. */
  oneShot?(command: string, timeoutMs: number, signal?: AbortSignal): Promise<Pick<ExecResult, 'code' | 'stdout'> & { stderr?: string }>
  /** Release the foreground probe shell owned by this handle. */
  close?(): void
}

/**
 * One model PTY. I/O is the sidebar handle. The foreground group is whatever
 * the remote host can see for the recorded pid; `inputWaiting` stays false so
 * a missing syscall probe cannot report an exact stdin wait. When `ps` cannot
 * see the group, inspection returns undefined and the official backend settles
 * on its prompt and silence path. A signal whose `kill` misses still returns
 * the group id, so cancelling a send does not close the session. `terminate`
 * signals the recorded process and the descendants still hanging off it, then
 * closes the channel.
 */
export class ModelTerminalHandle {
  readonly output: PassThrough
  readonly done: Promise<TerminalExit>
  private remotePid = 0
  private readonly screen: SshTerminalHandle

  constructor(
    channel: PtyChannel,
    onTransportClosed: OpenPty['onTransportClosed'],
    private readonly id: string,
    private readonly graceMs: number,
    private readonly probe: TerminalProbe,
    private readonly pidWaitMs = PID_WAIT_MS,
  ) {
    this.screen = new SshTerminalHandle(channel, onTransportClosed)
    this.output = this.screen.output
    this.done = this.screen.done
    // The shell exiting on its own never reaches `terminate`. Drop the pid
    // file then, so a reused pid cannot be signalled from a later close. The
    // one-shot exec keeps this cleanup independent of the foreground probe
    // channel, which may already be closed with the transport.
    const dropPidFile = () => {
      const cleanup = this.probe.oneShot ?? this.probe.exec
      void cleanup(pidCleanupCommand(this.id), PROBE_TIMEOUT_MS).catch(() => undefined)
    }
    const dropProbe = () => this.probe.close?.()
    void this.done.then(() => { dropPidFile(); dropProbe() }, () => { dropPidFile(); dropProbe() })
  }

  get pid(): number {
    return this.remotePid
  }

  write(data: string): Promise<void> {
    return this.screen.write(data)
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.screen.resize(cols, rows)
  }

  inspectActivity(): Promise<{ state: 'unknown', revision: number }> {
    return this.screen.inspectActivity()
  }

  /**
   * Read the pid file. A transport failure rejects immediately. A missing
   * file is retried until the deadline, then rejected: pid 0 would be
   * published to `terminal_list` as a real process.
   */
  async capturePid(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.pidWaitMs
    let lastError = ''
    for (;;) {
      signal?.throwIfAborted()
      const capture = this.probe.oneShot ?? this.probe.exec
      const result = await capture(pidProbeCommand(this.id), PROBE_TIMEOUT_MS, signal)
      const pid = result.code === 0 ? positiveInteger(result.stdout) : undefined
      if (pid !== undefined) {
        this.remotePid = pid
        return
      }
      if (result.code !== 0 && typeof result.stderr === 'string') {
        lastError = result.stderr.trim()
      }
      if (Date.now() >= deadline) {
        throw new Error(`terminal pid file was not written${lastError.length > 0 ? `: ${lastError}` : ''}`)
      }
      await delay(50, signal)
    }
  }

  async inspectForeground(): Promise<{ processGroupId: number, inputWaiting: false } | undefined> {
    const group = await this.readNumber(foregroundProbeCommand(this.id))
    if (group === undefined) return undefined
    return { processGroupId: group, inputWaiting: false }
  }

  async signalForeground(signal: string): Promise<number> {
    const result = await this.probeResult(signalProbeCommand(this.id, signal))
    if (result?.code === SIGKILL_REFUSED_CODE) {
      throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead')
    }
    const group = result?.code === 0 ? positiveInteger(result.stdout) : undefined
    if (group !== undefined) return group
    // `interruptOnce` treats a thrown foreground probe as a transport failure
    // and terminates the whole session. Once capturePid has a real pid, a
    // failed SIGINT probe is not evidence that the PTY is dead: report the
    // recorded process so a cancelled send does not kill a healthy terminal.
    // Every other signal must stay honest: `terminal_signal` returns
    // `delivered: true` whenever this method resolves.
    if (signal === 'SIGINT' && this.remotePid > 0) return this.remotePid
    throw new Error('terminal foreground group is not visible')
  }

  /**
   * SIGTERM the recorded process and its remaining descendants, wait out the
   * grace, then SIGKILL and close the channel. Closing the channel is the
   * fallback: sshd sends SIGHUP to the foreground group when the pty goes
   * away. A descendant that has already left the tree is not visible here.
   */
  async terminate(): Promise<void> {
    await this.signalTree('SIGTERM')
    if (this.graceMs > 0) {
      await Promise.race([
        this.screen.done.then(() => undefined, () => undefined),
        delay(this.graceMs),
      ])
    }
    await this.signalTree('SIGKILL')
    await this.screen.terminate()
    await this.readNumber(pidCleanupCommand(this.id), undefined, true).catch(() => undefined)
  }

  private async signalTree(signal: string): Promise<void> {
    await this.readNumber(treeSignalCommand(this.id, signal), undefined, true).catch(() => undefined)
  }

  private async probeResult(command: string, signal?: AbortSignal): Promise<Pick<ExecResult, 'code' | 'stdout'> | undefined> {
    try {
      const exec = this.probe.oneShot ?? this.probe.exec
      return await exec(command, PROBE_TIMEOUT_MS, signal)
    } catch {
      return undefined
    }
  }

  private async readNumber(command: string, signal?: AbortSignal, oneShot = false): Promise<number | undefined> {
    let result: Pick<ExecResult, 'code' | 'stdout'>
    try {
      const exec = oneShot && this.probe.oneShot !== undefined ? this.probe.oneShot : this.probe.exec
      result = await exec(command, PROBE_TIMEOUT_MS, signal)
    } catch {
      return undefined
    }
    if (result.code !== 0) return undefined
    return positiveInteger(result.stdout)
  }
}

function positiveInteger(stdout: string): number | undefined {
  const line = stdout.split('\n').map(item => item.trim()).find(item => item.length > 0)
  if (line === undefined || !/^[0-9]+$/u.test(line)) return undefined
  const value = Number(line)
  if (!Number.isSafeInteger(value) || value <= 0) return undefined
  return value
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The operation was aborted')
}

function nodeSignal(signal: string | null | undefined): NodeJS.Signals | null {
  if (signal == null || signal.length === 0) return null
  const name = signal.startsWith('SIG') ? signal : `SIG${signal}`
  if (!/^SIG[A-Z0-9]+$/u.test(name)) return null
  return name as NodeJS.Signals
}

/** Readable side of the handle, kept as a named export for the consume-shaped test. */
export type TerminalOutput = Readable
