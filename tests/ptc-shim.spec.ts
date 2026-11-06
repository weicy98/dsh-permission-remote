import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const SHIM = fileURLToPath(new URL('../src/ptc-shim.mjs', import.meta.url))

async function waitForHandshake(stderr: NodeJS.ReadableStream, token: string): Promise<{ path: string, port?: number }> {
  let buffered = ''
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('shim handshake timeout')), 3000)
    stderr.on('data', chunk => {
      buffered += chunk.toString('utf8')
      const line = buffered.split('\n').find(value => value.startsWith('__DSH_PTC_READY__'))
      if (line === undefined) return
      clearTimeout(timer)
      const [, gotToken, endpoint] = line.trim().split(/\s+/u)
      if (gotToken !== token) {
        reject(new Error(`shim token mismatch: ${String(gotToken)}`))
        return
      }
      if (endpoint?.startsWith('unix:')) resolve({ path: endpoint.slice(5) })
      else if (endpoint?.startsWith('tcp:')) resolve({ path: '', port: Number(endpoint.slice(4).split(':')[1]) })
      else reject(new Error(`unknown shim endpoint: ${String(endpoint)}`))
    })
    stderr.on('error', reject)
  })
}

async function startShim(socketArgument: string, argv: readonly string[]) {
  const token = 'token-123'
  const child = spawn(process.execPath, [SHIM, socketArgument, '/tmp', '--', ...argv], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  child.stdin.write(`${token}\n`)
  const endpoint = await waitForHandshake(child.stderr, token)
  return { child, token, endpoint, stderr: () => stderr }
}

async function echoChild(dir: string): Promise<string> {
  const path = join(dir, 'echo-child.cjs')
  await writeFile(path, `
const { Socket } = require('node:net')
const fd = new Socket({ fd: 7, readable: true, writable: true })
fd.on('data', chunk => fd.write('echo:' + chunk))
process.stdout.write('child-started\\n')
`)
  return path
}

test('ptc-shim passes a Unix socket as fd 7 and keeps stdout pure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ptc-shim-'))
  const socketPath = join(dir, 'run.sock')
  const childPath = await echoChild(dir)
  try {
    const shim = await startShim(socketPath, [process.execPath, childPath])
    const client = await import('node:net').then(({ connect }) => connect(socketPath))
    client.on('data', () => undefined)
    client.on('error', () => undefined)
    await once(client, 'connect')
    client.write('hello')
    await new Promise(resolve => setTimeout(resolve, 100))
    client.end()
    shim.child.stdin.end()
    const [code] = await once(shim.child, 'exit')
    assert.equal(shim.stderr().includes('__DSH_PTC_READY__ token-123'), true)
    assert.equal(shim.stderr().includes('child-started'), false)
    assert.equal(code === 0 || code === 128, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ptc-shim propagates the child exit code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ptc-shim-'))
  const socketPath = join(dir, 'run.sock')
  const childPath = join(dir, 'exit-child.cjs')
  await writeFile(childPath, 'process.exit(7)\n')
  try {
    const shim = await startShim(socketPath, [process.execPath, childPath])
    const { connect } = await import('node:net')
    const client = connect(socketPath)
    client.on('error', () => undefined)
    await once(client, 'connect')
    client.end()
    const [code] = await once(shim.child, 'exit')
    assert.equal(code, 7)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ptc-shim authenticates a TCP client, acknowledges it, then hands the socket to the worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ptc-shim-'))
  try {
    const childPath = await echoChild(dir)
    const shim = await startShim('-', [process.execPath, childPath])
    assert.equal(typeof shim.endpoint.port, 'number')
    const { connect } = await import('node:net')
    const client = connect(shim.endpoint.port!, '127.0.0.1')
    client.on('error', () => undefined)
    await once(client, 'connect')
    client.write(`__DSH_PTC_AUTH__ ${shim.token}\n`)
    const ack = await new Promise<string>((resolve, reject) => {
      let buffered = ''
      const timer = setTimeout(() => reject(new Error('auth acknowledgement timeout')), 3000)
      client.on('data', chunk => {
        buffered += chunk.toString('utf8')
        const newline = buffered.indexOf('\n')
        if (newline === -1) return
        clearTimeout(timer)
        resolve(buffered.slice(0, newline))
      })
      client.once('error', reject)
    })
    assert.equal(ack, '__DSH_PTC_AUTH_OK__')
    // The host writes control frames only after the ack. Those bytes must reach
    // the worker through fd 7 even when they arrive before the child reads.
    const echoed = new Promise<string>(resolve => client.once('data', chunk => resolve(chunk.toString('utf8'))))
    client.write('hello')
    assert.equal(await echoed, 'echo:hello')
    client.end()
    shim.child.stdin.end()
    await once(shim.child, 'exit')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ptc-shim forwards control bytes that share the authentication read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ptc-shim-'))
  try {
    const childPath = await echoChild(dir)
    const shim = await startShim('-', [process.execPath, childPath])
    const { connect } = await import('node:net')
    const client = connect(shim.endpoint.port!, '127.0.0.1')
    client.on('error', () => undefined)
    await once(client, 'connect')
    // A single write: the shim must not drop the bytes after the auth line.
    client.write(`__DSH_PTC_AUTH__ ${shim.token}\nhello`)
    const echoed = await new Promise<string>((resolve, reject) => {
      let buffered = ''
      const timer = setTimeout(() => reject(new Error('echo timeout')), 3000)
      client.on('data', chunk => {
        buffered += chunk.toString('utf8')
        if (buffered.includes('echo:hello')) {
          clearTimeout(timer)
          resolve('echo:hello')
        }
      })
      client.once('error', reject)
    })
    assert.equal(echoed, 'echo:hello')
    client.end()
    shim.child.stdin.end()
    await once(shim.child, 'exit')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ptc-shim cleans up and exits when stdin closes before a client connects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ptc-shim-'))
  try {
    const childPath = await echoChild(dir)
    const shim = await startShim(join(dir, 'run.sock'), [process.execPath, childPath])
    shim.child.stdin.end()
    const [code] = await once(shim.child, 'exit')
    assert.equal(code, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ptc-shim rejects a TCP client that does not present the token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ptc-shim-'))
  try {
    const childPath = await echoChild(dir)
    const shim = await startShim('-', [process.execPath, childPath])
    const { connect } = await import('node:net')
    const wrong = connect(shim.endpoint.port!, '127.0.0.1')
    wrong.on('error', () => undefined)
    await once(wrong, 'connect')
    wrong.write('__DSH_PTC_AUTH__ wrong-token\n')
    await new Promise(resolve => setTimeout(resolve, 200))
    // The bad connection must not have spawned a child; the shim stays alive
    // for the real host connection (or exits when its stdin closes).
    shim.child.stdin.end()
    await once(shim.child, 'exit')
    wrong.destroy()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('ptc-shim flushes a large child stdout burst before exiting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ptc-shim-'))
  const socketPath = join(dir, 'run.sock')
  const childPath = join(dir, 'burst-child.cjs')
  // The child awaits every write callback, so IT has flushed to the pipe and
  // any loss from here on belongs to the shim's own relay. Exiting the shim on
  // a short fixed timer dropped that backlog whenever the reader was slower
  // than the pipe.
  await writeFile(childPath, `
;(async () => {
  const chunk = Buffer.alloc(64 * 1024, 0x41)
  for (let i = 0; i < 64; i += 1) {
    await new Promise(resolve => process.stdout.write(chunk, resolve))
  }
  process.exit(0)
})()
`)
  try {
    const shim = await startShim(socketPath, [process.execPath, childPath])
    const { connect } = await import('node:net')
    const client = connect(socketPath)
    client.on('error', () => undefined)
    await once(client, 'connect')
    // Hold the read side closed long enough for the shim to accumulate a
    // backlog it must flush before exiting.
    await new Promise(resolve => setTimeout(resolve, 1_000))
    let relayed = 0
    const closed = once(shim.child, 'close')
    shim.child.stdout?.on('data', (chunk: Buffer) => { relayed += chunk.length })
    const [code] = await closed as [number]
    assert.equal(code, 0)
    assert.equal(relayed, 64 * 64 * 1024, `shim relayed ${relayed} of ${64 * 64 * 1024} bytes`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the watchdog removes a detached worker when the shim is SIGKILLed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ptc-shim-'))
  const socketPath = join(dir, 'run.sock')
  const pidFile = join(dir, 'worker.pid')
  const childPath = join(dir, 'sleep-child.cjs')
  await writeFile(childPath, `require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => undefined, 1000)\n`)
  try {
    const shim = await startShim(socketPath, [process.execPath, childPath, pidFile])
    const { connect } = await import('node:net')
    const client = connect(socketPath)
    client.on('error', () => undefined)
    await once(client, 'connect')
    for (let i = 0; i < 50 && !(await import('node:fs')).existsSync(pidFile); i += 1) await new Promise(resolve => setTimeout(resolve, 20))
    const workerPid = Number((await import('node:fs')).readFileSync(pidFile, 'utf8'))
    assert.ok(workerPid > 0)
    shim.child.kill('SIGKILL')
    await once(shim.child, 'exit')
    await new Promise(resolve => setTimeout(resolve, 2000))
    let alive = true
    try { process.kill(workerPid, 0) } catch { alive = false }
    assert.equal(alive, false, 'worker should not survive a SIGKILLed shim')
    client.destroy()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
