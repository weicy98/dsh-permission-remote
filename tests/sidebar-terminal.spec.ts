import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { Context, symbols } from '@deepseek-ai/cordis'
import type { HostConfig } from '../src/config.ts'
import { apply } from '../src/index.ts'
import { mapRemoteToLocal } from '../src/router.ts'
import {
  installSidebarBridge,
  isSidebarTerminal,
  parseShellProbe,
  shellProbeCommand,
  sidebarCommand,
  SshTerminalHandle,
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

  async spawn(agent: { session?: { header?: { cwd?: string } } }, _owner: unknown, request: { cols?: number, rows?: number }, signal: AbortSignal): Promise<unknown> {
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
  const gate: { error?: Error } = {}
  const remoteShells: SidebarShell[] = [{ path: '/bin/zsh', name: 'lo · zsh', args: ['-l', '-i'] }]
  const core: SidebarCore = {
    requireHost(hostId: string) {
      if (hostId !== 'host1') throw new Error(`unknown SSH host ${hostId}`)
      return host()
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
  const remove = installSidebarBridge(ctx, core)
  return { terminal, subprocess, directories, core, pty, warnings, remove, ctx, gate, remoteShells }
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
  assert.equal(sidebarCommand("/remote/o's", ['/bin/zsh', '-l', '-i']), "cd '/remote/o'\\''s' && exec '/bin/zsh' '-l' '-i'")
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
  assert.equal(box.pty[0]!.command, "cd '/remote/src' && exec '/bin/zsh' '-l' '-i'")
  assert.equal(box.pty[0]!.term, 'xterm-256color')
  assert.equal(box.pty[0]!.cols, 100)
  assert.equal(box.pty[0]!.rows, 40)
  assert.equal(JSON.stringify(box.pty[0]).includes('DSH_SESSION_ID'), false)

  const nested = remotePlaceholder('/remote/src')
  await box.subprocess.spawnTerminal(sidebarSpec(`${nested}/lib`))
  assert.equal(box.pty[1]!.command, "cd '/remote/src/lib' && exec '/bin/zsh' '-l' '-i'")

  const quoted = remotePlaceholder("/remote/o's")
  await box.subprocess.spawnTerminal(sidebarSpec(quoted))
  assert.equal(box.pty[2]!.command, "cd '/remote/o'\\''s' && exec '/bin/zsh' '-l' '-i'")
  assert.equal(box.subprocess.calls.length, 0)
})

test('an env block on the spec is not forwarded to the remote shell', async () => {
  const box = harness()
  const spec = { ...sidebarSpec(placeholder), env: { DSH_SESSION_ID: 'sess' } }
  await box.subprocess.spawnTerminal(spec)
  assert.equal(JSON.stringify(box.pty[0]).includes('DSH_SESSION_ID'), false)
  assert.equal(JSON.stringify(box.pty[0]).includes('sess'), false)
})

test('local directories and dumb ptys stay on the local runtime', async () => {
  const box = harness()
  const local = await box.subprocess.spawnTerminal(sidebarSpec('/tmp/project'))
  assert.equal(local.marker, 'local-runtime')
  const dumb = await box.subprocess.spawnTerminal(sidebarSpec(placeholder, { terminalType: 'dumb' }))
  assert.equal(dumb.marker, 'local-runtime')
  const quiet = await box.subprocess.spawnTerminal(sidebarSpec(placeholder, { shellActivity: false }))
  assert.equal(quiet.marker, 'local-runtime')
  assert.equal(box.pty.length, 0)
  assert.equal(box.subprocess.calls.length, 3)
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
  const again = installSidebarBridge(box.ctx, box.core)
  assert.equal(again, undefined)
  assert.match(box.warnings[0] ?? '', /sidebar bridge already installed/)
  await box.subprocess.spawnTerminal(sidebarSpec(placeholder))
  assert.equal(box.pty.length, 1)
  assert.equal(box.subprocess.calls.length, 0)

  assert.equal(typeof box.remove, 'function')
  box.remove!()
  box.remove!()
  assert.equal(Object.hasOwn(box.subprocess, 'spawnTerminal'), false)
  assert.equal(Object.hasOwn(box.terminal, 'shells'), false)
  assert.equal(Object.hasOwn(box.terminal, 'create'), false)
  const local = await box.subprocess.spawnTerminal(sidebarSpec(placeholder))
  assert.equal(local.marker, 'local-runtime')
  assert.equal(box.pty.length, 1)

  const restored = installSidebarBridge(box.ctx, box.core)
  assert.equal(typeof restored, 'function')
  restored!()
})

test('an own method on one service blocks the install before any other method is wrapped', () => {
  const terminal = new Terminals()
  const subprocess = new LocalSpawn()
  subprocess.spawnTerminal = subprocess.spawnTerminal.bind(subprocess)
  const warnings: string[] = []
  const remove = installSidebarBridge({
    get(name: string) {
      if (name === 'terminalController') return terminal
      if (name === 'subprocess') return subprocess
      if (name === 'workingDirectory') return new Directories()
      return undefined
    },
    logger: { warn(message: string) { warnings.push(message) } },
  }, harness().core)
  assert.equal(remove, undefined)
  assert.match(warnings[0] ?? '', /sidebar bridge already installed/)
  assert.equal(Object.hasOwn(terminal, 'shells'), false)
  assert.equal(Object.hasOwn(terminal, 'create'), false)
})

test('a missing terminal service warns and does not install', () => {
  const warnings: string[] = []
  const remove = installSidebarBridge({
    get: () => undefined,
    logger: { warn(message: string) { warnings.push(message) } },
  }, harness().core)
  assert.equal(remove, undefined)
  assert.match(warnings[0] ?? '', /missing terminalController, subprocess, or workingDirectory/)
})

test('the bridge writes through symbols.original, not the proxy', () => {
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
  const remove = installSidebarBridge({
    get(name: string) {
      if (name === 'subprocess') return proxy
      if (name === 'terminalController') return terminal
      if (name === 'workingDirectory') return directories
      return undefined
    },
  }, harness().core)
  assert.equal(typeof remove, 'function')
  assert.equal(Object.hasOwn(subprocess, 'spawnTerminal'), true)
  assert.equal(overlay.has('spawnTerminal'), false)
  remove!()
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
  const started = Date.now()
  while (!Object.hasOwn(subprocess, 'spawnTerminal')) {
    if (Date.now() - started > 1000) throw new Error('sidebar bridge was not installed')
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(Object.hasOwn(terminal, 'shells'), true)
  assert.equal(Object.hasOwn(terminal, 'create'), true)

  const live = ctx.get('subprocess') as LocalSpawn
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
  assert.equal(box.pty[0]!.command, sidebarCommand('/remote/src/lib', ['/bin/zsh', '-l', '-i']))
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
  assert.equal(box.pty[0]!.command, sidebarCommand('/remote/src', ['/bin/zsh', '-l', '-i']))
})
