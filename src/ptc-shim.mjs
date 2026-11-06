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
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const HANDSHAKE = '__DSH_PTC_READY__'
const AUTH = '__DSH_PTC_AUTH__'
const AUTH_OK = '__DSH_PTC_AUTH_OK__'
const AUTH_MAX_BYTES = 4096
/** Exit deadline for relaying the child's last writes; a stalled reader cannot hang the shim. */
const FLUSH_TIMEOUT_MS = 10_000
const args = process.argv.slice(2)
const separator = args.indexOf('--')
if (separator < 2 || separator === args.length - 1) {
  process.stderr.write('ptc-shim: expected <socketPath|-> <remoteCwd> -- <argv...>\n')
  process.exit(2)
}
const socketArgument = args[0]
const remoteCwd = args[1]
const socketDirectory = socketArgument !== '-' && socketArgument.length > 0
  ? dirname(socketArgument)
  : ''
const childArgv = args.slice(separator + 1)
if (childArgv.length === 0) {
  process.stderr.write('ptc-shim: empty argv\n')
  process.exit(2)
}

let token = ''
let child
let socket
let controlBridge
const servers = new Set()
let groupKilled = false
let cleaned = false
let exiting = false

function ensureSocketDirectory() {
  if (socketDirectory.length === 0 || !basename(socketDirectory).startsWith('dsh-ptc-')) return
  try {
    mkdirSync(socketDirectory, { recursive: true, mode: 0o700 })
    chmodSync(socketDirectory, 0o700)
  } catch {
    // listenUnix reports the actual failure.
  }
}

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
  if (controlBridge !== undefined) {
    for (const stream of [controlBridge.tcp, controlBridge.internal, controlBridge.workerSide]) {
      try { stream?.destroy() } catch {}
    }
  }
  if (socketArgument !== '-' && socketArgument.length > 0) {
    try {
      rmSync(socketArgument, { force: true })
    } catch {
      // Best effort.
    }
    if (socketDirectory.length > 0 && basename(socketDirectory).startsWith('dsh-ptc-')) {
      try {
        rmSync(socketDirectory, { recursive: true, force: true })
      } catch {
        // Best effort.
      }
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

/**
 * Exit once stdout/stderr have actually flushed.
 *
 * The child's output is relayed through this process's own pipes. Calling
 * `process.exit()` on a timer could discard whatever is still buffered — a
 * child that writes megabytes and exits immediately lost >90% of its output in
 * testing. An empty write's callback fires after every earlier write on the
 * same stream has drained, so waiting for both callbacks (bounded, so a stalled
 * consumer cannot hang the shim) is the flush barrier.
 */
function finish(code, signal) {
  if (exiting) return
  exiting = true
  const exitCode = typeof code === 'number' ? code : signal === undefined || signal === null ? 1 : 128
  cleanup()
  process.exitCode = exitCode
  let pending = 2
  let exited = false
  const exit = () => {
    if (exited) return
    exited = true
    process.exit(exitCode)
  }
  const flushed = () => {
    pending -= 1
    if (pending === 0) exit()
  }
  const flush = stream => {
    if (stream === undefined || stream.destroyed || stream.writableEnded) {
      flushed()
      return
    }
    try {
      stream.write('', flushed)
    } catch {
      // A closed descriptor has nothing left to flush.
      flushed()
    }
  }
  flush(process.stdout)
  flush(process.stderr)
  // Bounded fallback: a consumer that stops reading must not keep the shim (and
  // its detached worker watchdog) alive forever.
  setTimeout(exit, FLUSH_TIMEOUT_MS).unref()
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
  let buffer = Buffer.alloc(0)
  const onData = chunk => {
    buffer = Buffer.concat([buffer, chunk])
    const newline = buffer.indexOf(0x0a)
    if (newline === -1) {
      if (buffer.length > AUTH_MAX_BYTES) accepted.destroy()
      return
    }
    if (newline > AUTH_MAX_BYTES) {
      accepted.destroy()
      return
    }
    const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/u, '')
    if (line !== `${AUTH} ${token}`) {
      accepted.destroy()
      return
    }
    const leftover = buffer.subarray(newline + 1)
    accepted.off('data', onData)
    accepted.pause()
    // Claim the single control slot before the async bridge setup so a second
    // authenticated connection cannot race us into spawning a second worker.
    if (socket !== undefined) {
      accepted.destroy()
      return
    }
    socket = accepted
    void startTcpControl(server, accepted, leftover)
  }
  accepted.on('data', onData)
}

/**
 * A TCP client shares one socket with the worker, so the shim must consume the
 * authentication line without ever stealing control bytes. The kernel can
 * deliver a read that was already in flight when the shim paused, and those
 * bytes would be invisible to the child. Instead, keep reading the TCP socket
 * in this process and bridge it to a private Unix socket pair that is handed
 * to the worker as fd 7.
 */
async function startTcpControl(server, tcp, leftover) {
  try {
    const { workerSide, hostSide } = await createControlPair()
    if (exiting) {
      tcp.destroy()
      workerSide.destroy()
      hostSide.destroy()
      return
    }
    for (const other of servers) {
      if (other === server) continue
      try {
        other.close()
      } catch {
        // Already closed.
      }
    }
    workerSide.on('error', () => {
      try { tcp.destroy() } catch {}
    })
    // Bytes that followed the authentication line must reach the worker before
    // anything the bridge forwards afterwards.
    if (leftover.length > 0) hostSide.write(leftover)
    controlBridge = { tcp, internal: hostSide, workerSide }
    pipeBothWays(tcp, hostSide)
    tcp.resume()
    tcp.write(`${AUTH_OK}\n`)
    spawnWorker(workerSide)
  } catch (error) {
    process.stderr.write(`ptc-shim: TCP control bridge failed: ${error instanceof Error ? error.message : String(error)}\n`)
    tcp.destroy()
    finish(1)
  }
}

function createControlPair() {
  const pairDir = mkdtempSync(join(tmpdir(), 'dsh-ptc-pair-'))
  const path = join(pairDir, 'run.sock')
  // The worker's end stays paused for the whole life of this process: only the
  // child may read fd 7.
  const server = createServer({ pauseOnConnect: true })
  return new Promise((resolve, reject) => {
    let workerSide
    let hostSide
    let settled = false
    const removePairDir = () => {
      try { rmSync(pairDir, { recursive: true, force: true }) } catch {}
    }
    const fail = error => {
      if (settled) return
      settled = true
      try { server.close() } catch {}
      removePairDir()
      workerSide?.destroy()
      hostSide?.destroy()
      reject(error)
    }
    const maybeResolve = () => {
      if (settled || workerSide === undefined || hostSide === undefined) return
      settled = true
      try { server.close() } catch {}
      removePairDir()
      resolve({ workerSide, hostSide })
    }
    server.once('error', fail)
    server.once('connection', accepted => {
      if (settled) {
        accepted.destroy()
        return
      }
      workerSide = accepted
      maybeResolve()
    })
    server.listen(path, () => {
      try { chmodSync(path, 0o600) } catch {}
      hostSide = connect(path)
      hostSide.once('error', fail)
      hostSide.once('connect', maybeResolve)
    })
  })
}

function pipeBothWays(tcp, internal) {
  const forward = (from, to) => {
    from.on('data', chunk => {
      if (to.destroyed) return
      if (!to.write(chunk)) from.pause()
    })
    to.on('drain', () => {
      if (!from.destroyed) from.resume()
    })
  }
  forward(tcp, internal)
  forward(internal, tcp)
  const close = () => {
    tcp.destroy()
    internal.destroy()
  }
  tcp.on('end', () => internal.end())
  internal.on('end', () => tcp.end())
  tcp.on('close', close)
  internal.on('close', close)
  tcp.on('error', close)
  internal.on('error', close)
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
    finish(127)
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
    ensureSocketDirectory()
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
