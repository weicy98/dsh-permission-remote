import { readFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { Client, type ConnectConfig } from 'ssh2'
import type { HostConfig } from './config.ts'
import { claimPending } from './pool-claim.ts'
import { shJoin } from './shell-quote.ts'

const OUTPUT_CAP = 1024 * 1024

/** Decode one SSH chunk. Incomplete UTF-8 stays in `decoder` until the next chunk or `end()`. */
export function takeChannelText(decoder: StringDecoder, chunk: Buffer): string {
  return decoder.write(chunk)
}

/** The live log emits the truncation line once, whichever stream hits the cap first. */
export function truncationMarker(noted: { current: boolean }): string {
  if (noted.current) return ''
  noted.current = true
  return '\n[output truncated]'
}

export interface ExecResult {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

/** One remote command on its own SSH channel. `close` kills that channel only. */
export interface RemoteCommand {
  readonly done: Promise<ExecResult>
  close(): void
}

export interface CommandChunk {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

export interface DirEntry {
  readonly name: string
  readonly path: string
}

export interface SecretMaterial {
  readonly password?: string
  readonly passphrase?: string
}

export class SshFailure extends Error {
  constructor(message: string, readonly stage: string) {
    super(message)
    this.name = 'SshFailure'
  }
}

interface SftpSession {
  readonly api: SftpLike
  end(): void
}

interface Live {
  readonly client: Client
  readonly hostId: string
  sftp?: Promise<SftpSession>
}

const FINGERPRINT_PREFIX = 'SHA256:'

export function formatFingerprint(hashedKey: Buffer): string {
  return `${FINGERPRINT_PREFIX}${hashedKey.toString('base64')}`
}

export class SshPool {
  private readonly live = new Map<string, Promise<Live>>()
  private readonly waiters: Array<() => void> = []
  private active = 0

  constructor(private readonly maxConnections: number) {}

  async dispose(): Promise<void> {
    const pending = [...this.live.values()]
    this.live.clear()
    for (const item of pending) {
      try {
        const live = await item
        await closeLive(live)
      } catch {
        // A failed connect has nothing to close.
      }
    }
  }

  invalidate(hostId: string): void {
    const current = this.live.get(hostId)
    this.live.delete(hostId)
    if (current === undefined) return
    void current.then(live => closeLive(live)).catch(() => undefined)
  }

  async exec(host: HostConfig, secret: SecretMaterial, command: string, timeoutMs: number, signal?: AbortSignal, stdin?: string | Buffer, onOutput?: (chunk: CommandChunk) => void): Promise<ExecResult> {
    const commandHandle = await this.open(host, secret, command, timeoutMs, signal, stdin, onOutput)
    return commandHandle.done
  }

  /** `timeoutMs` of 0 waits until the command exits, the signal aborts, or `close` kills its channel. */
  async open(host: HostConfig, secret: SecretMaterial, command: string, timeoutMs: number, signal?: AbortSignal, stdin?: string | Buffer, onOutput?: (chunk: CommandChunk) => void): Promise<RemoteCommand> {
    const live = await this.acquire(host, secret, true)
    const commandHandle = openChannel(live.client, command, timeoutMs, stdin, onOutput)
    if (signal !== undefined) {
      const abort = () => commandHandle.close()
      if (signal.aborted) commandHandle.close()
      else signal.addEventListener('abort', abort, { once: true })
      void commandHandle.done.finally(() => signal.removeEventListener('abort', abort))
    }
    return commandHandle
  }

  /** Connect far enough to read the host key. Does not persist trust. */
  async offerFingerprint(host: HostConfig, secret: SecretMaterial): Promise<{ fingerprint: string, trusted: boolean, banner: string }> {
    const stored = host.fingerprint.trim()
    let offered = ''
    try {
      const live = await connect(host, secret, (key: Buffer) => {
        offered = formatFingerprint(key)
        return stored.length > 0 && offered === stored
      })
      const banner = await openChannel(live, 'echo ok', 15_000).done
      live.end()
      return { fingerprint: stored, trusted: true, banner: banner.stdout.trim() }
    } catch (error) {
      if (offered.length > 0 && offered !== stored) {
        return { fingerprint: offered, trusted: false, banner: '' }
      }
      throw error
    }
  }

  async sftpRead(host: HostConfig, secret: SecretMaterial, remotePath: string, maxBytes?: number): Promise<Buffer> {
    const session = await this.sftp(host, secret)
    if (maxBytes !== undefined) {
      const size = await statSize(session, remotePath)
      if (size > maxBytes) throw new SshFailure(`file is ${size} bytes, over the ${maxBytes} byte limit`, 'sftp-read')
    }
    return readAll(session, remotePath)
  }

  async sftpWrite(host: HostConfig, secret: SecretMaterial, remotePath: string, body: Buffer | string): Promise<void> {
    const session = await this.sftp(host, secret)
    await writeAll(session, remotePath, body)
  }

  async sftpRealpath(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string> {
    const session = await this.sftp(host, secret)
    return realpathOf(session, remotePath)
  }

  async sftpStat(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<{ isDirectory: boolean, size: number }> {
    const session = await this.sftp(host, secret)
    return statInfo(session, remotePath)
  }

  async sftpList(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<DirEntry[]> {
    const session = await this.sftp(host, secret)
    const rows = await readdir(session, remotePath)
    return rows
      .filter(row => row.attrs.isDirectory())
      .map(row => ({
        name: row.filename,
        path: remotePath === '/' ? `/${row.filename}` : `${remotePath.replace(/\/$/, '')}/${row.filename}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  private async sftp(host: HostConfig, secret: SecretMaterial): Promise<SftpLike> {
    const live = await this.acquire(host, secret, true)
    live.sftp ??= openSftp(live.client).catch(error => {
      live.sftp = undefined
      throw error
    })
    const session = await live.sftp
    return session.api
  }

  async sftpUpload(host: HostConfig, secret: SecretMaterial, localPath: string, remotePath: string): Promise<void> {
    const body = await readFile(localPath)
    const dir = remotePath.slice(0, remotePath.lastIndexOf('/'))
    if (dir.length > 0) {
      await this.exec(host, secret, `mkdir -p ${shJoin([dir])} && chmod 700 ${shJoin([dir])}`, 20_000)
    }
    await this.sftpWrite(host, secret, remotePath, body)
    await this.exec(host, secret, `chmod 755 ${shJoin([remotePath])}`, 15_000)
  }

  private acquire(host: HostConfig, secret: SecretMaterial, requireTrust: boolean): Promise<Live> {
    return claimPending(this.live, host.id, async () => {
      await this.reserve()
      try {
        const client = await connect(host, secret, key => {
          const fingerprint = formatFingerprint(key)
          if (!requireTrust) return true
          return host.fingerprint.trim().length > 0 && host.fingerprint.trim() === fingerprint
        })
        const live: Live = { client, hostId: host.id }
        let released = false
        const drop = () => {
          if (released) return
          released = true
          const current = this.live.get(host.id)
          void current?.then(value => {
            if (value === live) this.live.delete(host.id)
          }).catch(() => undefined)
          void live.sftp?.then(session => session.end()).catch(() => undefined)
          this.release()
        }
        client.on('close', drop)
        client.on('end', drop)
        return live
      } catch (error) {
        this.release()
        throw error
      }
    })
  }

  private reserve(): Promise<void> {
    if (this.active < this.maxConnections) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.waiters.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.active -= 1
    const next = this.waiters.shift()
    if (next !== undefined) next()
  }
}

function connect(host: HostConfig, secret: SecretMaterial, accept: (key: Buffer) => boolean): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    const fail = (error: unknown) => {
      client.end()
      reject(error instanceof Error ? error : new SshFailure(String(error), 'connect'))
    }
    client.once('ready', () => resolve(client))
    client.once('error', fail)
    const options: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.username,
      readyTimeout: 20_000,
      hostHash: 'sha256',
      hostVerifier: (key: Buffer) => accept(key),
    }
    if (host.auth === 'password') {
      if (!secret.password) {
        fail(new SshFailure('password is not stored for this host', 'auth'))
        return
      }
      options.password = secret.password
    } else if (host.privateKeyPath.trim().length > 0) {
      void readFile(host.privateKeyPath).then(key => {
        options.privateKey = key
        if (secret.passphrase) options.passphrase = secret.passphrase
        client.connect(options)
      }).catch(fail)
      return
    }
    client.connect(options)
  })
}

interface ExecStream {
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): void
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void }
  close(): void
  signal?(name: string, callback?: () => void): void
  write(chunk: Buffer | string): boolean
  end(): void
}

function openChannel(client: Client, command: string, timeoutMs: number, stdin?: string | Buffer, onOutput?: (chunk: CommandChunk) => void): RemoteCommand {
  let settled = false
  let cause: 'exit' | 'timeout' | 'cancel' | 'truncate' = 'exit'
  let stream: ExecStream | undefined
  let resolveDone: (result: ExecResult) => void = () => undefined
  let rejectDone: (error: Error) => void = () => undefined
  const done = new Promise<ExecResult>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutTruncated = false
  let stderrTruncated = false
  const decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8'),
  }
  const decoderEnded = { stdout: false, stderr: false }
  const truncationNoted = { current: false }
  const emit = (which: 'stdout' | 'stderr', text: string) => {
    if (text.length === 0 || onOutput === undefined) return
    try {
      onOutput({ stream: which, text })
    } catch {
      // An observer must not tear the channel down.
    }
  }
  const flushDecoder = (which: 'stdout' | 'stderr') => {
    if (decoderEnded[which]) return
    decoderEnded[which] = true
    emit(which, decoders[which].end())
  }
  const markTruncation = (which: 'stdout' | 'stderr') => {
    flushDecoder(which)
    emit(which, truncationMarker(truncationNoted))
  }
  const finish = (code: number | null, signal: string | null) => {
    if (settled) return
    settled = true
    flushDecoder('stdout')
    flushDecoder('stderr')
    clearTimeout(timer)
    clearTimeout(fallback)
    resolveDone({
      code: cause === 'exit' ? code : null,
      signal: cause === 'exit' ? signal : 'KILL',
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut: cause === 'timeout',
      stdoutTruncated,
      stderrTruncated,
    })
  }
  let fallback: ReturnType<typeof setTimeout> | undefined
  const stop = (next: 'timeout' | 'cancel' | 'truncate') => {
    if (settled || cause !== 'exit') return
    cause = next
    if (stream === undefined) {
      finish(null, null)
      return
    }
    try {
      stream.signal?.('KILL', () => undefined)
    } catch {
      // The channel may already be gone.
    }
    try {
      stream.close()
    } catch {
      // Closing a finished channel is the outcome we wanted.
    }
    fallback = setTimeout(() => finish(null, 'KILL'), 2000)
  }
  const timer = timeoutMs > 0 ? setTimeout(() => stop('timeout'), timeoutMs) : undefined
  client.exec(command, (error, opened) => {
    if (error) {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        rejectDone(new SshFailure(error.message, 'exec'))
      }
      return
    }
    stream = opened as unknown as ExecStream
    const push = (target: Buffer[], chunk: Buffer, which: 'stdout' | 'stderr') => {
      const used = target.reduce((sum, part) => sum + part.length, 0)
      const room = OUTPUT_CAP - used
      if (room <= 0) {
        if (which === 'stdout') stdoutTruncated = true
        else stderrTruncated = true
        markTruncation(which)
        stop('truncate')
        return
      }
      const kept = Buffer.from(chunk.subarray(0, Math.min(chunk.length, room)))
      target.push(kept)
      emit(which, takeChannelText(decoders[which], kept))
      if (kept.length < chunk.length) {
        if (which === 'stdout') stdoutTruncated = true
        else stderrTruncated = true
        markTruncation(which)
        stop('truncate')
      }
    }
    stream.on('data', chunk => push(stdout, chunk, 'stdout'))
    stream.stderr.on('data', chunk => push(stderr, chunk, 'stderr'))
    stream.on('close', (code, signal) => finish(code, signal))
    if (stdin !== undefined && cause === 'exit') {
      stream.write(typeof stdin === 'string' ? Buffer.from(stdin) : stdin)
      stream.end()
    }
    if (cause !== 'exit') {
      try {
        stream.signal?.('KILL', () => undefined)
      } catch {
        // The channel may already be gone.
      }
      try {
        stream.close()
      } catch {
        // Closing a finished channel is the outcome we wanted.
      }
    }
  })
  return { done, close: () => stop('cancel') }
}

interface SftpLike {
  readFile(path: string, callback: (error: Error | undefined, data: Buffer) => void): void
  writeFile(path: string, data: Buffer | string, callback: (error: Error | undefined) => void): void
  realpath(path: string, callback: (error: Error | undefined, resolved: string) => void): void
  readdir(path: string, callback: (error: Error | undefined, list: ReadonlyArray<{ filename: string, attrs: { isDirectory(): boolean } }>) => void): void
  stat(path: string, callback: (error: Error | undefined, stats: { size: number, isDirectory(): boolean }) => void): void
  end(callback?: () => void): void
}

function openSftp(client: Client): Promise<SftpSession> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(new SshFailure(error.message, 'sftp'))
        return
      }
      const api = sftp as unknown as SftpLike
      resolve({
        api,
        end: () => {
          try {
            api.end()
          } catch {
            // The session channel is already closed.
          }
        },
      })
    })
  })
}

async function closeLive(live: Live): Promise<void> {
  try {
    const session = await live.sftp
    session?.end()
  } catch {
    // Opening SFTP failed; the client close still releases the session slot.
  }
  live.client.end()
}

function statInfo(sftp: SftpLike, remotePath: string): Promise<{ isDirectory: boolean, size: number }> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) reject(new SshFailure(error.message, 'sftp-stat'))
      else resolve({ isDirectory: stats.isDirectory(), size: stats.size })
    })
  })
}

function statSize(sftp: SftpLike, remotePath: string): Promise<number> {
  return statInfo(sftp, remotePath).then(info => info.size)
}

function readAll(sftp: SftpLike, remotePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(remotePath, (error, data) => {
      if (error) reject(new SshFailure(error.message, 'sftp-read'))
      else resolve(data)
    })
  })
}

function writeAll(sftp: SftpLike, remotePath: string, body: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, body, error => {
      if (error) reject(new SshFailure(error.message, 'sftp-write'))
      else resolve()
    })
  })
}

function realpathOf(sftp: SftpLike, remotePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(remotePath, (error, resolved) => {
      if (error) reject(new SshFailure(error.message, 'sftp-realpath'))
      else resolve(resolved)
    })
  })
}

function readdir(sftp: SftpLike, remotePath: string): Promise<ReadonlyArray<{ filename: string, attrs: { isDirectory(): boolean } }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(remotePath, (error, list) => {
      if (error) reject(new SshFailure(error.message, 'sftp-list'))
      else resolve(list)
    })
  })
}
