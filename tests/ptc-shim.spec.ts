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

test('ptc-shim falls back to loopback TCP when the socket path is unusable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ptc-shim-'))
  try {
    const childPath = await echoChild(dir)
    const shim = await startShim('-', [process.execPath, childPath])
    assert.equal(typeof shim.endpoint.port, 'number')
    const { connect } = await import('node:net')
    const client = connect(shim.endpoint.port!, '127.0.0.1')
    client.on('data', () => undefined)
    client.on('error', () => undefined)
    await once(client, 'connect')
    client.write('tcp')
    await new Promise(resolve => setTimeout(resolve, 100))
    client.end()
    shim.child.stdin.end()
    await once(shim.child, 'exit')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
