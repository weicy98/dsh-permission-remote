import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { Context, symbols } from '@deepseek-ai/cordis'
import type { HostConfig } from '../src/config.ts'
import { apply } from '../src/index.ts'
import { mapRemoteToLocal } from '../src/router.ts'
import {
  confineTerminalCwd,
  foregroundProbeCommand,
  installSidebarBridge,
  installTerminalSpawnBridge,
  isSidebarTerminal,
  modelTerminalCommand,
  ModelTerminalHandle,
  parseShellProbe,
  pidProbeCommand,
  ProbeChannel,
  closeSharedProbes,
  probeExecutor,
  probeLoopScript,
  probeShellCommand,
  shellProbeCommand,
  sidebarCommand,
  signalProbeCommand,
  SshTerminalHandle,
  treeSignalCommand,
  type SidebarCore,
  type SidebarShell,
  type SidebarSpawnSpec,
} from '../src/sidebar-terminal.ts'
import { channelLimitMessage, SshFailure, type PtyRequest } from '../src/ssh-pool.ts'

// Opening a sidebar terminal creates the placeholder directory, so the tests
// must not touch the operator's real ~/.dsh/remote tree.
process.env.DSH_SSH_REMOTE_ROOT = mkdtempSync(join(tmpdir(), 'dsh-sidebar-terminal-'))

function host(): HostConfig {
  return {
    id: 'host1',
    name: 'lo',
    host: '10.0.0.5',
    port: 22,
    username: 'me',
    auth: 'key',
    privateKeyPath: '',
    fingerprint: 'SHA256:abc',
    opsPolicy: 'ask',
  }
}

function remotePlaceholder(remotePath: string, hostId = 'host1'): string {
  const local = mapRemoteToLocal(hostId, remotePath)
  assert.ok(local)
  return local
}

const placeholder = remotePlaceholder('/remote/src')

function sidebarSpec(cwd: string, extra: Partial<SidebarSpawnSpec> = {}): SidebarSpawnSpec {
  return {
    argv: ['/bin/zsh', '-l', '-i'],
    cwd,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    shellActivity: true,
    env: { DSH_SESSION_ID: 'sess-remote' },
    ...extra,
  }
}

class FakeChannel {
  readonly writes: string[] = []
  readonly windows: number[][] = []
  readonly signals: string[] = []
  closed = 0
  private readonly dataListeners: Array<(chunk: Buffer | string) => void> = []
  private readonly closeListeners: Array<(code?: number | null, signal?: string | null) => void> = []
  private readonly stderrListeners: Array<(chunk: Buffer | string) => void> = []
  readonly stderr = {
    on: (_event: 'data', listener: (chunk: Buffer | string) => void) => {
      this.stderrListeners.push(listener)
    },
  }

  on(event: 'data', listener: (chunk: Buffer | string) => void): void
  on(event: 'close', listener: (code?: number | null, signal?: string | null) => void): void
  on(event: 'data' | 'close', listener: ((chunk: Buffer | string) => void) | ((code?: number | null, signal?: string | null) => void)): void {
    if (event === 'data') this.dataListeners.push(listener as (chunk: Buffer | string) => void)
    else this.closeListeners.push(listener as (code?: number | null, signal?: string | null) => void)
  }

  write(data: string): boolean {
    this.writes.push(data)
    return true
  }

  setWindow(rows: number, cols: number, height: number, width: number): void {
    this.windows.push([rows, cols, height, width])
  }

  signal(name: string): void {
    this.signals.push(name)
  }

  close(): void {
    this.closed += 1
    this.emitClose(0, null)
  }

  emitData(chunk: Buffer | string): void {
    for (const listener of this.dataListeners) listener(chunk)
  }

  emitStderr(chunk: Buffer | string): void {
    for (const listener of this.stderrListeners) listener(chunk)
  }

  emitClose(code?: number | null, signal?: string | null): void {
    for (const listener of this.closeListeners) listener(code, signal)
  }
}

class BlockingChannel extends FakeChannel {
  private drain: (() => void) | undefined

  override write(data: string): boolean {
    super.write(data)
    return false
  }

  once(_event: 'drain', listener: () => void): void {
    this.drain = listener
  }

  release(): void {
    this.drain?.()
  }
}

class FullChannel extends FakeChannel {
  override write(data: string): boolean {
    super.write(data)
    return false
  }
}

class LocalSpawn {
  readonly marker = 'local-runtime'
  readonly calls: SidebarSpawnSpec[] = []

  async spawnTerminal(spec: SidebarSpawnSpec): Promise<{ marker: string, spec: SidebarSpawnSpec }> {
    this.calls.push(spec)
    return { marker: this.marker, spec }
  }
}

class Terminals {
  readonly marker = 'local-controller'
  config: { shellCandidates?: readonly string[] } | undefined = { shellCandidates: ['zsh', 'bash', 'fish', 'sh'] }
  readonly shellCalls: unknown[] = []
  readonly createCalls: Array<Record<string, unknown>> = []

  async shells(agent: { session?: object }, signal: AbortSignal): Promise<SidebarShell[]> {
    this.shellCalls.push(agent)
    signal.throwIfAborted()
    return [{ path: '/bin/local-zsh', name: 'zsh', args: ['-i'] }]
  }

  async create(agent: { session?: object }, request: Record<string, unknown>, _signal: AbortSignal): Promise<{ marker: string, request: Record<string, unknown> }> {
    this.createCalls.push(request)
    return { marker: this.marker, request }
  }
}

class Directories {
  cwd = '/tmp/project'

  get(_session: object): string {
    return this.cwd
  }
}

/** Same order as `TerminalController.spawn`: `ensure`, then `spawnTerminal`. */
class EnsuringController extends Terminals {
  readonly fallbacks: string[] = []

  constructor(private readonly directories: Directories, private readonly subprocess: LocalSpawn) {
    super()
  }

  async spawn(agent: { session?: { header?: { cwd?: string } } }, _owner: unknown, request: { cols?: number, rows?: number }, signal: AbortSignal, ..._extra: unknown[]): Promise<unknown> {
    const current = this.directories.get(agent.session ?? {})
    let cwd = current
    if (!isDirectory(current)) {
      this.fallbacks.push(current)
      cwd = agent.session?.header?.cwd ?? current
      this.directories.cwd = cwd
    }
    return this.subprocess.spawnTerminal(sidebarSpec(cwd, {
      cols: typeof request.cols === 'number' ? request.cols : 80,
      rows: typeof request.rows === 'number' ? request.rows : 24,
      signal,
    }))
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function harness(overrides: { terminal?: Terminals, directories?: Directories, subprocess?: LocalSpawn } = {}) {
  const terminal = overrides.terminal ?? new Terminals()
  const subprocess = overrides.subprocess ?? new LocalSpawn()
  const directories = overrides.directories ?? new Directories()
  const warnings: string[] = []
  const pty: PtyRequest[] = []
  const probes: string[] = []
  const gate: { error?: Error } = {}
  const remoteShells: SidebarShell[] = [{ path: '/bin/zsh', name: 'lo · zsh', args: ['-l', '-i'] }]
  const core: SidebarCore = {
    requireHost(hostId: string) {
      if (hostId !== 'host1') throw new Error(`unknown SSH host ${hostId}`)
      return host()
    },
    allowsRemoteSession(sessionId: string, hostId: string) {
      return sessionId === 'sess-remote' && hostId === 'host1'
    },
    async secret() {
      return {}
    },
    async loadShells() {
      return remoteShells
    },
    pool: {
      async openPty(_host, _secret, request) {
        pty.push(request)
        if (gate.error !== undefined) throw gate.error
        return { channel: new FakeChannel(), onTransportClosed: () => () => undefined }
      },
      async exec(_host, _secret, command) {
        probes.push(command)
        if (command.includes('tpgid=')) return { code: 0, stdout: '4321\n' }
        if (command.startsWith('rm ')) return { code: 0, stdout: '' }
        return { code: 0, stdout: '4242\n' }
      },
    },
  }
  const ctx = {
    get(name: string) {
      if (name === 'terminalController') return terminal
      if (name === 'subprocess') return subprocess
      if (name === 'workingDirectory') return directories
      return undefined
    },
    logger: { warn(message: string) { warnings.push(message) } },
  }
  const removeSidebar = installSidebarBridge(ctx, core, () => true)
  const removeSpawn = installTerminalSpawnBridge(ctx, core)
  const remove = () => {
    removeSidebar?.()
    removeSpawn?.()
  }
  return { terminal, subprocess, directories, core, pty, probes, warnings, remove, removeSidebar, removeSpawn, ctx, gate, remoteShells }
}

const remoteAgent = { session: { id: 'remote' } }
const signal = new AbortController().signal

test('a shell probe keeps $SHELL first and skips relative or windows paths', () => {
  const shells = parseShellProbe([
    'motd',
    'SHELL /usr/local/bin/Bash.EXE',
    'HAVE /bin/zsh',
    'HAVE bash',
    'HAVE /usr/bin/pwsh',
    'HAVE /bin/bash',
    'HAVE /usr/bin/fish',
    'HAVE /bin/sh',
    'HAVE /bin/dash',
    'HAVE /usr/bin/nu',
    'HAVE /bin/zsh',
  ].join('\n'), 'lo')
  assert.deepEqual(shells, [
    { path: '/usr/local/bin/Bash.EXE', name: 'lo · bash', args: ['-l', '-i'] },
    { path: '/bin/zsh', name: 'lo · zsh', args: ['-l', '-i'] },
    { path: '/usr/bin/fish', name: 'lo · fish', args: ['-l', '-i'] },
    { path: '/bin/sh', name: 'lo · sh', args: ['-i'] },
    { path: '/bin/dash', name: 'lo · dash', args: ['-i'] },
    { path: '/usr/bin/nu', name: 'lo · nu', args: ['-i'] },
  ])
})

test('the probe command uses POSIX printf and leaves windows shells out', () => {
  const command = shellProbeCommand(['zsh', 'bash', 'fish', 'sh', 'pwsh', 'powershell', 'cmd', 'dash'])
  assert.equal(command.includes('\n'), false)
  assert.match(command, /printf 'SHELL %s\\n' "\$SHELL"/)
  assert.match(command, /printf 'HAVE %s\\n'/)
  assert.match(command, /command -v 'zsh'/)
  assert.match(command, /command -v 'dash'/)
  assert.equal(command.includes("command -v 'pwsh'"), false)
  assert.equal(command.includes("command -v 'powershell'"), false)
  assert.equal(command.includes("command -v 'cmd'"), false)
  const sidebarText = sidebarCommand("/remote/o's", ['/bin/zsh', '-l', '-i'])
  assert.ok(sidebarText.startsWith("sh -c '"))
  assert.ok(sidebarText.includes("/remote/o"))
  assert.ok(sidebarText.includes("'/bin/zsh'"))
})

test('the terminal launcher points bwrap --chdir at the requested cwd, not the workspace root', () => {
  const root = ['bwrap', '--ro-bind', '/', '/', '--tmpfs', '/tmp', '--bind', '/srv/app', '/srv/app', '--', 'bash', '-i']
  const retargeted = confineTerminalCwd(root, '/srv/app/sub')
  const separator = retargeted.indexOf('--')
  assert.deepEqual(retargeted.slice(separator - 2, separator), ['--chdir', '/srv/app/sub'])
  // An existing --chdir is replaced, not duplicated.
  const existing = ['bwrap', '--tmpfs', '/tmp', '--chdir', '/srv/app', '--', 'bash']
  const replaced = confineTerminalCwd(existing, '/srv/app/sub')
  assert.equal(replaced.filter(value => value === '--chdir').length, 1)
  assert.equal(replaced[replaced.indexOf('--chdir') + 1], '/srv/app/sub')
  // Non-bwrap argv (danger-full-access, seatbelt, sidebar) is untouched.
  assert.deepEqual(confineTerminalCwd(['/bin/bash', '-i'], '/srv/app/sub'), ['/bin/bash', '-i'])
  assert.deepEqual(confineTerminalCwd(['sandbox-exec', '-p', 'x', '--', 'bash'], '/srv/app/sub'), ['sandbox-exec', '-p', 'x', '--', 'bash'])
})

test('a model terminal command quotes cwd, env, and argv', () => {
  const id = '0123456789abcdef'
  const command = modelTerminalCommand("/remote/o's", ['/bin/bash', 'a b'], { TERM: 'dumb', PS1: "dsh> '" }, id)
  assert.equal(command.includes('\n'), false)
  assert.ok(command.startsWith("sh -c '"))
  assert.ok(command.includes('/remote/o'))
  assert.ok(command.includes('|| exit 1;'))
  assert.match(command, /mkdir -p -- "\$HOME"\/\.dsh-permission-remote\/pty/)
  assert.ok(command.includes('printf ')); assert.ok(command.includes('0123456789abcdef.pid'))
  assert.match(command, /ps -o lstart=/)
  assert.ok(command.includes('TERM=')); assert.ok(command.includes('dumb'))
  assert.ok(command.includes('/bin/bash'))
  assert.ok(command.includes('a b'))
  assert.throws(() => modelTerminalCommand('/srv', ['/bin/bash'], { 'BAD NAME': 'x' }, id), /environment name/)
  assert.equal(foregroundProbeCommand(id).includes('ps -o tpgid='), true)
  assert.equal(foregroundProbeCommand(id).includes("''|0|*[!0-9]*"), true)
  const signal = signalProbeCommand(id, 'SIGINT')
  assert.equal(signal.includes('kill -s INT -- "-$target"'), true)
  assert.equal(signal.includes('channel.signal'), false)
  assert.equal(signal.includes('-$tpgid;'), false)
  assert.throws(() => signalProbeCommand(id, 'SIGQUIT'), /refusing terminal signal/)
  assert.match(pidProbeCommand(id), new RegExp(`${id}\\.pid`))
  assert.match(pidProbeCommand(id), /lstart=/)
})

test('a model terminal reads the host foreground group and does not use channel.signal', async () => {
  const id = '0123456789abcdef'
  const channel = new FakeChannel()
  const probes: string[] = []
  const handle = new ModelTerminalHandle(channel, () => () => undefined, id, 0, {
    async exec(command) {
      probes.push(command)
      if (command.includes('kill -s INT')) return { code: 0, stdout: '99\n' }
      if (command.includes('kill -s TERM')) return { code: 0, stdout: '99\n' }
      if (command.includes('kill -s KILL')) return { code: 0, stdout: '99\n' }
      if (command.includes('ps -o tpgid=')) return { code: 0, stdout: '  77\n' }
      if (command.startsWith('rm ')) return { code: 0, stdout: '' }
      return { code: 0, stdout: '55\n' }
    },
  }, 0)
  await handle.capturePid()
  assert.equal(handle.pid, 55)
  assert.deepEqual(await handle.inspectForeground(), { processGroupId: 77, inputWaiting: false })
  assert.equal(await handle.signalForeground('SIGINT'), 99)
  assert.deepEqual(channel.signals, [])
  const missing = new ModelTerminalHandle(new FakeChannel(), () => () => undefined, id, 0, {
    async exec() {
      return { code: 1, stdout: '' }
    },
  }, 0)
  await assert.rejects(() => missing.capturePid(), /pid file was not written/)
  assert.equal(missing.pid, 0)
  assert.equal(await missing.inspectForeground(), undefined)
  await assert.rejects(() => missing.signalForeground('SIGINT'), /foreground group is not visible/)

  await handle.terminate()
  assert.equal(channel.closed, 1)
  assert.equal(probes.some(command => command.includes('kill -s TERM')), true)
  assert.equal(probes.some(command => command.includes('kill -s KILL')), true)
  assert.equal(probes.some(command => command.startsWith('rm ')), true)
  assert.deepEqual(channel.signals, [])
})

test('a failed foreground probe falls back to the recorded pid for signals', async () => {
  const id = '0123456789abcdef'
  let captured = false
  const handle = new ModelTerminalHandle(new FakeChannel(), () => () => undefined, id, 0, {
    async exec(command) {
      if (command.includes('tpgid=')) throw new Error('probe channel is closed')
      captured = true
      return { code: 0, stdout: '55\n' }
    },
  }, 0)
  await handle.capturePid()
  assert.equal(captured, true)
  assert.equal(handle.pid, 55)
  // Official interruptOnce treats a thrown signalForeground as a dead
  // transport and terminates the session; the recorded pid keeps it alive.
  assert.equal(await handle.signalForeground('SIGINT'), 55)
})

test('SIGKILL of the recorded shell is refused instead of signalled', async () => {
  const id = '0123456789abcdef'
  const handle = new ModelTerminalHandle(new FakeChannel(), () => () => undefined, id, 0, {
    async exec(command) {
      if (command.includes('SIGKILL')) return { code: 42, stdout: '' }
      return { code: 0, stdout: '55\n' }
    },
  }, 0)
  await handle.capturePid()
  await assert.rejects(
    () => handle.signalForeground('SIGKILL'),
    /refusing to SIGKILL the terminal shell; terminate the terminal session instead/,
  )
})

test('only an xterm sidebar allocation is remote', () => {
  assert.equal(isSidebarTerminal({ terminalType: 'xterm-256color', shellActivity: true }), true)
  assert.equal(isSidebarTerminal({ terminalType: 'dumb', shellActivity: true }), false)
  assert.equal(isSidebarTerminal({ terminalType: 'xterm-256color', shellActivity: false }), false)
  assert.equal(isSidebarTerminal({ terminalType: 'xterm-256color' }), false)
})

test('a remote sidebar spawn opens a pty and leaves the local runtime alone', async () => {
  const box = harness()
  assert.equal(typeof box.remove, 'function')
  box.directories.cwd = placeholder
  const opened: unknown = await box.subprocess.spawnTerminal(sidebarSpec(placeholder, { cols: 100, rows: 40 }))
  assert.equal(opened instanceof SshTerminalHandle, true)
  assert.equal(box.subprocess.calls.length, 0)
  assert.equal(box.pty.length, 1)
  assert.ok(box.pty[0]!.command.startsWith("sh -c '")); assert.ok(box.pty[0]!.command.includes("/remote/src")); assert.ok(box.pty[0]!.command.includes("DSH_SESSION_ID="))
  assert.equal(box.pty[0]!.term, 'xterm-256color')
  assert.equal(box.pty[0]!.cols, 100)
  assert.equal(box.pty[0]!.rows, 40)
  assert.ok(box.pty[0]!.command.includes('DSH_SESSION_ID='))

  const nested = remotePlaceholder('/remote/src')
  await box.subprocess.spawnTerminal(sidebarSpec(`${nested}/lib`))
  assert.ok(box.pty[1]!.command.includes("/remote/src/lib"))

  const quoted = remotePlaceholder("/remote/o's")
  await box.subprocess.spawnTerminal(sidebarSpec(quoted))
  assert.ok(box.pty[2]!.command.includes("/remote/o"))
  assert.equal(box.subprocess.calls.length, 0)
})

test('an env block on the spec is forwarded to the remote shell', async () => {
  const box = harness()
  const spec = { ...sidebarSpec(placeholder), env: { DSH_SESSION_ID: 'sess-remote', TERM: 'xterm-256color' } }
  await box.subprocess.spawnTerminal(spec)
  assert.ok(box.pty[0]!.command.includes('DSH_SESSION_ID=')); assert.ok(box.pty[0]!.command.includes('TERM='))
})

test('a local directory stays on the local runtime', async () => {
  const box = harness()
  const local = await box.subprocess.spawnTerminal(sidebarSpec('/tmp/project'))
  assert.equal(local.marker, 'local-runtime')
  assert.equal(box.pty.length, 0)
  assert.equal(box.subprocess.calls.length, 1)
})

test('a remote spawn without DSH_SESSION_ID is refused without opening a pty', async () => {
  const box = harness()
  const spec = { ...sidebarSpec(placeholder), env: undefined }
  await assert.rejects(() => box.subprocess.spawnTerminal(spec), /DSH_SESSION_ID/)
  assert.equal(box.pty.length, 0)
  assert.equal(box.subprocess.calls.length, 0)
})

test('a remote spawn from a session not opened on the host is refused without opening a pty', async () => {
  const box = harness()
  const spec = { ...sidebarSpec(placeholder), env: { DSH_SESSION_ID: 'other-session' } }
  await assert.rejects(() => box.subprocess.spawnTerminal(spec), /not opened on that host/)
  assert.equal(box.pty.length, 0)
  assert.equal(box.subprocess.calls.length, 0)
})

test('a remote cwd that is not a sidebar terminal opens a model pty', async () => {
  const box = harness()
  const dumb: unknown = await box.subprocess.spawnTerminal(sidebarSpec(placeholder, {
    terminalType: 'dumb',
    argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
    env: { DSH_SESSION_ID: 'sess-remote', TERM: 'dumb', PS1: 'dsh> ' },
    graceMs: 0,
  }))
  assert.equal(dumb instanceof ModelTerminalHandle, true)
  assert.equal(dumb instanceof ModelTerminalHandle && dumb.pid, 4242)
  assert.equal(box.subprocess.calls.length, 0)
  assert.equal(box.pty.length, 1)
  assert.ok(box.pty[0]!.command.includes('/remote/src')); assert.ok(box.pty[0]!.command.includes('|| exit 1; mkdir -p -- "$HOME"/.dsh-permission-remote/pty'))
  assert.ok(box.pty[0]!.command.includes('exec env DSH_SESSION_ID=')); assert.ok(box.pty[0]!.command.includes('TERM=')); assert.ok(box.pty[0]!.command.includes('/bin/bash')); assert.ok(box.pty[0]!.command.includes('--noprofile'))
  assert.equal(box.pty[0]!.term, 'dumb')
  assert.ok(box.pty[0]!.command.includes('DSH_SESSION_ID='))

  const quiet = await box.subprocess.spawnTerminal(sidebarSpec(placeholder, { shellActivity: false, graceMs: 0 }))
  assert.equal(quiet instanceof ModelTerminalHandle, true)
  assert.ok(box.pty[1]!.command.includes('exec env DSH_SESSION_ID=')); assert.ok(box.pty[1]!.command.includes('/bin/zsh'))
  assert.equal(box.subprocess.calls.length, 0)
})

test('a missing host, a refused channel, or a missing shell does not open a local pty', async () => {
  const box = harness()
  await assert.rejects(() => box.subprocess.spawnTerminal(sidebarSpec(remotePlaceholder('/remote/src', 'gone'))), /unknown SSH host gone/)
  assert.equal(box.pty.length, 0)
  assert.equal(box.subprocess.calls.length, 0)

  box.gate.error = new Error('MaxSessions')
  await assert.rejects(() => box.subprocess.spawnTerminal(sidebarSpec(placeholder)), /MaxSessions/)
  assert.equal(box.subprocess.calls.length, 0)

  box.gate.error = undefined
  box.core.secret = async () => {
    throw new Error('password is not stored')
  }
  await assert.rejects(() => box.subprocess.spawnTerminal(sidebarSpec(placeholder)), /password is not stored/)
  assert.equal(box.pty.length, 1)
  assert.equal(box.subprocess.calls.length, 0)

  await assert.rejects(() => box.subprocess.spawnTerminal(sidebarSpec(placeholder, { argv: [] })), /sidebar terminal is missing a shell/)
  assert.equal(box.pty.length, 1)
})

test('remote shells come from the host and local shells stay on the controller', async () => {
  const box = harness()
  const seen: string[][] = []
  box.core.loadShells = async (_hostId, candidates) => {
    seen.push([...candidates])
    return box.remoteShells
  }
  box.directories.cwd = placeholder
  const remote = await box.terminal.shells(remoteAgent, signal)
  assert.equal(box.terminal.shellCalls.length, 0)
  assert.equal(remote[0]!.name, 'lo · zsh')
  assert.deepEqual(remote[0]!.args, ['-l', '-i'])
  assert.deepEqual(seen[0], ['zsh', 'bash', 'fish', 'sh'])

  box.terminal.config = undefined
  await box.terminal.shells(remoteAgent, signal)
  assert.deepEqual(seen[1], ['zsh', 'bash', 'fish', 'sh'])

  box.terminal.config = { shellCandidates: ['fish'] }
  await box.terminal.shells(remoteAgent, signal)
  assert.deepEqual(seen[2], ['fish'])

  box.directories.cwd = '/tmp/project'
  const local = await box.terminal.shells(remoteAgent, signal)
  assert.equal(local[0]!.path, '/bin/local-zsh')
  assert.equal(local[0]!.name, 'zsh')
  assert.equal(box.terminal.shellCalls.length, 1)
  assert.equal(box.terminal.marker, 'local-controller')

  box.directories.get = () => {
    throw new Error('no session directory')
  }
  await box.terminal.shells(remoteAgent, signal)
  assert.equal(box.terminal.shellCalls.length, 2)
  await box.terminal.shells({}, signal)
  assert.equal(box.terminal.shellCalls.length, 3)

  const aborted = new AbortController()
  aborted.abort()
  box.directories.cwd = placeholder
  box.directories.get = () => placeholder
  await assert.rejects(() => box.terminal.shells(remoteAgent, aborted.signal), /abort/i)
})

test('an explicit shell that the remote does not have becomes the first remote shell', async () => {
  const box = harness()
  box.directories.cwd = placeholder
  const request = { shellPath: '/usr/bin/fish', cols: 80 }
  const created = await box.terminal.create(remoteAgent, request, signal)
  assert.equal(created.marker, 'local-controller')
  assert.equal(request.shellPath, '/usr/bin/fish')
  assert.equal(box.terminal.createCalls[0]!.shellPath, '/bin/zsh')

  await box.terminal.create(remoteAgent, { shellPath: '/bin/zsh' }, signal)
  assert.equal(box.terminal.createCalls[1]!.shellPath, '/bin/zsh')

  await box.terminal.create(remoteAgent, { title: 'plain' }, signal)
  assert.equal(box.terminal.createCalls[2]!.shellPath, undefined)
  assert.equal(Object.hasOwn(box.terminal.createCalls[2]!, 'shellPath'), false)

  box.directories.cwd = '/tmp/project'
  await box.terminal.create(remoteAgent, { shellPath: '/usr/bin/fish' }, signal)
  assert.equal(box.terminal.createCalls[3]!.shellPath, '/usr/bin/fish')

  box.directories.cwd = placeholder
  box.core.loadShells = async () => []
  await assert.rejects(() => box.terminal.create(remoteAgent, { shellPath: '/usr/bin/fish' }, signal), /no interactive shell found on the remote host/)
  assert.equal(box.terminal.createCalls.length, 4)
})

test('terminate closes the pty and does not signal TERM', async () => {
  const channel = new FakeChannel()
  const handle = new SshTerminalHandle(channel, () => () => undefined)
  const first = handle.pid
  const second = new SshTerminalHandle(new FakeChannel(), () => () => undefined).pid
  assert.ok(first > 0)
  assert.equal(second, first + 1)

  await handle.write('ls\n')
  await handle.resize(100, 40)
  assert.equal(await handle.inspectForeground(), undefined)
  assert.deepEqual(await handle.inspectActivity(), { state: 'unknown', revision: 2 })
  await handle.signalForeground('INT')
  assert.deepEqual(await handle.inspectActivity(), { state: 'unknown', revision: 2 })
  await handle.terminate()
  assert.deepEqual(channel.signals, ['INT'])
  assert.equal(channel.closed, 1)
  assert.deepEqual(channel.windows, [[40, 100, 0, 0]])
  assert.deepEqual(channel.writes, ['ls\n'])
  assert.deepEqual(await handle.done, { exitCode: 0, signal: null })
  await handle.terminate()
  assert.equal(channel.closed, 2)
  await assert.rejects(() => handle.write('x'), /terminal is closed/)
  await assert.rejects(() => handle.resize(1, 1), /terminal is closed/)
})

test('channel close maps ssh signals and merges stderr into the screen', async () => {
  const hung = new FakeChannel()
  const hup = new SshTerminalHandle(hung, () => () => undefined)
  hung.emitClose(null, 'HUP')
  assert.deepEqual(await hup.done, { exitCode: null, signal: 'SIGHUP' })

  const termed = new FakeChannel()
  const term = new SshTerminalHandle(termed, () => () => undefined)
  termed.emitClose(1, 'TERM')
  assert.deepEqual(await term.done, { exitCode: 1, signal: 'SIGTERM' })

  const named = new FakeChannel()
  const sig = new SshTerminalHandle(named, () => () => undefined)
  named.emitClose(1, 'SIGHUP')
  assert.deepEqual(await sig.done, { exitCode: 1, signal: 'SIGHUP' })

  const junk = new FakeChannel()
  const bad = new SshTerminalHandle(junk, () => () => undefined)
  junk.emitClose(1, 'nope!')
  assert.deepEqual(await bad.done, { exitCode: 1, signal: null })
})

test('screen bytes finish before the transport error is observed', async () => {
  const channel = new FakeChannel()
  let notify: (error: Error) => void = () => undefined
  let unsubscribed = false
  const handle = new SshTerminalHandle(channel, listener => {
    notify = listener
    return () => { unsubscribed = true }
  })
  const collected: Buffer[] = []
  const reading = (async () => {
    for await (const chunk of handle.output) collected.push(Buffer.from(chunk))
  })()
  const exited = handle.done.then(() => undefined, (error: Error) => error)
  channel.emitData(Buffer.from('hi'))
  channel.emitStderr('err')
  notify(new Error('connection closed'))
  channel.emitData('late')
  await reading
  assert.equal(Buffer.concat(collected).toString(), 'hierr')
  const transportError = await exited
  assert.ok(transportError)
  assert.match(transportError.message, /connection closed/)
  assert.equal(unsubscribed, true)
  await handle.terminate()
})

test('a full write buffer resolves on drain, or when the connection dies', async () => {
  const blocking = new BlockingChannel()
  const drained = new SshTerminalHandle(blocking, () => () => undefined)
  let wrote = false
  const writing = drained.write('ls\n').then(() => { wrote = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(wrote, false)
  blocking.release()
  await writing
  assert.equal(wrote, true)

  const stuck = new BlockingChannel()
  let notify: (error: Error) => void = () => undefined
  const handle = new SshTerminalHandle(stuck, listener => {
    notify = listener
    return () => undefined
  })
  const writeError = handle.write('ls\n').then(() => undefined, (error: Error) => error)
  await new Promise(resolve => setImmediate(resolve))
  // A dead transport releases the parked write even though no `drain` arrives.
  notify(new Error('connection closed'))
  const closed = await writeError
  assert.ok(closed)
  assert.match(closed.message, /terminal is closed/)
  await handle.terminate()

  const full = new FullChannel()
  const immediate = new SshTerminalHandle(full, () => () => undefined)
  await immediate.write('x')
  assert.deepEqual(full.writes, ['x'])
})

test('rejecting done without ending output leaves for-await pending', async () => {
  const output = new PassThrough()
  let rejectDone: (error: Error) => void = () => undefined
  const done = new Promise<unknown>((_resolve, reject) => { rejectDone = reject })
  const exited = done.then(() => undefined, (error: Error) => error)
  let finished = false
  const reading = (async () => {
    for await (const _chunk of output) { /* the assertion is that this loop is still parked */ }
    finished = true
  })()
  rejectDone(new Error('transport lost'))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(finished, false)
  output.end()
  await reading
  assert.equal(finished, true)
  const lost = await exited
  assert.ok(lost)
  assert.match(lost.message, /transport lost/)
})

test('close failures settle the handle and terminate still resolves', async () => {
  const channel = new FakeChannel()
  const handle = new SshTerminalHandle(channel, () => () => undefined)
  channel.close = () => { throw new Error('boom') }
  const exited = handle.done.then(() => undefined, (error: Error) => error)
  await handle.terminate()
  const boom = await exited
  assert.ok(boom)
  assert.match(boom.message, /boom/)
})

test('dispose drops the own methods and a second install refuses to wrap again', async () => {
  const box = harness()
  assert.equal(Object.hasOwn(box.subprocess, 'spawnTerminal'), true)
  assert.equal(Object.hasOwn(box.terminal, 'shells'), true)
  assert.equal(Object.hasOwn(box.terminal, 'create'), true)
  const again = installSidebarBridge(box.ctx, box.core, () => true)
  assert.equal(again, undefined)
  assert.match(box.warnings[0] ?? '', /sidebar bridge already installed/)
  const spawnAgain = installTerminalSpawnBridge(box.ctx, box.core)
  assert.equal(spawnAgain, undefined)
  assert.match(box.warnings[1] ?? '', /terminal spawn bridge already installed/)
  await box.subprocess.spawnTerminal(sidebarSpec(placeholder))
  assert.equal(box.pty.length, 1)
  assert.equal(box.subprocess.calls.length, 0)

  box.remove()
  box.remove()
  assert.equal(Object.hasOwn(box.subprocess, 'spawnTerminal'), false)
  assert.equal(Object.hasOwn(box.terminal, 'shells'), false)
  assert.equal(Object.hasOwn(box.terminal, 'create'), false)
  const local = await box.subprocess.spawnTerminal(sidebarSpec(placeholder))
  assert.equal(local.marker, 'local-runtime')
  assert.equal(box.pty.length, 1)

  const restored = installSidebarBridge(box.ctx, box.core, () => true)
  assert.equal(typeof restored, 'function')
  const restoredSpawn = installTerminalSpawnBridge(box.ctx, box.core)
  assert.equal(typeof restoredSpawn, 'function')
  restored!()
  restoredSpawn!()
})

test('an own spawnTerminal does not block the sidebar hooks', () => {
  const terminal = new Terminals()
  const subprocess = new LocalSpawn()
  subprocess.spawnTerminal = subprocess.spawnTerminal.bind(subprocess)
  const warnings: string[] = []
  const ctx = {
    get(name: string) {
      if (name === 'terminalController') return terminal
      if (name === 'subprocess') return subprocess
      if (name === 'workingDirectory') return new Directories()
      return undefined
    },
    logger: { warn(message: string) { warnings.push(message) } },
  }
  const remove = installSidebarBridge(ctx, harness().core, () => true)
  assert.equal(typeof remove, 'function')
  assert.equal(Object.hasOwn(terminal, 'shells'), true)
  const spawn = installTerminalSpawnBridge(ctx, harness().core)
  assert.equal(spawn, undefined)
  assert.match(warnings[0] ?? '', /terminal spawn bridge already installed/)
  remove!()
})

test('an own shell method blocks the sidebar install before any other method is wrapped', () => {
  const terminal = new Terminals()
  terminal.shells = terminal.shells.bind(terminal)
  const warnings: string[] = []
  const remove = installSidebarBridge({
    get(name: string) {
      if (name === 'terminalController') return terminal
      if (name === 'workingDirectory') return new Directories()
      return undefined
    },
    logger: { warn(message: string) { warnings.push(message) } },
  }, harness().core, () => true)
  assert.equal(remove, undefined)
  assert.match(warnings[0] ?? '', /sidebar bridge already installed/)
  assert.equal(Object.hasOwn(terminal, 'create'), false)
})

test('a missing terminal service warns and does not install', () => {
  const warnings: string[] = []
  const remove = installSidebarBridge({
    get: () => undefined,
    logger: { warn(message: string) { warnings.push(message) } },
  }, harness().core, () => true)
  assert.equal(remove, undefined)
  assert.match(warnings[0] ?? '', /missing terminalController or workingDirectory/)
})

test('the bridges write through symbols.original, not the proxy', () => {
  const subprocess = new LocalSpawn()
  const terminal = new Terminals()
  const directories = new Directories()
  const overlay = new Map<PropertyKey, unknown>()
  const proxy = new Proxy(subprocess, {
    get(target, prop, receiver) {
      if (prop === symbols.original) return target
      if (overlay.has(prop)) return overlay.get(prop)
      return Reflect.get(target, prop, receiver)
    },
    set(_target, prop, value) {
      overlay.set(prop, value)
      return true
    },
  })
  const ctx = {
    get(name: string) {
      if (name === 'subprocess') return proxy
      if (name === 'terminalController') return terminal
      if (name === 'workingDirectory') return directories
      return undefined
    },
  }
  const sidebar = installSidebarBridge(ctx, harness().core, () => true)
  const spawn = installTerminalSpawnBridge(ctx, harness().core)
  assert.equal(typeof sidebar, 'function')
  assert.equal(typeof spawn, 'function')
  assert.equal(Object.hasOwn(subprocess, 'spawnTerminal'), true)
  assert.equal(overlay.has('spawnTerminal'), false)
  assert.equal(Object.hasOwn(terminal, 'shells'), true)
  sidebar!()
  spawn!()
})

test('apply installs the bridge when the terminal services appear', async () => {
  const ctx = new Context()
  ctx.provide('settings', {
    configure: () => () => undefined,
    describe: () => [],
    update: async () => undefined,
  })
  ctx.provide('workspaceRegistry', {
    list: () => [],
    create: async () => { throw new Error('unused') },
    delete: async () => false,
  })
  apply(ctx, { hosts: [host()], maxConnections: 2 })
  const terminal = new Terminals()
  const subprocess = new LocalSpawn()
  const directories = new Directories()
  ctx.provide('terminalController', terminal)
  ctx.provide('subprocess', subprocess)
  ctx.provide('workingDirectory', directories)
  const shellsReady = Date.now()
  while (!Object.hasOwn(terminal, 'shells')) {
    if (Date.now() - shellsReady > 1000) throw new Error('sidebar bridge was not installed')
    await new Promise(resolve => setImmediate(resolve))
  }
  await new Promise(resolve => setImmediate(resolve))
  // The terminal spawn bridge depends only on `subprocess`; it must be ready
  // before the sandbox inject arrives, because sidebar terminals do not use it.
  assert.equal(Object.hasOwn(subprocess, 'spawnTerminal'), true)
  ctx.provide('sandbox', {})
  const started = Date.now()
  while (!Object.hasOwn(subprocess, 'spawnTerminal')) {
    if (Date.now() - started > 1000) throw new Error('terminal spawn bridge was not installed')
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(Object.hasOwn(terminal, 'shells'), true)
  assert.equal(Object.hasOwn(terminal, 'create'), true)

  const live = ctx.get('subprocess') as unknown as LocalSpawn
  await assert.rejects(() => live.spawnTerminal(sidebarSpec(remotePlaceholder('/remote/src', 'gone'))), /unknown SSH host gone/)
  assert.equal(subprocess.calls.length, 0)
  const local = await live.spawnTerminal(sidebarSpec('/tmp/project'))
  assert.equal(local.marker, 'local-runtime')
  assert.equal(subprocess.calls.length, 1)

  directories.cwd = '/tmp/project'
  const shells = await terminal.shells({ session: {} }, signal)
  assert.equal(shells[0]!.path, '/bin/local-zsh')
  assert.equal(terminal.shellCalls.length, 1)
})

class PausableChannel extends FakeChannel {
  paused = 0
  resumed = 0
  private drain: (() => void) | undefined

  override write(data: string): boolean {
    super.write(data)
    // The first write always reports a full buffer, so the reader must pause.
    return false
  }

  once(_event: 'drain', listener: () => void): void {
    this.drain = listener
  }

  pause(): void {
    this.paused += 1
  }

  resume(): void {
    this.resumed += 1
  }

  releaseDrain(): void {
    this.drain?.()
  }
}

test('terminate closes the channel before waiting for blocked writes', async () => {
  // A remote program that never reads stdin keeps the window full, so `write`
  // parks on `drain` forever. `close()` is the only thing that can release it,
  // and it must therefore run first; otherwise closing the tab hangs.
  const channel = new BlockingChannel()
  const handle = new SshTerminalHandle(channel, () => () => undefined)
  const writing = handle.write('a large paste').then(() => 'resolved', (error: Error) => error)
  await new Promise(resolve => setImmediate(resolve))
  const terminating = handle.terminate()
  const outcome = await Promise.race([
    terminating.then(() => 'terminate resolved'),
    new Promise(resolve => setTimeout(() => resolve('terminate still hanging'), 500)),
  ])
  assert.equal(outcome, 'terminate resolved')
  assert.equal(channel.closed, 1)
  const writeResult = await writing
  assert.ok(writeResult instanceof Error)
  assert.match(writeResult.message, /terminal is closed/)
})

test('a slow screen reader pauses the channel and resumes it on drain', async () => {
  const channel = new PausableChannel()
  const handle = new SshTerminalHandle(channel, () => () => undefined)
  // Stop reading so the PassThrough buffer fills up.
  handle.output.pause()
  for (let i = 0; i < 400; i += 1) channel.emitData(Buffer.alloc(64 * 1024, 0x61))
  assert.equal(channel.paused > 0, true, 'the channel must be paused once the buffer is full')
  const pausedBefore = channel.paused
  const resumedBefore = channel.resumed
  const collected: Buffer[] = []
  handle.output.on('data', chunk => collected.push(Buffer.from(chunk)))
  handle.output.resume()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(channel.resumed > resumedBefore, true, 'draining the buffer must resume the channel')
  assert.equal(channel.paused, pausedBefore)
  channel.emitClose(0, null)
  await handle.terminate()
  assert.ok(Buffer.concat(collected).length > 0)
})

test('a closed handle stops pausing the channel', async () => {
  const channel = new PausableChannel()
  const handle = new SshTerminalHandle(channel, () => () => undefined)
  handle.output.pause()
  channel.emitData(Buffer.alloc(64 * 1024, 0x61))
  channel.emitClose(0, null)
  await handle.terminate()
  const pausedAfter = channel.paused
  channel.emitData(Buffer.alloc(64 * 1024, 0x62))
  assert.equal(channel.paused, pausedAfter)
})

test('a full channel-open failure names the sshd session limit', () => {
  // OpenSSH sends reason 2 and the default description "open failed" when
  // session_open fails. The packet does not say what MaxSessions is set to.
  const limited = channelLimitMessage(new Error('(SSH) Channel open failure: open failed'))
  assert.ok(limited)
  assert.equal(limited.message.includes('10'), false)
  assert.match(limited.message, /File transfer and remote commands/)
  assert.match(limited.message, /MaxSessions/)
  assert.equal(limited.stage, 'pty')

  assert.equal(channelLimitMessage(new Error('(SSH) Channel open failure: administratively prohibited')), undefined)
  assert.equal(channelLimitMessage(new Error('All configured authentication methods failed')), undefined)
  assert.equal(channelLimitMessage(new SshFailure('pty allocation aborted', 'pty')), undefined)
  assert.equal(channelLimitMessage('not an error'), undefined)
})

test('sidebar spawn creates a missing placeholder before ensure falls back', async () => {
  const root = remotePlaceholder('/remote/src')
  mkdirSync(root, { recursive: true })
  const nested = join(root, 'lib')
  assert.equal(existsSync(nested), false)
  const directories = new Directories()
  directories.cwd = nested
  const subprocess = new LocalSpawn()
  const terminal = new EnsuringController(directories, subprocess)
  const box = harness({ terminal, directories, subprocess })
  assert.equal(Object.hasOwn(terminal, 'spawn'), true)

  await terminal.spawn({ session: { header: { cwd: root } } }, {}, { cols: 80, rows: 24 }, signal)

  assert.equal(isDirectory(nested), true)
  assert.deepEqual(terminal.fallbacks, [])
  assert.equal(box.pty.length, 1)
  assert.equal(box.pty[0]!.command, sidebarCommand('/remote/src/lib', ['/bin/zsh', '-l', '-i'], { DSH_SESSION_ID: 'sess-remote' }))
  box.remove!()
  assert.equal(Object.hasOwn(terminal, 'spawn'), false)
})

test('a placeholder that cannot be created still opens at the restored root', async () => {
  const root = remotePlaceholder('/remote/src')
  mkdirSync(root, { recursive: true })
  const blocked = join(root, 'not-a-directory')
  writeFileSync(blocked, 'x')
  const nested = join(blocked, 'lib')
  const directories = new Directories()
  directories.cwd = nested
  const subprocess = new LocalSpawn()
  const terminal = new EnsuringController(directories, subprocess)
  const box = harness({ terminal, directories, subprocess })

  await terminal.spawn({ session: { header: { cwd: root } } }, {}, { cols: 80, rows: 24 }, signal)

  assert.deepEqual(terminal.fallbacks, [nested])
  assert.equal(existsSync(nested), false)
  assert.equal(box.pty.length, 1)
  assert.equal(box.pty[0]!.command, sidebarCommand('/remote/src', ['/bin/zsh', '-l', '-i'], { DSH_SESSION_ID: 'sess-remote' }))
})

test('a non-positive tpgid signals the recorded pid and a stale start time signals nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pty-id-'))
  const dir = join(home, '.dsh-permission-remote', 'pty')
  mkdirSync(dir, { recursive: true })
  const id = '0123456789abcdef'
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  try {
    const pid = child.pid!
    const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).stdout.trim()
    assert.ok(started.length > 0)
    writeFileSync(join(dir, `${id}.pid`), `${pid}\n${started}\n`)
    const prelude = [
      'ps() {',
      '  if [ "$1" = "-o" ] && [ "$2" = "lstart=" ]; then command ps "$@"; return; fi',
      '  if [ "$1" = "-o" ] && [ "$2" = "tpgid=" ]; then printf "%s\\n" -1; return; fi',
      '  command ps "$@"',
      '}',
      'kill() { printf "KILL %s\\n" "$*"; }',
    ].join('\n')
    const signaled = spawnSync('bash', ['--noprofile', '--norc', '-c', `${prelude}\n${signalProbeCommand(id, 'SIGTERM')}`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    })
    assert.equal(signaled.status, 0, signaled.stderr)
    assert.match(signaled.stdout, new RegExp(`KILL -s TERM -- -${pid}`))
    // A pid starting with "1" makes a plain substring check pass for the wrong
    // reason: `-- -12345` contains `-- -1`. Match the whole group argument.
    assert.doesNotMatch(signaled.stdout, /-- -1(?!\d)/)
    assert.equal(spawnSync('ps', ['-p', String(pid)]).status, 0)

    const miss = prelude.replace(
      'kill() { printf "KILL %s\\n" "$*"; }',
      'kill() { printf "MISS %s\\n" "$*"; return 1; }',
    )
    const missed = spawnSync('bash', ['--noprofile', '--norc', '-c', `${miss}\n${signalProbeCommand(id, 'SIGTERM')}`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    })
    // A non-SIGINT miss is reported as a failure so `terminal_signal` never
    // claims a delivery that did not happen.
    assert.equal(missed.status, 1)
    assert.match(missed.stdout, new RegExp(`MISS -s TERM -- -${pid}`))
    assert.equal(spawnSync('ps', ['-p', String(pid)]).status, 0)

    writeFileSync(join(dir, `${id}.pid`), `${pid}\nnot-the-start\n`)
    const stale = spawnSync('bash', ['--noprofile', '--norc', '-c', signalProbeCommand(id, 'SIGTERM')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    })
    assert.equal(stale.status, 1)
    assert.equal(spawnSync('ps', ['-p', String(pid)]).status, 0)
  } finally {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    rmSync(home, { recursive: true, force: true })
  }
})

test('SIGKILL targeting the shell group is refused before kill', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pty-kill-guard-'))
  const dir = join(home, '.dsh-permission-remote', 'pty')
  mkdirSync(dir, { recursive: true })
  const id = '0123456789abcdef'
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  try {
    const pid = child.pid!
    const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).stdout.trim()
    writeFileSync(join(dir, `${id}.pid`), `${pid}\n${started}\n`)
    const prelude = [
      'ps() {',
      '  if [ "$1" = "-o" ] && [ "$2" = "lstart=" ]; then command ps "$@"; return; fi',
      '  if [ "$1" = "-o" ] && [ "$2" = "tpgid=" ]; then printf "%s\\n" "$4"; return; fi',
      '  command ps "$@"',
      '}',
      'kill() { printf "KILL %s\\n" "$*"; return 0; }',
    ].join('\n')
    const refused = spawnSync('bash', ['--noprofile', '--norc', '-c', `${prelude}\n${signalProbeCommand(id, 'SIGKILL')}`], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    })
    assert.equal(refused.status, 42, refused.stderr)
    assert.match(refused.stderr, /refusing to SIGKILL the terminal shell/)
    assert.doesNotMatch(refused.stdout, /KILL/)
  } finally {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    rmSync(home, { recursive: true, force: true })
  }
})

test('tree termination signals descendants and then the recorded process', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pty-tree-'))
  const dir = join(home, '.dsh-permission-remote', 'pty')
  mkdirSync(dir, { recursive: true })
  const id = 'fedcba9876543210'
  const leader = spawn('bash', ['--noprofile', '--norc', '-c', 'sleep 30 & sleep 30 & wait'], { detached: true, stdio: 'ignore' })
  const pid = leader.pid!
  try {
    const children = await sleepChildren(pid, 2)
    assert.equal(children.length >= 2, true)
    const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } }).stdout.trim()
    writeFileSync(join(dir, `${id}.pid`), `${pid}\n${started}\n`)
    const killed = spawnSync('bash', ['--noprofile', '--norc', '-c', treeSignalCommand(id, 'SIGTERM')], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    })
    assert.equal(killed.status, 0, `${killed.stderr}\n${killed.stdout}`)
    // `ps -p` still sees a zombie while this process is blocked inside spawnSync
    // and has not reaped the child. The exit event is the reap.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('recorded process stayed alive')), 1_000)
      leader.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    const deadline = Date.now() + 1_000
    let left = children.filter(alive)
    while (left.length > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
      left = children.filter(alive)
    }
    assert.deepEqual(left, [])
  } finally {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // The tree signal already collected the group.
    }
    rmSync(home, { recursive: true, force: true })
  }
})

test('one model terminal abort does not close another terminal probe', async () => {
  class FakeProbePool {
    opens = 0
    async openEval(this: FakeProbePool, _host: unknown, _secret: unknown, command: string) {
      this.opens += 1
      const mark = /DSHPROBE[a-f0-9]{16}/u.exec(command)?.[0] ?? 'DSHPROBE0000000000000000'
      const stdout = new PassThrough()
      return {
        stdout,
        write(data: string) {
          if (data.includes('sleep 100')) {
            setTimeout(() => stdout.write(`\n${mark} 0\n`), 10)
            return
          }
          stdout.write(`\n${mark} 0\n`)
        },
        close() {
          stdout.end()
        },
      }
    }
    async exec() {
      return { code: 0, stdout: '55\n' }
    }
  }
  const pool = new FakeProbePool()
  const core = {
    requireHost: () => host(),
    secret: async () => ({}),
    allowsRemoteSession: () => true,
    pool,
  }
  const a = probeExecutor(core as never, host(), {})
  const b = probeExecutor(core as never, host(), {})
  const controller = new AbortController()
  const pending = a.exec('sleep 100', 5_000, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, /abort/i)
  // Let the aborted command's marker arrive; the shared channel must drain it
  // before trusting the next command's status.
  await new Promise(resolve => setTimeout(resolve, 20))
  const result = await b.exec('printf hi', 2_000)
  assert.equal(result.code, 0)
  assert.equal(pool.opens, 1)
  closeSharedProbes()
})

test('a probe timeout reports the timeout, not a closed channel', async () => {
  const mark = 'DSHPROBEabcdef0123456789'
  const stdout = new PassThrough()
  const channel = new ProbeChannel({
    stdout,
    write: () => undefined,
    close: () => stdout.end(),
  }, mark)
  await assert.rejects(() => channel.exec('noop', 10), /probe channel timed out/)
})

test('closing a probe with a partial marker rejects the pending exec promptly', async () => {
  const mark = 'DSHPROBEabcdef0123456789'
  const stdout = new PassThrough()
  const channel = new ProbeChannel({
    stdout,
    write: () => undefined,
    close: () => stdout.end(),
  }, mark)
  const pending = channel.exec('noop', 5_000)
  stdout.write(`\n${mark} `)
  channel.close()
  await assert.rejects(pending, /probe channel is closed/)
})

test('one probe shell answers several commands without a new process', async () => {
  const mark = 'DSHPROBEabcdef0123456789'
  const child = spawn('bash', ['--noprofile', '--norc', '-c', probeLoopScript(mark)], { stdio: ['pipe', 'pipe', 'pipe'] })
  const channel = new ProbeChannel({
    stdout: child.stdout!,
    write: data => {
      child.stdin!.write(data)
    },
    close: () => child.kill(),
  }, mark)
  try {
    const hello = await channel.exec("printf '%s\\n' hello", 2000)
    assert.equal(hello.code, 0)
    assert.equal(hello.stdout, 'hello\n')
    const failed = await channel.exec('echo no; exit 7', 2000)
    assert.equal(failed.code, 7)
    assert.equal(failed.stdout, 'no\n')
    assert.equal(child.exitCode, null)
    assert.match(probeShellCommand(mark), /^sh -c '/)
  } finally {
    channel.close()
  }
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Direct `sleep` children of `parent`. The leader's own command line also mentions sleep, so match ppid. */
async function sleepChildren(parent: number, needed: number): Promise<number[]> {
  const deadline = Date.now() + 1_000
  let found: number[] = []
  while (Date.now() < deadline) {
    found = spawnSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).stdout
      .split('\n')
      .map(line => line.trim().split(/\s+/u))
      .filter(parts => parts[1] === String(parent) && parts[2] === 'sleep')
      .map(parts => Number(parts[0]))
      .filter(pid => Number.isInteger(pid))
    if (found.length >= needed) return found
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return found
}

test('the sidebar spawn wrapper forwards every argument across DSH versions', async () => {
  class Forwarding extends Terminals {
    readonly seen: unknown[][] = []
    async spawn(...args: unknown[]): Promise<string> {
      this.seen.push(args)
      return 'ok'
    }
  }
  const terminal = new Forwarding()
  const directories = new Directories()
  const ctx = {
    get(name: string) {
      if (name === 'terminalController') return terminal
      if (name === 'workingDirectory') return directories
      return undefined
    },
    logger: { warn() { /* noop */ } },
  }
  const core = { requireHost: () => host(), secret: async () => ({}), loadShells: async () => [], pool: {} } as never
  const remove = installSidebarBridge(ctx as never, core, () => true)
  const signal = new AbortController().signal
  // DSH 0.2.2-rc.2: spawn(agent, owner, id, prepare, signal)
  await (terminal as unknown as { spawn(...args: unknown[]): Promise<unknown> }).spawn({ session: {} }, {}, 'id', async () => undefined, signal)
  assert.equal(terminal.seen[0]!.length, 5)
  assert.equal(terminal.seen[0]![4], signal)
  // DSH 0.2.2-rc.1: spawn(agent, owner, request, signal)
  await (terminal as unknown as { spawn(...args: unknown[]): Promise<unknown> }).spawn({ session: {} }, {}, {}, signal)
  assert.equal(terminal.seen[1]!.length, 4)
  assert.equal(terminal.seen[1]![3], signal)
  remove?.()
})

test('a failed non-SIGINT foreground probe is not reported as delivered', async () => {
  const handle = new ModelTerminalHandle(new FakeChannel(), () => () => undefined, '0123456789abcdef', 0, {
    async exec(command: string) {
      if (command.includes('kill ')) throw new Error('probe failed')
      return { code: 0, stdout: '55\n' }
    },
  }, 0)
  await handle.capturePid()
  await assert.rejects(() => handle.signalForeground('SIGTERM'), /foreground group is not visible/)
  assert.equal(await handle.signalForeground('SIGINT'), 55)
})

test('the shells wrapper tolerates a missing signal like the upstream RPC', async () => {
  class StrictShells extends Terminals {
    async shells(agent: { session?: object }, signal: AbortSignal): Promise<SidebarShell[]> {
      // Mirrors upstream `TerminalController.shells`: it dereferences signal.
      signal.throwIfAborted()
      return []
    }
  }
  const box = harness({ terminal: new StrictShells() })
  box.directories.cwd = placeholder
  const shells = await (box.terminal as unknown as { shells(agent: object): Promise<SidebarShell[]> }).shells({ session: {} })
  assert.deepEqual(shells.map(shell => shell.path), ['/bin/zsh'])
  box.remove()
})
