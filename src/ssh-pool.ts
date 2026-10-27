import { readFile } from 'node:fs/promises'
import { Client, type ConnectConfig } from 'ssh2'
import type { HostConfig } from './config.ts'
import { shJoin } from './shell-quote.ts'

export interface ExecResult {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** One remote command on its own SSH channel. `close` kills that channel only. */
export interface RemoteCommand {
  readonly done: Promise<ExecResult>
  close(): void
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

interface Live {
  readonly client: Client
  readonly hostId: string
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
        live.client.end()
      } catch {
        // A failed connect has nothing to close.
      }
    }
  }

  invalidate(hostId: string): void {
    const current = this.live.get(hostId)
    this.live.delete(hostId)
    if (current === undefined) return
    void current.then(live => live.client.end()).catch(() => undefined)
  }

  async exec(host: HostConfig, secret: SecretMaterial, command: string, timeoutMs: number): Promise<ExecResult> {
    const commandHandle = await this.open(host, secret, command, timeoutMs)
    return commandHandle.done
  }

  /** `timeoutMs` of 0 waits until the command exits or `close` kills its channel. */
  async open(host: HostConfig, secret: SecretMaterial, command: string, timeoutMs: number): Promise<RemoteCommand> {
    const live = await this.acquire(host, secret, true)
    return openChannel(live.client, command, timeoutMs)
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

  async sftpRead(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<Buffer> {
    const live = await this.acquire(host, secret, true)
    return sftpBuffer(live.client, sftp => readAll(sftp, remotePath))
  }

  async sftpWrite(host: HostConfig, secret: SecretMaterial, remotePath: string, body: Buffer | string): Promise<void> {
    const live = await this.acquire(host, secret, true)
    await sftpBuffer(live.client, sftp => writeAll(sftp, remotePath, body))
  }

  async sftpRealpath(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string> {
    const live = await this.acquire(host, secret, true)
    return sftpBuffer(live.client, sftp => realpathOf(sftp, remotePath))
  }

  async sftpList(host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<DirEntry[]> {
    const live = await this.acquire(host, secret, true)
    return sftpBuffer(live.client, async sftp => {
      const rows = await readdir(sftp, remotePath)
      return rows
        .filter(row => row.attrs.isDirectory())
        .map(row => ({
          name: row.filename,
          path: remotePath === '/' ? `/${row.filename}` : `${remotePath.replace(/\/$/, '')}/${row.filename}`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    })
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

  private async acquire(host: HostConfig, secret: SecretMaterial, requireTrust: boolean): Promise<Live> {
    const existing = this.live.get(host.id)
    if (existing !== undefined) {
      try {
        return await existing
      } catch {
        this.live.delete(host.id)
      }
    }
    await this.reserve()
    const pending = connect(host, secret, key => {
      const fingerprint = formatFingerprint(key)
      if (!requireTrust) return true
      return host.fingerprint.trim().length > 0 && host.fingerprint.trim() === fingerprint
    }).then(client => {
      client.on('close', () => {
        if (this.live.get(host.id) === pending) this.live.delete(host.id)
      })
      client.on('end', () => {
        if (this.live.get(host.id) === pending) this.live.delete(host.id)
      })
      return { client, hostId: host.id }
    }).finally(() => {
      this.release()
    })
    this.live.set(host.id, pending)
    try {
      return await pending
    } catch (error) {
      this.live.delete(host.id)
      throw error
    }
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
}

function openChannel(client: Client, command: string, timeoutMs: number): RemoteCommand {
  let settled = false
  let cause: 'exit' | 'timeout' | 'cancel' = 'exit'
  let stream: ExecStream | undefined
  let resolveDone: (result: ExecResult) => void = () => undefined
  let rejectDone: (error: Error) => void = () => undefined
  const done = new Promise<ExecResult>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  const finish = (code: number | null, signal: string | null) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(fallback)
    resolveDone({
      code: cause === 'exit' ? code : null,
      signal: cause === 'exit' ? signal : 'KILL',
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut: cause === 'timeout',
    })
  }
  let fallback: ReturnType<typeof setTimeout> | undefined
  const stop = (next: 'timeout' | 'cancel') => {
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
    stream.on('data', chunk => stdout.push(chunk))
    stream.stderr.on('data', chunk => stderr.push(chunk))
    stream.on('close', (code, signal) => finish(code, signal))
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
}

function sftpBuffer<T>(client: Client, run: (sftp: SftpLike) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(new SshFailure(error.message, 'sftp'))
        return
      }
      void run(sftp as unknown as SftpLike).then(resolve, reject)
    })
  })
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
