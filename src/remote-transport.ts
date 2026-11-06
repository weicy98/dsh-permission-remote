/**
 * A narrow transport seam between the remote execution world and SSH.
 *
 * The production implementation wraps SshPool. The offline tests use a local
 * child_process/local-socket implementation, so the exact same remote-world
 * code can be exercised without an SSH server.
 */
import type { Duplex } from 'node:stream'
import type { Readable } from 'node:stream'
import type { HostConfig } from './config.ts'
import type { ExecResult, SecretMaterial, SshPool } from './ssh-pool.ts'

export interface RemoteExecHandle {
  readonly stdout: Readable
  readonly stderr: Readable
  readonly done: Promise<ExecResult>
  write(data: Buffer | string): void
  end(): void
  close(): void
}

export interface RemoteTransport {
  exec(host: HostConfig, secret: SecretMaterial, command: string, signal?: AbortSignal): Promise<RemoteExecHandle>
  forwardOutStreamLocal(host: HostConfig, secret: SecretMaterial, socketPath: string, signal?: AbortSignal): Promise<Duplex>
  forwardOutTcp(host: HostConfig, secret: SecretMaterial, hostname: string, port: number, signal?: AbortSignal): Promise<Duplex>
}

export class SshPoolTransport implements RemoteTransport {
  constructor(private readonly pool: SshPool) {}

  async exec(host: HostConfig, secret: SecretMaterial, command: string, signal?: AbortSignal): Promise<RemoteExecHandle> {
    const handle = await this.pool.openPtcExec(host, secret, command, signal)
    return {
      stdout: handle.stdout,
      stderr: handle.stderr,
      done: handle.done,
      write: data => handle.write(data),
      end: () => handle.end(),
      close: () => handle.close(),
    }
  }

  forwardOutStreamLocal(host: HostConfig, secret: SecretMaterial, socketPath: string, signal?: AbortSignal): Promise<Duplex> {
    return this.pool.forwardOutStreamLocal(host, secret, socketPath, signal)
  }

  forwardOutTcp(host: HostConfig, secret: SecretMaterial, hostname: string, port: number, signal?: AbortSignal): Promise<Duplex> {
    return this.pool.forwardOutTcp(host, secret, hostname, port, signal)
  }
}
