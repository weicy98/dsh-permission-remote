/**
 * Connection-lifecycle failures that used to escape the pool and take the whole
 * dsh process down. Every case here reproduces a path the wider suite never
 * reached: an asynchronous channel-open failure, a fault on a live SFTP session,
 * a fingerprint probe that fails after connecting, and a failed connect that
 * must not consume a concurrency slot.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Client, type ConnectConfig } from '../src/ssh2-client.ts'
import type { HostConfig } from '../src/config.ts'
import { SshPool } from '../src/ssh-pool.ts'

const host: HostConfig = {
  id: 'host118',
  name: '118',
  host: '192.168.44.118',
  port: 22,
  username: 'root',
  auth: 'key',
  privateKeyPath: '',
  fingerprint: 'SHA256:abc',
  opsPolicy: 'ask',
}

/** Collect unhandled rejections for one test, including ones raised on a later turn. */
async function trackUnhandled(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const onRejection = (reason: unknown) => seen.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    await run()
    // A `.finally`-derived promise rejects on a microtask, and Node reports the
    // unhandled rejection one turn after the rejection is abandoned.
    await new Promise(resolve => setTimeout(resolve, 20))
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  return seen
}

/** Swap `Client.prototype.connect`, restoring it even when the test throws. */
async function withConnect(
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

/** Swap one client method for the duration of `run`. */
async function withClientMethod<K extends keyof Client>(
  name: K,
  value: Client[K],
  run: () => Promise<void>,
): Promise<void> {
  const original = Client.prototype[name]
  Client.prototype[name] = value
  try {
    await run()
  } finally {
    Client.prototype[name] = original
  }
}

/** An exec stream stand-in: enough surface for `openChannel` to settle normally. */
function fakeStream(): EventEmitter & { stderr: EventEmitter, close(): void } {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(),
    close: () => undefined,
  })
}

test('an asynchronous channel-open failure leaves no unhandled rejection', async () => {
  // The exact shape of the 118 crash: the socket dies while ssh2 waits for
  // CHANNEL_OPEN_CONFIRMATION, so the exec callback -- not a throw -- receives
  // "No response from server". With a signal attached, the old `.finally`
  // forwarded that rejection into a promise nobody observed and dsh exited.
  const leaked = await trackUnhandled(async () => {
    await withConnect(function (this: Client) {
      process.nextTick(() => this.emit('ready'))
      return this
    }, async () => {
      await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
        const callback = rest.find(item => typeof item === 'function') as (error: Error) => void
        process.nextTick(() => callback(new Error('No response from server')))
        return this
      } as unknown as Client['exec'], async () => {
        const pool = new SshPool(2)
        const controller = new AbortController()
        await assert.rejects(
          () => pool.exec(host, {}, 'free -h', 5_000, controller.signal),
          /No response from server/,
        )
      })
    })
  })
  assert.deepEqual(leaked, [], 'a failed command must not become an unhandled rejection')
})

test('a late channel failure after an abort leaves no unhandled rejection', async () => {
  // `settleThen` also has to hold when the abort and the failure interleave: the
  // exec callback is captured first, the signal is already attached, and only
  // then does the channel die. That ordering is what forwarded the rejection
  // through `.finally` into a promise nobody awaited.
  const leaked = await trackUnhandled(async () => {
    await withConnect(function (this: Client) {
      process.nextTick(() => this.emit('ready'))
      return this
    }, async () => {
      let deliver: ((error: Error) => void) | undefined
      await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
        deliver = rest.find(item => typeof item === 'function') as (error: Error) => void
        return this
      } as unknown as Client['exec'], async () => {
        const pool = new SshPool(2)
        const controller = new AbortController()
        const call = pool.exec(host, {}, 'free -h', 5_000, controller.signal).catch(() => undefined)
        // The signal is attached, so the failing `done` has a `.finally`-shaped
        // observer; the channel dies afterwards.
        await new Promise(resolve => setTimeout(resolve, 10))
        assert.ok(deliver !== undefined)
        deliver!(new Error('Connection lost'))
        await call
      })
    })
  })
  assert.deepEqual(leaked, [])
})

test('a fault on a ready SFTP session does not throw an unhandled error event', async () => {
  // ssh2 deletes its own `error` listener as soon as the session reports
  // `ready`, but `doFatalSFTPError` still emits `error` afterwards. An
  // EventEmitter throws on an unhandled `error` event, which dsh reports as a
  // fatal uncaught exception.
  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    let session: EventEmitter | undefined
    await withClientMethod('sftp', function (this: Client, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, sftp: unknown) => void
      const sftp = Object.assign(new EventEmitter(), {
        readFile: (_path: string, done: (error: Error | undefined, data: Buffer) => void) => done(undefined, Buffer.from('ok')),
        end: () => undefined,
      })
      session = sftp
      process.nextTick(() => {
        sftp.emit('ready')
        callback(undefined, sftp)
      })
      return this
    } as unknown as Client['sftp'], async () => {
      const pool = new SshPool(2)
      assert.equal((await pool.sftpRead(host, {}, '/etc/hostname')).toString(), 'ok')
      assert.ok(session !== undefined)
      assert.doesNotThrow(() => {
        session!.emit('error', Object.assign(new Error('Malformed DATA packet'), { level: 'sftp-protocol' }))
      }, 'a protocol fault must not become an uncaught exception')
    })
  })
})

test('a failed fingerprint probe closes the connection it opened', async () => {
  // `offerFingerprint` is the Settings "test" button. When the banner command
  // fails after connecting, the socket used to stay open: the pool does not own
  // this connection, so nothing else would ever close it.
  let ends = 0
  const originalEnd = Client.prototype.end
  Client.prototype.end = function (this: Client) {
    ends += 1
    return this
  } as typeof Client.prototype.end
  try {
    await withConnect(function (this: Client) {
      process.nextTick(() => this.emit('ready'))
      return this
    }, async () => {
      await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
        const callback = rest.find(item => typeof item === 'function') as (error: Error) => void
        process.nextTick(() => callback(new Error('Channel is not open')))
        return this
      } as unknown as Client['exec'], async () => {
        const pool = new SshPool(2)
        await assert.rejects(() => pool.offerFingerprint(host, {}), /Channel is not open/)
        assert.equal(ends, 1, 'the probe must close its own connection')
      })
    })
  } finally {
    Client.prototype.end = originalEnd
  }
})

test('a failed connect releases its concurrency slot', async () => {
  // `reserve` blocks once `maxConnections` is reached. A connect that throws
  // without releasing would wedge every later command for that host forever.
  const exec = function (this: Client, _command: string, ...rest: unknown[]) {
    const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
    process.nextTick(() => {
      const stream = fakeStream()
      callback(undefined, stream)
      setTimeout(() => stream.emit('close', 0), 5)
    })
    return this
  } as unknown as Client['exec']

  // maxConnections of 1 makes a leaked slot a guaranteed deadlock.
  const pool = new SshPool(1)
  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    await withClientMethod('exec', exec, async () => {
      await pool.exec(host, {}, 'echo hi', 5_000)
    })
  })
  await pool.dispose()

  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('error', new Error('connect refused')))
    return this
  }, async () => {
    await withClientMethod('exec', exec, async () => {
      await assert.rejects(() => pool.exec(host, {}, 'echo hi', 5_000), /connect refused/)
    })
  })

  // A successful connect after a failure proves the slot came back.
  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    await withClientMethod('exec', exec, async () => {
      const result = await pool.exec(host, {}, 'echo hi', 5_000)
      assert.equal(result.code, 0)
    })
  })
  await pool.dispose()
})

test('dispose closes a connection that never finished opening', async () => {
  // A pending connect must not keep `dispose` from resolving: dsh calls it on
  // plugin unload and waits.
  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('error', new Error('host unreachable')))
    return this
  }, async () => {
    const pool = new SshPool(2)
    await assert.rejects(() => pool.exec(host, {}, 'echo hi', 5_000), /host unreachable/)
    await pool.dispose()
    assert.equal(pool.hasSession(host.id), false)
  })
})
