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
import { KEEPALIVE_DETECTION_MS, remainingBudget, setChannelOpenWindowForTest, setSlotWaitForTest, setSftpRequestWindowForTest, SshFailure, SshPool, sshConnectOptions } from '../src/ssh-pool.ts'

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

test('a failed probe channel open leaves no unhandled rejection', async () => {
  // `openEval` returns before ssh2 confirms the channel. The exec callback
  // then rejects `done`. The probe caller never awaits `done`, so that
  // rejection has to be observed inside the pool.
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
        const opened = await pool.openEval(host, {}, 'bash --noprofile --norc -c true')
        await new Promise(resolve => setTimeout(resolve, 20))
        opened.close()
      })
    })
  })
  assert.deepEqual(leaked, [], 'a failed probe channel must not become an unhandled rejection')
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
  // dispose() now leaves the pool permanently disposed; tests that reuse it
  // must opt back in explicitly.
  pool.resetForTest()

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

test('dispose leaves the pool disposed so a post-unload acquire is refused', async () => {
  // With the old `disposed = false` reset, a caller holding the pool after
  // unload could open a brand-new connection (and so could a woken waiter).
  const pool = new SshPool(1)
  let connects = 0
  await withConnect(function (this: Client) {
    connects += 1
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    await pool.dispose()
    await assert.rejects(() => pool.exec(host, {}, 'echo hi', 1_000), /SSH pool is disposed/)
    assert.equal(connects, 0, 'a disposed pool must not open a fresh connection')
    assert.equal(pool.hasSession(host.id), false)
  })
})

test('one caller aborting does not fail a concurrent caller on the same host', async () => {
  // A transfer's deadline reaches `acquire()`, but the connection it waits for
  // is shared: `claimPending` hands every caller the same opening. When that
  // opening captured one caller's signal, aborting the transfer rejected every
  // other caller waiting on the host, so a cancelled upload surfaced as a
  // failure of an unrelated `ssh_read` or terminal.
  let commands = 0
  await withConnect(function (this: Client) {
    setTimeout(() => this.emit('ready'), 30)
    return this
  }, async () => {
    await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
      commands += 1
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
      const stream = fakeStream()
      setTimeout(() => {
        callback(undefined, stream)
        stream.emit('close', 0, null)
      }, 1)
      return this
    } as unknown as Client['exec'], async () => {
      const pool = new SshPool(2)
      const controller = new AbortController()
      const cancelled = pool.exec(host, {}, 'upload-leg', 5_000, controller.signal)
        .then(() => 'ok', (error: Error) => error.name)
      const unrelated = pool.exec(host, {}, 'ssh_read', 5_000).then(() => 'ok', (error: Error) => error.name)
      setTimeout(() => controller.abort(), 10)
      const [cancelledResult, unrelatedResult] = await Promise.all([cancelled, unrelated])
      assert.equal(cancelledResult, 'AbortError', 'the cancelled caller keeps its own abort')
      assert.equal(unrelatedResult, 'ok', 'an unrelated caller must still run its command')
      assert.equal(commands, 1, 'only the surviving caller reached the channel')
    })
  })
})

test('closing a transfer lease leaves the shared connection and other SFTP work up', async () => {
  // A transfer's own SFTP channel is closed on failure; the cached session used
  // by ssh_read and the file tree, and the SSH connection itself, must survive.
  const ended: string[] = []
  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    await withClientMethod('sftp', function (this: Client, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, sftp: unknown) => void
      const api = Object.assign(new EventEmitter(), {
        readFile: (_path: string, done: (error: Error | undefined, data: Buffer) => void) => done(undefined, Buffer.from('ok')),
        end: () => { ended.push('sftp'); api.emit('end') },
      })
      process.nextTick(() => {
        api.emit('ready')
        callback(undefined, api)
      })
      return this
    } as unknown as Client['sftp'], async () => {
      const pool = new SshPool(2)
      const lease = await pool.openSftpLease(host, {})
      assert.equal((await pool.sftpRead(host, {}, '/etc/hostname')).toString(), 'ok')
      await lease.close()
      assert.equal(ended.length, 1, 'the lease channel closes')
      assert.equal(pool.hasSession(host.id), true, 'the host stays connected')
      assert.equal((await pool.sftpRead(host, {}, '/etc/hostname')).toString(), 'ok', 'the cached session still works')
      await pool.dispose()
    })
  })
})

test('closing a transfer lease waits past the cooperative window for the server channel close', async () => {
  // A WAN round trip is longer than COOPERATIVE_SETTLE_MS (250ms). Ending the
  // channel is not the same as the server confirming its close: `rm` on a
  // separate exec channel must not run before that confirmation.
  let confirmClose: () => void = () => undefined
  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    await withClientMethod('sftp', function (this: Client, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, sftp: unknown) => void
      const api = Object.assign(new EventEmitter(), {
        end: () => { confirmClose = () => api.emit('end') },
      })
      process.nextTick(() => {
        api.emit('ready')
        callback(undefined, api)
      })
      return this
    } as unknown as Client['sftp'], async () => {
      const pool = new SshPool(2)
      const lease = await pool.openSftpLease(host, {})
      assert.equal(lease.settled?.(), false)
      const closing = lease.close()
      // `session.end()` has already installed the confirmation callback.
      setTimeout(() => confirmClose(), 400)
      const started = Date.now()
      await closing
      const elapsed = Date.now() - started
      assert.ok(elapsed >= 300, `close returned after ${elapsed}ms; it must wait for the server's channel close, not 250ms`)
      assert.equal(lease.settled?.(), true)
      await pool.dispose()
    })
  })
})

test('a caller that aborts while queued never opens a connection', async () => {
  // Removing `reserve(signal)` must not make an abandoned queued call open and
  // cache a connection that then holds the only slot.
  const connects: string[] = []
  await withConnect(function (this: Client, _options: ConnectConfig) {
    connects.push('connect')
    setTimeout(() => this.emit('ready'), 20)
    return this
  }, async () => {
    await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
      const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: () => undefined })
      setTimeout(() => callback(undefined, stream), 1)
      return this
    } as unknown as Client['exec'], async () => {
      const pool = new SshPool(1)
      const hostA = { ...host, id: 'a' }
      const hostB = { ...host, id: 'b' }
      const held = pool.exec(hostA, {}, 'hold', 60_000).catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 40))
      const controller = new AbortController()
      const queued = pool.exec(hostB, {}, 'b', 60_000, controller.signal).then(() => 'ok', (error: Error) => error.name)
      await new Promise(resolve => setTimeout(resolve, 10))
      controller.abort()
      assert.equal(await queued, 'AbortError')
      pool.invalidate('a')
      await new Promise(resolve => setTimeout(resolve, 60))
      assert.equal(pool.hasSession('b'), false, 'the abandoned queued call must not connect')
      void held
      await pool.dispose()
    })
  })
})

test('a caller queued behind a full pool returns instead of waiting forever', async () => {
  // A slot returns only when its connection closes, and a pooled connection
  // outlives every command. With the default maxConnections of 4, the fifth
  // host queued with no timer at all: the tool call's own timeoutMs was
  // ignored and the call never returned.
  let connects = 0
  await withConnect(function (this: Client) {
    connects += 1
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
      const stream = fakeStream()
      process.nextTick(() => {
        callback(undefined, stream)
        stream.emit('close', 0)
      })
      return this
    } as unknown as Client['exec'], async () => {
      const pool = new SshPool(1)
      const held = { ...host, id: 'held' }
      const queued = { ...host, id: 'queued' }
      await pool.exec(held, {}, 'echo hi', 5_000)
      assert.equal(pool.freeSlots(), 0)
      const started = Date.now()
      await assert.rejects(
        () => pool.exec(queued, {}, 'echo hi', 300),
        (error: Error) => error instanceof SshFailure
          && error.stage === 'slots'
          && /no free SSH connection slot/.test(error.message)
          && /maxConnections/.test(error.message),
      )
      const elapsed = Date.now() - started
      assert.ok(elapsed < 3_000, `the queued call returned after ${elapsed}ms; it must honour its own timeout`)
      // The queued host must not become a cached connection just because it once
      // waited: freeing the held slot has to give the grant back, not dial.
      pool.invalidate(held.id)
      await new Promise(resolve => setTimeout(resolve, 80))
      assert.equal(connects, 1, 'an abandoned queued call must never dial')
      assert.equal(pool.freeSlots(), 1, 'the slot handed to the abandoned call must come back')
      await pool.dispose()
    })
  })
})

test('a caller with no timeout still leaves the queue', async () => {
  // `timeoutMs` of 0 means no deadline of the caller's own, which used to mean
  // no deadline at all. The pool's backstop has to end the wait instead.
  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
      const stream = fakeStream()
      process.nextTick(() => {
        callback(undefined, stream)
        stream.emit('close', 0)
      })
      return this
    } as unknown as Client['exec'], async () => {
      const pool = new SshPool(1)
      const restore = setSlotWaitForTest(120)
      try {
        await pool.exec({ ...host, id: 'held' }, {}, 'echo hi', 5_000)
        await assert.rejects(
          () => pool.exec({ ...host, id: 'queued' }, {}, 'echo hi', 0),
          (error: Error) => /no free SSH connection slot/.test(error.message),
        )
      } finally {
        restore()
        await pool.dispose()
      }
    })
  })
})

test('a channel-open that is never answered means the link is dead', async () => {
  // A silently dead link keeps the socket ESTABLISHED and never invokes the
  // exec callback. Without the watchdog every command on that connection burned
  // its own full timeout and none of them noticed.
  const restore = setChannelOpenWindowForTest(60)
  try {
    let connects = 0
    await withConnect(function (this: Client) {
      connects += 1
      process.nextTick(() => this.emit('ready'))
      return this
    }, async () => {
      await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
        const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
        // First connection: never answer. Second: answer normally.
        if (connects === 1) return this
        const stream = fakeStream()
        process.nextTick(() => {
          callback(undefined, stream)
          stream.emit('close', 0)
        })
        return this
      } as unknown as Client['exec'], async () => {
        const pool = new SshPool(4)
        const started = Date.now()
        const result = await pool.exec(host, {}, 'echo hi', 60_000)
        const elapsed = Date.now() - started
        assert.equal(result.code, 0, 'the command must be replayed on a fresh connection')
        assert.ok(elapsed < 5_000, `the dead link took ${elapsed}ms to notice`)
        assert.equal(connects, 2, 'a dead connection must be replaced, not reused')
        await pool.dispose()
      })
    })
  } finally {
    restore()
  }
})

test('a dead link releases its connection slot so later calls are not stuck', async () => {
  // The dead connection holds a slot until something closes it. Detecting the
  // dead link has to return that slot, or the pool starves exactly when the
  // network is the problem.
  const restore = setChannelOpenWindowForTest(60)
  try {
    let connects = 0
    await withConnect(function (this: Client) {
      connects += 1
      process.nextTick(() => this.emit('ready'))
      return this
    }, async () => {
      await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
        const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
        if (connects === 1) return this
        const stream = fakeStream()
        process.nextTick(() => {
          callback(undefined, stream)
          stream.emit('close', 0)
        })
        return this
      } as unknown as Client['exec'], async () => {
        const pool = new SshPool(1)
        await pool.exec(host, {}, 'echo hi', 5_000)
        assert.equal(pool.freeSlots(), 0)
        await pool.exec(host, {}, 'echo hi', 5_000)
        assert.equal(pool.freeSlots(), 0, 'the replacement connection keeps the slot it took')
        assert.equal(pool.hasSession(host.id), true, 'the replacement connection is the cached one')
        await pool.dispose()
      })
    })
  } finally {
    restore()
  }
})

test('the command timer receives what is left, not a fresh timeoutMs', async () => {
  // `open()` used to hand the same `timeoutMs` to both `acquire()` and
  // `openChannel()`, so time already spent queueing or handshaking was charged
  // AGAIN to the command: a 300 ms budget took 453 ms in practice.
  //
  // Total elapsed time alone cannot see this — a queue timeout of the same
  // length ends the call first, which is why an earlier version of this case
  // passed even with the fix reverted. The handshake delay is what makes the
  // two behaviours distinguishable: 500 ms budget minus 200 ms handshake must
  // leave 300 ms for the command, so the call ends near 500 ms, not 700 ms.
  let connects = 0
  await withConnect(function (this: Client) {
    connects += 1
    // The handshake itself consumes part of the caller's budget.
    setTimeout(() => this.emit('ready'), 200)
    return this
  }, async () => {
    await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
      const stream = Object.assign(fakeStream(), {
        // Answer the timeout path the way a real channel does, so the reading
        // is the command timer rather than the pool's 2 s fallback.
        signal: (_name: string, done: () => void) => {
          done()
          setImmediate(() => stream.emit('close', null, 'KILL'))
        },
        close: () => { setImmediate(() => stream.emit('close', null, 'KILL')) },
      })
      process.nextTick(() => callback(undefined, stream))
      return this
    } as unknown as Client['exec'], async () => {
      const pool = new SshPool(4)
      const started = Date.now()
      const result = await pool.exec(host, {}, 'cmd', 500)
      const elapsed = Date.now() - started
      void connects
      assert.equal(result.timedOut, true, 'the command must run out of budget')
      assert.ok(
        elapsed < 620,
        `the call took ${elapsed}ms: a 500ms budget minus a 200ms handshake must leave 300ms for the command`,
      )
      await pool.dispose()
    })
  })
})

test('remainingBudget clamps instead of returning a negative delay', () => {
  // Node treats a negative setTimeout delay as 0, and the clamp keeps the
  // reported number meaningful in the error message and in the watchdog.
  const now = Date.now()
  assert.equal(remainingBudget(undefined, 400), 400, 'no deadline keeps the caller value')
  assert.equal(remainingBudget(undefined, 0), 0, 'a 0 timeout stays 0 (no deadline)')
  assert.equal(remainingBudget(now + 250, 400), 250, 'an absolute budget wins over the nominal timeout')
  assert.equal(remainingBudget(now - 10, 400), 1, 'an elapsed budget is the smallest positive delay')
})

test('a command cut short by its own timeout is not a dead link', async () => {
  // A healthy server needs longer than the command's deadline to confirm the
  // channel-open. Treating that as a dead link dropped the shared connection
  // and with it every sidebar terminal and PTC channel on the host.
  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
      const stream = fakeStream()
      // Confirmed after 80 ms: healthy, but slower than a 200 ms caller allows.
      setTimeout(() => callback(undefined, stream), 80)
      return this
    } as unknown as Client['exec'], async () => {
      const pool = new SshPool(4)
      const result = await pool.exec(host, {}, 'slow-open', 200)
      assert.equal(result.timedOut, true, 'a short deadline must surface as a timeout')
      assert.equal(pool.hasSession(host.id), true, 'the shared connection must survive a caller giving up')
      await pool.dispose()
    })
  })
})

test('a command answered after the dead-link verdict is closed, not run', async () => {
  // The watchdog rejects and drops the connection; the server can still confirm
  // the channel afterwards. Writing stdin then would run a tool call that was
  // already reported as failed — and that `exec` may already have replayed.
  const restore = setChannelOpenWindowForTest(20)
  const writes: string[] = []
  try {
    await withConnect(function (this: Client) {
      process.nextTick(() => this.emit('ready'))
      return this
    }, async () => {
      await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
        const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
        const stream = Object.assign(fakeStream(), {
          write: (data: Buffer | string) => {
            writes.push(Buffer.isBuffer(data) ? data.toString() : data)
            return true
          },
          end: () => undefined,
        })
        // Confirmed well after the watchdog window, on both the first attempt
        // and the replay (the replay dials a fresh connection, so it gets its
        // own call here).
        setTimeout(() => callback(undefined, stream), 60)
        return this
      } as unknown as Client['exec'], async () => {
        const pool = new SshPool(4)
        // The first attempt reports the dead link and replays; the replay's own
        // budget is already spent, so the call settles as a timeout. Either
        // outcome is fine here — what matters is that the late channel stays
        // silent.
        const settled = await pool.exec(host, {}, 'cmd', 30, undefined, 'STDIN-DATA').then(
          result => `returned timedOut=${result.timedOut}`,
          (error: Error) => `rejected: ${error.message.slice(0, 40)}`,
        )
        assert.ok(
          /returned timedOut=true|rejected/.test(settled),
          `the call must settle, got: ${settled}`,
        )
        await new Promise(resolve => setTimeout(resolve, 100))
        assert.deepEqual(writes, [], 'a late channel must not receive stdin')
        await pool.dispose()
      })
    })
  } finally {
    restore()
  }
})

test('an abandoned opening releases its slot instead of holding it for readyTimeout', async () => {
  // ssh2's handshake budget is a fixed 20 s. When every caller gave up, the
  // opening still kept its slot for that whole time, so in a small pool every
  // other host got "no free connection slot" for something nobody wanted.
  await withConnect(function (this: Client) {
    // A handshake that never completes.
    return this
  }, async () => {
    const pool = new SshPool(1)
    await assert.rejects(() => pool.exec({ ...host, id: 'gone' }, {}, 'x', 200), /did not become ready/)
    assert.equal(pool.freeSlots(), 1, 'the slot must come back as soon as the last caller leaves')
    // And the next host must not wait for the abandoned handshake either.
    const started = Date.now()
    await assert.rejects(() => pool.exec({ ...host, id: 'next' }, {}, 'y', 300), /did not become ready/)
    const waited = Date.now() - started
    assert.ok(waited < 1_500, `the next host waited ${waited}ms behind an abandoned opening`)
    await pool.dispose()
  })
})

test('cancelling a PTY allocation returns without waiting for the watchdog', async () => {
  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    await withClientMethod('exec', function (this: Client) {
      // The server never confirms the PTY channel.
      return this
    } as unknown as Client['exec'], async () => {
      const pool = new SshPool(4)
      const controller = new AbortController()
      const started = Date.now()
      const pending = pool.openPty(host, {}, {
        command: 'bash',
        term: 'xterm-256color',
        cols: 80,
        rows: 24,
        signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 30)
      await assert.rejects(() => pending, /pty allocation aborted/)
      const elapsed = Date.now() - started
      assert.ok(elapsed < 1_000, `the cancel took ${elapsed}ms; it must not wait for the watchdog window`)
      await pool.dispose()
    })
  })
})

test('a cached SFTP channel on a dead link reports instead of hanging on keepalive', async () => {
  // The channel-open watchdog covers only the first use of a host. Afterwards
  // the channel is cached, so a link that dies leaves every stat/readdir/realpath
  // hanging until SSH keepalive gives up (15 s × 4 = 60 s). That is what made
  // `read`, the file tree and the directory picker look frozen.
  await withConnect(function (this: Client) {
    process.nextTick(() => this.emit('ready'))
    return this
  }, async () => {
    let answer = true
    await withClientMethod('sftp', function (this: Client, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, sftp: unknown) => void
      const sftp = Object.assign(new EventEmitter(), {
        end: () => undefined,
        // Every request is silently dropped once `answer` flips: that is what a
        // dead link looks like at this layer.
        stat: (_path: string, done: (error: Error | undefined, stats: unknown) => void) => {
          if (!answer) return
          done(undefined, { size: 4, mode: 0o644, isDirectory: () => false })
        },
        readdir: (_path: string, done: (error: Error | undefined, list: unknown[]) => void) => {
          if (!answer) return
          done(undefined, [])
        },
        realpath: (_path: string, done: (error: Error | undefined, resolved: string) => void) => {
          if (!answer) return
          done(undefined, '/etc/hostname')
        },
        readFile: (_path: string, done: (error: Error | undefined, data: Buffer) => void) => {
          if (!answer) return
          done(undefined, Buffer.from('body'))
        },
        writeFile: (_path: string, _body: Buffer | string, done: (error: Error | undefined) => void) => {
          if (!answer) return
          done(undefined)
        },
        open: (_path: string, _flags: string, done: (error: Error | undefined, handle: Buffer) => void) => {
          if (!answer) return
          done(undefined, Buffer.from('handle'))
        },
        read: (_handle: Buffer, buffer: Buffer, _offset: number, length: number, _position: number, done: (error: Error | undefined, bytesRead: number) => void) => {
          if (!answer) return
          done(undefined, length)
        },
        close: (_handle: Buffer, done: (error: Error | undefined) => void) => done(undefined),
      })
      process.nextTick(() => {
        sftp.emit('ready')
        callback(undefined, sftp)
      })
      return this
    } as unknown as Client['sftp'], async () => {
      const pool = new SshPool(2)
      const restore = setSftpRequestWindowForTest(60)
      // First request opens and caches the channel.
      await pool.sftpStat(host, {}, '/etc/hostname')
      answer = false
      // Every operation that reuses the cached channel must report. Covering
      // only `stat` is what let the first version of this fix miss `read` and
      // `write` — the `read` tool's own path — which still hung forever.
      const operations: Array<[string, () => Promise<unknown>]> = [
        ['stat', () => pool.sftpStat(host, {}, '/etc/hostname')],
        ['list', () => pool.sftpList(host, {}, '/etc')],
        ['realpath', () => pool.sftpRealpath(host, {}, '.')],
        ['read', () => pool.sftpRead(host, {}, '/etc/hostname')],
        ['read+capped', () => pool.sftpRead(host, {}, '/etc/hostname', 1024)],
        ['write', () => pool.sftpWrite(host, {}, '/tmp/x', 'body')],
        ['readChunks', async () => { for await (const _chunk of pool.sftpReadChunks(host, {}, '/etc/hostname')) { /* drain */ } }],
        // A cancel-only signal is not a deadline: the `read` tool passes one.
        ['read+signal', () => pool.sftpRead(host, {}, '/etc/hostname', undefined, new AbortController().signal)],
      ]
      for (const [name, operation] of operations) {
        const started = Date.now()
        await assert.rejects(
          operation,
          (error: Error) => error instanceof SshFailure && /did not answer within/.test(error.message),
          `${name} must report on a dead cached channel`,
        )
        const elapsed = Date.now() - started
        assert.ok(elapsed < 5_000, `${name} waited ${elapsed}ms; the request ceiling must end it`)
      }
      restore()
      await pool.dispose()
    })
  })
})

test('the keepalive window is derived from ssh2s formula, not a hand count', () => {
  // ssh2 does not give up at `interval × countMax`. It pings every interval and
  // drops the connection only when the unanswered count EXCEEDS countMax, so
  // the real window is interval × (countMax + 1).
  //
  // This constant exists because the number was written out by hand twice and
  // was wrong both times: countMax = 2 at a 15 s interval is 45 s, not 30 s.
  const options = sshConnectOptions(host)
  assert.equal(KEEPALIVE_DETECTION_MS, (options.keepaliveInterval as number) * ((options.keepaliveCountMax as number) + 1))
  assert.equal(KEEPALIVE_DETECTION_MS, 30_000)
  // Reaching 30 s by shortening the interval rather than the count keeps two
  // missed replies tolerable, so a brief blip cannot kill a healthy session.
  assert.ok((options.keepaliveCountMax as number) >= 2, 'one lost reply must not tear down a connection')
})

test('a replay that cannot reconnect says so instead of blaming the handshake', async () => {
  // The first attempt is judged dead by the watchdog, then the reconnect never
  // comes up. The retry's own error is "did not become ready within 18000 ms",
  // which on its own reads like the FIRST connect was simply slow. It must name
  // both facts and stay marked as a dead link.
  const restore = setChannelOpenWindowForTest(30)
  let connects = 0
  try {
    await withConnect(function (this: Client) {
      connects += 1
      // Only the first connection is healthy; the replay's never completes.
      if (connects === 1) process.nextTick(() => this.emit('ready'))
      return this
    }, async () => {
      await withClientMethod('exec', function (this: Client) {
        // The channel-open is never answered, so the watchdog fires.
        return this
      } as unknown as Client['exec'], async () => {
        const pool = new SshPool(4)
        const started = Date.now()
        await assert.rejects(
          () => pool.exec(host, {}, 'cmd', 3_000),
          (error: Error) => {
            assert.ok(error instanceof SshFailure)
            assert.equal(error.stage, 'connect')
            assert.equal(error.connectionDead, true, 'a dead link must stay classifiable after a failed replay')
            assert.match(error.message, /judged dead/)
            assert.match(error.message, /replaying also failed/)
            return true
          },
        )
        const elapsed = Date.now() - started
        assert.ok(elapsed < 3_500, `the call took ${elapsed}ms for a 3000ms budget`)
        await pool.dispose()
      })
    })
  } finally {
    restore()
  }
})

test('a caller joining an aborted opening dials its own connection', async () => {
  // `leave()` aborts the shared opening when its last caller gives up, but the
  // entry survives until the opening settles. A caller arriving in that window
  // used to join the cancelled flight and fail with an error of its own making.
  //
  // HONEST LIMIT: this case does NOT fail if the guard is removed. The window
  // is a single microtask wide and the entry is normally gone before a later
  // caller can observe it, so the assertion below is a guard against a
  // regression that widens the window, not a reproduction of the original
  // race. It is kept because it also pins the sharing behaviour that the guard
  // must not break.
  let connects = 0
  await withConnect(function (this: Client) {
    connects += 1
    // Slow enough that the abort lands mid-handshake.
    setTimeout(() => this.emit('ready'), 300)
    return this
  }, async () => {
    await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
      const stream = fakeStream()
      process.nextTick(() => {
        callback(undefined, stream)
        stream.emit('close', 0)
      })
      return this
    } as unknown as Client['exec'], async () => {
      const pool = new SshPool(4)
      const first = pool.exec(host, {}, 'a', 50).then(() => 'ok', () => 'gave up')
      // Land inside the abort window, after the first caller has left.
      await new Promise(resolve => setTimeout(resolve, 60))
      const second = pool.exec(host, {}, 'b', 5_000)
      assert.equal(await first, 'gave up')
      const result = await second
      assert.equal(result.code, 0, 'the later caller must succeed on its own connection')
      assert.equal(connects, 2, 'it must dial rather than reuse the cancelled flight')
      await pool.dispose()
    })
  })
})

test('concurrent callers on one host still share a single connection', async () => {
  // The abort-window guard must not turn every caller into its own dial.
  let connects = 0
  await withConnect(function (this: Client) {
    connects += 1
    setTimeout(() => this.emit('ready'), 50)
    return this
  }, async () => {
    await withClientMethod('exec', function (this: Client, _command: string, ...rest: unknown[]) {
      const callback = rest.find(item => typeof item === 'function') as (error: Error | undefined, stream: unknown) => void
      const stream = fakeStream()
      process.nextTick(() => {
        callback(undefined, stream)
        stream.emit('close', 0)
      })
      return this
    } as unknown as Client['exec'], async () => {
      const pool = new SshPool(4)
      await Promise.all([1, 2, 3].map(index => pool.exec(host, {}, `c${index}`, 5_000)))
      assert.equal(connects, 1, 'three concurrent callers must share one dial')
      await pool.dispose()
    })
  })
})
