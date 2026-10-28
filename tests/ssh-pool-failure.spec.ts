import assert from 'node:assert/strict'
import test from 'node:test'
import { Client, type ConnectConfig } from '../src/ssh2-client.ts'
import type { HostConfig } from '../src/config.ts'
import { SshFailure, SshPool, isRetryableOpenFailure, settleThen } from '../src/ssh-pool.ts'

const host: HostConfig = {
  id: 'host1',
  name: '118',
  host: '192.168.44.118',
  port: 22,
  username: 'root',
  auth: 'key',
  privateKeyPath: '',
  fingerprint: 'SHA256:abc',
  opsPolicy: 'ask',
}

/** Collect unhandled rejections for the duration of one test. */
async function trackUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const onRejection = (reason: unknown) => seen.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    await run()
    // A `.finally`-derived promise rejects on the next microtask turn, so give
    // the loop one macrotask to surface it.
    await new Promise(resolve => setTimeout(resolve, 10))
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  return seen
}

/** Replace connect so the pool never touches the network. */
async function withFakeConnect(
  implementation: (this: Client, options: ConnectConfig) => Client,
  run: () => Promise<void>,
): Promise<void> {
  const original = Client.prototype.connect
  Client.prototype.connect = implementation as typeof Client.prototype.connect
  try {
    await run()
  } finally {
    Client.prototype.connect = original
  }
}

test('settleThen keeps the rejection on the observed promise', async () => {
  let cleaned = 0
  const failure = new Promise<never>((_, reject) => reject(new Error('channel died')))
  const leaked = await trackUnhandled(async () => {
    settleThen(failure, () => { cleaned += 1 })
    await assert.rejects(() => failure, /channel died/)
  })
  assert.equal(cleaned, 1)
  assert.deepEqual(leaked, [])
})

test('a retryable open failure names the connection, not a bug', () => {
  assert.equal(isRetryableOpenFailure(new SshFailure('Not connected', 'exec')), true)
  assert.equal(isRetryableOpenFailure(new SshFailure('Connection lost', 'exec')), true)
})

test('settleThen still runs cleanup when the work succeeds', async () => {
  let cleaned = 0
  settleThen(Promise.resolve('ok'), () => { cleaned += 1 })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(cleaned, 1)
})

test('a failed channel open does not leave an unhandled rejection', async () => {
  const leaked = await trackUnhandled(async () => {
    await withFakeConnect(function (this: Client) {
      // `ready` resolves the pool, so `exec` runs against a client whose socket
      // is already gone — the state that produced "No response from server".
      this.emit('ready')
      return this
    }, async () => {
      const pool = new SshPool(1)
      const controller = new AbortController()
      await assert.rejects(
        () => pool.exec(host, {}, 'free -h', 5_000, controller.signal),
        /Not connected|No response from server/,
      )
    })
  })
  assert.deepEqual(leaked, [])
})

test('a dead pooled session is dropped and the command is retried once', async () => {
  assert.equal(isRetryableOpenFailure(new SshFailure('No response from server', 'exec')), true)
  assert.equal(isRetryableOpenFailure(new SshFailure('No response from server', 'sftp')), false)
  assert.equal(isRetryableOpenFailure(new SshFailure('Permission denied', 'exec')), false)
  // A plain Error never reaches this predicate: `openChannel` wraps it first.
  assert.equal(isRetryableOpenFailure(new Error('No response from server')), false)
})

test('a retryable failure is replayed once and then rethrown', async () => {
  const failures = [
    new SshFailure('No response from server', 'exec'),
    new SshFailure('No response from server', 'exec'),
  ]
  let opens = 0
  const pool = new SshPool(1)
  ;(pool as unknown as { open: () => Promise<unknown> }).open = async () => {
    opens += 1
    const error = failures.shift()
    return { done: error === undefined ? Promise.resolve({}) : Promise.reject(error), close: () => undefined }
  }
  const dropped: string[] = []
  ;(pool as unknown as { dropSession(id: string): Promise<void> }).dropSession = async (id: string) => { dropped.push(id) }

  await assert.rejects(() => pool.exec(host, {}, 'free -h', 5_000), /No response from server/)
  assert.equal(opens, 2, 'the failed request is replayed exactly once')
  assert.deepEqual(dropped, ['host1'], 'the stale session is dropped before the replay')
})

test('an aborted command is not retried', async () => {
  const controller = new AbortController()
  controller.abort()
  const pool = new SshPool(1)
  let opens = 0
  ;(pool as unknown as { open: () => Promise<unknown> }).open = async () => {
    opens += 1
    return { done: Promise.reject(new SshFailure('No response from server', 'exec')), close: () => undefined }
  }
  await assert.rejects(() => pool.exec(host, {}, 'free -h', 5_000, controller.signal))
  assert.equal(opens, 1)
})
