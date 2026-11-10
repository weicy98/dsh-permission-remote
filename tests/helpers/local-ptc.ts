/**
 * Local child_process transport used by the offline PTC e2e.
 *
 * It implements the exact same RemoteTransport surface as SshPoolTransport; the
 * only difference is that the "remote" host is this machine. The shim still
 * receives a real Unix socket and the worker still gets a real fd 7.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { PassThrough, type Duplex } from 'node:stream'
import type { ExecResult } from '../../src/ssh-pool.ts'
import type { RemoteExecHandle, RemoteTransport } from '../../src/remote-transport.ts'

export class LocalTransport implements RemoteTransport {
  async exec(_host: unknown, _secret: unknown, command: string, signal?: AbortSignal): Promise<RemoteExecHandle> {
    if (signal?.aborted === true) throw abortError()
    // `detached` puts the shell in its own process group so abort can kill the
    // whole tree. `sh -lc` spawns children (e.g. `sleep`) that inherit the
    // stdio pipes; killing only the shell leaves those fds open and delays the
    // 'close' event until the children exit on their own -- which is exactly
    // how an abort can look like it did nothing.
    const child = spawn('/bin/sh', ['-lc', command], { stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    child.stdout.pipe(stdout)
    child.stderr.pipe(stderr)
    const done = new Promise<ExecResult>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code, signalName) => {
        resolve({
          code: code ?? null,
          signal: signalName ?? null,
          stdout: '',
          stderr: '',
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        })
      })
    })
    const abort = () => {
      if (child.exitCode === null && child.pid !== undefined) {
        try {
          // Kill the process group, not just the shell. Falls back to the
          // single child on platforms without negative-pid process groups.
          process.kill(-child.pid, 'SIGKILL')
          return
        } catch {
          // No such group (Windows, or already reaped); fall through.
        }
      }
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
    if (signal !== undefined) {
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      void done.finally(() => signal.removeEventListener('abort', abort))
    }
    return {
      stdout,
      stderr,
      done,
      write: data => child.stdin.write(data),
      end: () => child.stdin.end(),
      close: abort,
    }
  }

  forwardOutStreamLocal(_host: unknown, _secret: unknown, socketPath: string, signal?: AbortSignal): Promise<Duplex> {
    return connectSocket(socketPath, signal)
  }

  forwardOutTcp(_host: unknown, _secret: unknown, hostname: string, port: number, signal?: AbortSignal): Promise<Duplex> {
    return connectSocket(port, signal, hostname)
  }
}

function abortError(): Error {
  const error = new Error('local transport aborted')
  error.name = 'AbortError'
  return error
}

async function connectSocket(pathOrPort: string | number, signal?: AbortSignal, host = '127.0.0.1'): Promise<Duplex> {
  if (signal?.aborted === true) throw abortError()
  const socket: Socket = typeof pathOrPort === 'number'
    ? connect(pathOrPort, host)
    : connect(pathOrPort)
  await Promise.race([
    once(socket, 'connect'),
    once(socket, 'error').then(([error]) => { throw error }),
  ])
  return socket
}
