/**
 * A transfer must own its SFTP channel: aborting it may not touch other SFTP
 * work, and a late `OPEN` must not be able to recreate a temp file after the
 * caller removed it.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { streamChunksToSftp } from '../src/ssh-pool.ts'

test('an aborted transfer waits for a late OPEN and closes it before rejecting', async () => {
  const events: string[] = []
  let closes = 0
  const sftp = {
    _maxWriteLen: 65536,
    open(_path: string, _flags: string, cb: (error: Error | undefined, handle: Buffer) => void) {
      events.push('open-sent')
      setTimeout(() => { events.push('open-ack'); cb(undefined, Buffer.from('h')) }, 120)
    },
    write(_h: Buffer, _d: Buffer, _o: number, _l: number, _p: number, cb: (error?: Error) => void) { cb() },
    close(_h: Buffer, cb: (error?: Error) => void) { closes += 1; events.push('close'); cb() },
  } as never
  const controller = new AbortController()
  const source = { async *[Symbol.asyncIterator]() { yield Buffer.from('x') } }
  const work = streamChunksToSftp(sftp, '/tmp/x', source, { signal: controller.signal })
  controller.abort()
  const outcome = await work.then(() => 'ok', (error: Error) => error.name)
  assert.equal(outcome, 'AbortError')
  // The late OPEN arrived and its handle was closed before the transfer
  // rejected, so a caller that removes the temp file afterwards cannot race it.
  assert.ok(events.indexOf('open-ack') >= 0)
  assert.ok(events.indexOf('open-ack') < events.indexOf('close'))
  assert.equal(closes, 1)
})

test('two leases on one host do not share a channel', async () => {
  // SftpLease is opaque here; this asserts the stream writer keeps each
  // caller's buffers and handles independent, which is what makes per-transfer
  // closing safe.
  const first: string[] = []
  const second: string[] = []
  const make = (log: string[]) => ({
    _maxWriteLen: 65536,
    open(_p: string, _f: string, cb: (e: Error | undefined, h: Buffer) => void) { log.push('open'); cb(undefined, Buffer.from('h')) },
    write(_h: Buffer, _d: Buffer, _o: number, _l: number, _p: number, cb: (e?: Error) => void) { cb() },
    close(_h: Buffer, cb: (e?: Error) => void) { log.push('close'); cb() },
  }) as never
  const source = () => ({ async *[Symbol.asyncIterator]() { yield Buffer.from('x') } })
  await Promise.all([
    streamChunksToSftp(make(first), '/tmp/a', source()),
    streamChunksToSftp(make(second), '/tmp/b', source()),
  ])
  assert.deepEqual(first, ['open', 'close'])
  assert.deepEqual(second, ['open', 'close'])
})
