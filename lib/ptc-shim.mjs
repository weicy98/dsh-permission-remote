#!/usr/bin/env node
/**
 * Remote PTC transport shim.
 *
 * Usage:
 *   node ptc-shim.mjs <socketPath|-> <remoteCwd> -- <argv...>
 *
 * The host writes a token as the first line of stdin. The shim listens on a
 * Unix socket and a loopback TCP port (either may be unavailable) and prints
 * one handshake line on stderr:
 *
 *   __DSH_PTC_READY__ <token> [unix:/path] [tcp:127.0.0.1:port]
 *
 * It accepts one connection, passes it to the worker as fd 7, and otherwise
 * stays out of the control stream. stdout/stderr remain the program's raw
 * output; the handshake is never written to stdout.
 */
import { spawn } from 'node:child_process'
import { chmodSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'

const HANDSHAKE = '__DSH_PTC_READY__'
const AUTH = '__DSH_PTC_AUTH__'
const args = process.argv.slice(2)
const separator = args.indexOf('--')
if (separator < 2 || separator === args.length - 1) {
  process.stderr.write('ptc-shim: expected <socketPath|-> <remoteCwd> -- <argv...>\n')
  process.exit(2)
}
const socketArgument = args[0]
const remoteCwd = args[1]
const childArgv = args.slice(separator + 1)
if (childArgv.length === 0) {
  process.stderr.write('ptc-shim: empty argv\n')
  process.exit(2)
}

let token = ''
let child
let socket
const servers = new Set()
let groupKilled = false
let cleaned = false
let exiting = false

function cleanup() {
  if (cleaned) return
  cleaned = true
  for (const server of servers) {
    try {
      server.close()
    } catch {
      // Already closed.
    }
  }
  servers.clear()
  try {
    socket?.destroy()
  } catch {
    // Already gone.
  }
  if (socketArgument !== '-' && socketArgument.length > 0) {
    try {
      rmSync(socketArgument, { force: true })
    } catch {
      // Best effort.
    }
  }
}

function killGroup() {
  if (child === undefined || groupKilled) return
  groupKilled = true
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function finish(code, signal) {
  if (exiting) return
  exiting = true
  const exitCode = typeof code === 'number' ? code : signal === undefined || signal === null ? 1 : 128
  cleanup()
  process.exitCode = exitCode
  setTimeout(() => process.exit(exitCode), 10)
}

function readFirstLine() {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const cleanupReader = () => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
      process.stdin.resume()
      process.stdin.on('data', () => undefined)
    }
    const onData = chunk => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline !== -1) {
        cleanupReader()
        resolve(buffer.slice(0, newline).trim())
      }
    }
    const onEnd = () => {
      cleanupReader()
      reject(new Error('stdin ended before the shim token'))
    }
    const onError = error => {
      cleanupReader()
      reject(error)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
  })
}

function handleConnection(server, accepted, kind) {
  if (socket !== undefined) {
    accepted.destroy()
    return
  }
  if (kind === 'unix') {
    socket = accepted
    for (const other of servers) {
      if (other === server) continue
      try { other.close() } catch {}
    }
    spawnWorker(accepted)
    return
  }
  let buffer = ''
  const onData = chunk => {
    buffer += chunk.toString('utf8')
    if (buffer.length > 4096) {
      accepted.destroy()
      return
    }
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const line = buffer.slice(0, newline).replace(/\r$/u, '')
    if (line !== `${AUTH} ${token}`) {
      accepted.destroy()
      return
    }
    accepted.off('data', onData)
    // Preserve bytes the host wrote after the auth line (the first control
    // frame may share a TCP/Unix read).
    const rest = buffer.slice(newline + 1)
    if (rest.length > 0) accepted.unshift(Buffer.from(rest))
    // Removing the auth listener leaves the socket paused; keep it paused so
    // bytes arriving before the worker takes fd 7 stay buffered for it.
    accepted.pause()
    socket = accepted
    for (const other of servers) {
      if (other === server) continue
      try {
        other.close()
      } catch {
        // Already closed.
      }
    }
    spawnWorker(accepted)
  }
  accepted.on('data', onData)
}

function listenUnix(path) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    servers.add(server)
    server.once('error', error => {
      servers.delete(server)
      try { server.close() } catch {}
      reject(error)
    })
    server.on('connection', accepted => handleConnection(server, accepted, 'unix'))
    server.listen(path, () => {
      try { chmodSync(path, 0o600) } catch {}
      resolve({ kind: 'unix', path })
    })
  })
}

function listenTcp() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    servers.add(server)
    server.once('error', error => {
      servers.delete(server)
      try { server.close() } catch {}
      reject(error)
    })
    server.on('connection', accepted => handleConnection(server, accepted, 'tcp'))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        reject(new Error('TCP shim did not report a port'))
        return
      }
      resolve({ kind: 'tcp', port: address.port })
    })
  })
}

function handshakeValue(endpoint) {
  return endpoint.kind === 'unix' ? `unix:${endpoint.path}` : `tcp:127.0.0.1:${endpoint.port}`
}

function shutdown() {
  if (child === undefined) finish(0)
  else killGroup()
}

function spawnWorker(accepted) {
  const env = {
    ...(typeof process.env.PATH === 'string' ? { PATH: process.env.PATH } : {}),
    ...(typeof process.env.TEMP === 'string' ? { TEMP: process.env.TEMP } : {}),
    ...(typeof process.env.TMP === 'string' ? { TMP: process.env.TMP } : {}),
    DSH_SUBPROCESS_CONTROL: 'pipe',
  }
  try {
    child = spawn(childArgv[0], childArgv.slice(1), {
      cwd: remoteCwd,
      env,
      detached: true,
      // fd 7 is the official subprocess control descriptor. The array must
      // contain entries 0..7; a four-entry array would put the socket on fd 3.
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', accepted],
    })
  } catch (error) {
    process.stderr.write(`ptc-shim: spawn failed: ${error instanceof Error ? error.message : String(error)}\n`)
    finish(127)
    return
  }
  // The shim can be SIGKILLed by the host/channel teardown, in which case
  // process exit handlers never run. A tiny detached watchdog observes the
  // shim pid and kills the detached worker process group if the shim vanishes
  // without a normal shutdown.
  try {
    const watchdog = spawn('/bin/sh', ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; kill -KILL -${child.pid} 2>/dev/null || true`], {
      detached: true,
      stdio: 'ignore',
    })
    watchdog.unref()
  } catch {
    // The normal exit handler still covers everything except SIGKILL.
  }
  child.stdout?.on('data', chunk => process.stdout.write(chunk))
  child.stderr?.on('data', chunk => process.stderr.write(chunk))
  child.on('error', error => {
    process.stderr.write(`ptc-shim: child error: ${error.message}\n`)
  })
  child.on('close', (code, signal) => finish(code, signal))
}

async function main() {
  token = await readFirstLine()
  if (token.length === 0) {
    process.stderr.write('ptc-shim: empty token\n')
    process.exit(2)
  }
  const endpoints = []
  if (socketArgument !== '-') {
    try {
      const info = statSync(socketArgument)
      if (info.isSocket()) rmSync(socketArgument, { force: true })
    } catch {
      // The socket does not exist yet.
    }
    try {
      endpoints.push(await listenUnix(socketArgument))
    } catch {
      // TCP below is the fallback.
    }
  }
  try {
    endpoints.push(await listenTcp())
  } catch {
    // A Unix endpoint may still work.
  }
  if (endpoints.length === 0) throw new Error('could not bind a Unix socket or a loopback TCP port')
  process.stderr.write(`${HANDSHAKE} ${token} ${endpoints.map(handshakeValue).join(' ')}\n`)

  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGHUP', shutdown)
  process.on('exit', cleanup)
}

main().catch(error => {
  process.stderr.write(`ptc-shim: ${error instanceof Error ? error.message : String(error)}\n`)
  cleanup()
  process.exit(2)
})
