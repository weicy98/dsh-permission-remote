/**
 * Throughput of the read path, and the socket option it depends on.
 *
 * Both cases here were measured on a LAN host before the fix: one READ at a
 * time on a connection where ssh2 never called `setNoDelay` moved 32 MiB at
 * 1.4 MiB/s (45 ms per 64 KiB request). The same link reached 40+ MiB/s with
 * Nagle disabled and a window of reads in flight. These tests pin the two
 * causes separately so neither can silently come back.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '../src/ssh2-client.ts'
import type { HostConfig } from '../src/config.ts'
import { readOpenChunks, SshPool } from '../src/ssh-pool.ts'

const host: HostConfig = {
  id: 'host118',
  name: '118',
  host: '192.168.44.118',
  port: 22,
  username: 'root',
  auth: 'password',
  privateKeyPath: '',
  fingerprint: 'SHA256:abc',
  opsPolicy: 'ask',
}

const CHUNK = 64 * 1024

/** A file of `chunks` full chunks; byte `i` is `(i / CHUNK) & 0xff`. */
function bodyOf(chunks: number): Buffer {
  const body = Buffer.alloc(chunks * CHUNK)
  for (let index = 0; index < chunks; index += 1) body.fill(index & 0xff, index * CHUNK, (index + 1) * CHUNK)
  return body
}

interface ReadProbe {
  sftp: unknown
  /** Peak number of unanswered READ requests. */
  peak: () => number
  /** Every requested offset, in request order rather than completion order. */
  offsets: number[]
  /** Every requested length, in the same order as `offsets`. */
  lengths: number[]
  closes: () => number
}

/**
 * A server that answers every read from `body`. `delay` decides when a reply
 * lands, so a serial reader (peak 1) is distinguishable from one with a window.
 */
function fakeReader(body: Buffer, options: { maxReadLen?: number, replyBytes?: number, delay?: () => Promise<void> } = {}): ReadProbe {
  const offsets: number[] = []
  const lengths: number[] = []
  let inflight = 0
  let peak = 0
  let closes = 0
  const replyBytes = options.replyBytes ?? Number.MAX_SAFE_INTEGER
  const sftp = {
    _maxReadLen: options.maxReadLen,
    open(_path: string, _flags: string, callback: (error: Error | undefined, handle: Buffer) => void) {
      callback(undefined, Buffer.from('handle'))
    },
    read(_handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error: Error | undefined, bytesRead: number) => void) {
      inflight += 1
      peak = Math.max(peak, inflight)
      offsets.push(position)
      lengths.push(length)
      const take = Math.max(0, Math.min(length, replyBytes, body.length - position))
      body.copy(buffer, offset, position, position + take)
      void Promise.resolve(options.delay?.()).then(() => {
        inflight -= 1
        callback(undefined, take)
      })
    },
    close(_handle: Buffer, callback: (error: Error | undefined) => void) {
      closes += 1
      callback(undefined)
    },
  }
  return { sftp, peak: () => peak, offsets, lengths, closes: () => closes }
}

async function collect(sftp: unknown, path = '/big'): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of readOpenChunks(sftp as never, path)) parts.push(Buffer.from(chunk))
  return Buffer.concat(parts)
}

test('reads a file with a window of requests in flight and yields the bytes in order', async () => {
  const body = bodyOf(40)
  let release: (() => void) | undefined
  let started = 0
  const probe = fakeReader(body, {
    delay: () => {
      started += 1
      // The first reply waits for a sibling request, which a serial reader
      // never sends — so this only resolves once a window is really used.
      if (started === 1) {
        return new Promise<void>(resolve => {
          release = resolve
          setTimeout(resolve, 200)
        })
      }
      release?.()
      return Promise.resolve()
    },
  })
  const got = await collect(probe.sftp)
  assert.ok(probe.peak() > 1, 'a single request at a time is what made the copy slow')
  assert.ok(probe.peak() <= 16, 'the window must stay bounded')
  assert.deepEqual(got, body, 'a pipelined read must not lose or reorder bytes')
  assert.equal(probe.closes(), 1)
})

test('a short reply re-anchors the window instead of leaving a gap', async () => {
  const body = bodyOf(6)
  // The server answers 1000 bytes no matter how much is asked for: the queued
  // offsets were spaced by the full request, so they no longer line up.
  const probe = fakeReader(body, { replyBytes: 1000 })
  const got = await collect(probe.sftp)
  assert.deepEqual(got, body, 'a short reply must not skip or duplicate bytes')
  assert.equal(probe.closes(), 1)
})

test('a server advertising a larger read packet is asked for it', async () => {
  const body = bodyOf(8)
  const probe = fakeReader(body, { maxReadLen: 261_120 })
  const got = await collect(probe.sftp)
  assert.deepEqual(got, body)
  // One request per advertised packet size instead of one per 64 KiB window:
  // the packet size is what decides how many round trips a file costs.
  assert.equal(probe.lengths[0], 261_120)
  assert.equal(probe.offsets[0], 0)
  assert.equal(probe.offsets[1], 261_120)
})

test('a consumer that stops early closes the handle and leaves no unhandled rejection', async () => {
  const body = bodyOf(40)
  const probe = fakeReader(body)
  const seen: unknown[] = []
  const onRejection = (reason: unknown) => seen.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    const chunks = readOpenChunks(probe.sftp as never, '/big')
    const first = await chunks.next()
    assert.equal(Buffer.from(first.value ?? []).length, CHUNK)
    await chunks.return(undefined)
    // The window that was already queued rejects when the handle closes; that
    // rejection belongs to the abandoned reads, not to the dsh process.
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(probe.closes(), 1)
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  assert.deepEqual(seen, [], 'an abandoned window must not become an unhandled rejection')
})

test('a new connection disables Nagle on its socket', async () => {
  // Nagle plus the peer's delayed ACK cost ~45 ms per unanswered SFTP request
  // on the host this was measured against, which is what turned a copy into a
  // 1.4 MiB/s trickle. ssh2 does not call `setNoDelay` itself, and the option
  // has to land on the socket before the first request, so the handshake is
  // the only place it can be set.
  const seen: boolean[] = []
  const originalConnect = Client.prototype.connect
  const originalNoDelay = Client.prototype.setNoDelay
  const originalExec = Client.prototype.exec
  Client.prototype.connect = function (this: Client) {
    process.nextTick(() => this.emit('ready'))
    return this as unknown as Client
  } as unknown as typeof Client.prototype.connect
  Client.prototype.setNoDelay = function (this: Client, noDelay?: boolean) {
    seen.push(noDelay === true)
    return this
  } as typeof Client.prototype.setNoDelay
  Client.prototype.exec = function (this: Client, _command: string, ...rest: unknown[]) {
    const callback = rest.find(item => typeof item === 'function') as (error: Error) => void
    process.nextTick(() => callback(new Error('not a real host')))
    return this as unknown as Client
  } as unknown as Client['exec']
  try {
    const pool = new SshPool(2)
    await pool.exec(host, { password: 'x' }, 'true', 5_000).catch(() => undefined)
    await pool.dispose()
  } finally {
    Client.prototype.connect = originalConnect
    Client.prototype.setNoDelay = originalNoDelay
    Client.prototype.exec = originalExec
  }
  assert.deepEqual(seen, [true], 'the connection must disable Nagle exactly once, up front')
})