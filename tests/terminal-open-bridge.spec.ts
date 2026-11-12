/**
 * Official `BashTerminalBackend.spawn` through the remote `spawnTerminal` bridge.
 *
 * The backend is the installed `@deepseek-ai/dsh-terminal-bash`. It confines
 * the argv, calls `subprocess.spawnTerminal`, and wraps the handle in
 * `LocalPtySession`. A missing install skips the file unless
 * `DSH_REQUIRE_OFFICIAL_TOOLS=1`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'

import { mapRemoteToLocal } from '../src/router.ts'
import { installTerminalSpawnBridge, type SidebarSpawnSpec } from '../src/sidebar-terminal.ts'
import { resolveFromDshInstall } from './helpers/dsh-install.ts'
import type { PtyRequest } from '../src/ssh-pool.ts'

const root = mkdtempSync(join(tmpdir(), 'dsh-terminal-bridge-'))
process.env.DSH_SSH_REMOTE_ROOT = root

class LocalSpawn {
  async spawnTerminal(spec: SidebarSpawnSpec): Promise<{ marker: string, spec: SidebarSpawnSpec }> {
    return { marker: 'local', spec }
  }
}

let Backend: new (...args: any[]) => { spawn(spec: any): Promise<{ pid: number, close(reason: string): Promise<void> }> }
try {
  const href = pathToFileURL(resolveFromDshInstall('@deepseek-ai/dsh-terminal-bash')).href
  Backend = (await import(href)).BashTerminalBackend
} catch {
  Backend = undefined as never
}

const REQUIRE_OFFICIAL = process.env.DSH_REQUIRE_OFFICIAL_TOOLS === '1'
const skip = Backend === undefined && !REQUIRE_OFFICIAL
  ? 'official dsh-terminal-bash could not be loaded from the installed DSH'
  : false

test('official terminal spawn reaches a model pty and a live session', { skip, timeout: 15_000 }, async () => {
  if (Backend === undefined) throw new Error('official dsh-terminal-bash could not be loaded from the installed DSH')
  const placeholder = mapRemoteToLocal('host1', '/srv/app')
  assert.ok(placeholder)
  const pty: PtyRequest[] = []
  const evalOpens: string[] = []
  const evalWrites: string[] = []
  let screen: { emitData(chunk: string): void } | undefined
  let prompted = false
  let execs = 0
  const subprocess = new LocalSpawn()
  class FakePool {
    opens = 0
    async openPty(_host: unknown, _secret: unknown, request: PtyRequest) {
      pty.push(request)
      const channel = new FakeScreen()
      screen = channel
      return { channel, onTransportClosed: () => () => undefined }
    }
    async exec(_host: unknown, _secret: unknown, command: string) {
      execs += 1
      return { code: 0, stdout: command.includes('ps -o lstart=') ? '4242\n' : '' }
    }
    async openEval(_host: unknown, _secret: unknown, command: string) {
      this.opens += 1
      evalOpens.push(command)
      const mark = /DSHPROBE[a-f0-9]{16}/u.exec(command)?.[0] ?? 'DSHPROBE0000000000000000'
      const stdout = new PassThrough()
      return {
        stdout,
        write(data: string) {
          evalWrites.push(data)
          const foreground = data.includes('tpgid=')
          const body = foreground ? '77\n' : '4242\n'
          // The real shell prints its prompt once. Emitting it on every
          // foreground poll resets the session's idle clock and startup never settles.
          if (foreground && !prompted) {
            prompted = true
            screen?.emitData('\u001b]133;D;0\u0007dsh> ')
          }
          stdout.write(`${body}\n${mark} 0\n`)
        },
        close() {
          stdout.end()
        },
      }
    }
  }
  const pool = new FakePool()
  const core = {
    requireHost(hostId: string) {
      if (hostId !== 'host1') throw new Error(`unknown SSH host ${hostId}`)
      return { id: hostId, name: 'lo', host: '10.0.0.8', port: 22, username: 'me', auth: 'key' as const, privateKeyPath: '', fingerprint: 'SHA256:abc', opsPolicy: 'ask' as const }
    },
    async secret() {
      return {}
    },
    allowsRemoteSession() {
      return true
    },
    pool,
  }
  const remove = installTerminalSpawnBridge({
    get(name: string) {
      return name === 'subprocess' ? subprocess : undefined
    },
  }, core)
  assert.equal(typeof remove, 'function')
  const confined: unknown[] = []
  const ctx = {
    get(name: string) {
      if (name === 'sandbox') {
        return {
          async confine(argv: readonly string[]) {
            confined.push([...argv])
            return { argv: ['bwrap', '--unshare-pid', '--', ...argv] }
          },
        }
      }
      return undefined
    },
    sandboxPolicy: {
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: '/srv/app' }),
      overrideOf: () => undefined,
      defaultMode: 'workspace-write',
    },
    terminals: { hasOwnerActivity: () => false },
    subprocess,
    workingDirectory: { ensure: async () => placeholder },
  }
  const backend = new Backend(ctx, {
    backendType: 'shell',
    shellDialect: 'bash',
    shellPath: '/bin/bash',
    shellArgs: ['--noprofile', '--norc', '-i'],
    rows: 24,
    cols: 80,
    scrollbackLines: 100,
    scrollbackMaxBytes: 100_000,
    maxReadBytes: 10_000,
    pollIntervalMs: 50,
    exactProbeAfterMs: 1_000,
    idleSilenceMs: 1_000,
    handoffGraceMs: 50,
    promptTailGraceMs: 0,
    timeoutMs: 8_000,
    disposeGraceMs: 20,
  })
  try {
    const session = await backend.spawn({
      type: 'shell',
      cwd: placeholder,
      sessionId: 'pty-1',
      owner: {
        id: 'agent-1',
        session: { id: 'sess-1' },
        ctx: { on: () => () => undefined },
      },
    })
    assert.equal(session.pid, 4242)
    assert.ok(execs >= 1)
    assert.equal(pool.opens, 1)
    assert.equal(evalOpens.length, 1)
    assert.equal(evalWrites.length > 1, true)
    assert.equal(pty.length, 1)
    assert.match(pty[0]!.command, /bwrap/)
    assert.match(pty[0]!.command, /--unshare-pid/)
    assert.ok(pty[0]!.command.includes('TERM=')); assert.ok(pty[0]!.command.includes('dumb'))
    assert.ok(pty[0]!.command.includes('/bin/bash')); assert.ok(pty[0]!.command.includes('--noprofile')); assert.ok(pty[0]!.command.includes('--norc'))
    assert.deepEqual(confined[0], ['/bin/bash', '--noprofile', '--norc', '-i'])
    await session.close('test done')
  } finally {
    remove?.()
    rmSync(root, { recursive: true, force: true })
  }
})

class FakeScreen {
  readonly writes: string[] = []
  closed = 0
  private readonly dataListeners: Array<(chunk: Buffer | string) => void> = []
  private readonly closeListeners: Array<(code?: number | null, signal?: string | null) => void> = []
  readonly stderr = { on: () => undefined }

  on(event: 'data' | 'close', listener: (...args: any[]) => void): void {
    if (event === 'data') this.dataListeners.push(listener)
    else this.closeListeners.push(listener)
  }

  emitData(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk)
  }

  write(data: string): boolean {
    this.writes.push(data)
    return true
  }

  setWindow(): void {}

  signal(): void {}

  close(): void {
    this.closed += 1
    for (const listener of this.closeListeners) listener(0, null)
  }
}
