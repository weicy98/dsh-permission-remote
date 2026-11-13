import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { finishOrCleanup, SshPool, streamChunksToSftp, streamLocalToSftp, type SshFailure } from '../src/ssh-pool.ts'

const CHUNK = 64 * 1024

function fakeSftp(onWrite?: (bytes: number) => Promise<void> | void, maxWriteLen?: number) {
  const writes: Buffer[] = []
  let inflight = 0
  let inflightBytes = 0
  let peak = 0
  let peakBytes = 0
  let closes = 0
  const sftp = {
    _maxWriteLen: maxWriteLen,
    open(_path: string, _flags: string, callback: (error: Error | undefined, handle: Buffer) => void) {
      callback(undefined, Buffer.from('handle'))
    },
    write(
      _handle: Buffer,
      buffer: Buffer,
      offset: number,
      length: number,
      _position: number,
      callback: (error: Error | undefined, endOffset: number) => void,
    ) {
      inflight += 1
      inflightBytes += length
      peak = Math.max(peak, inflight)
      peakBytes = Math.max(peakBytes, inflightBytes)
      const copy = Buffer.from(buffer.subarray(offset, offset + length))
      // Report ssh2's end index, not a byte count.
      void Promise.resolve(onWrite?.(copy.length)).then(() => {
        writes.push(copy)
        inflight -= 1
        inflightBytes -= length
        callback(undefined, offset + length)
      }, (error: Error) => {
        inflight -= 1
        inflightBytes -= length
        callback(error, offset)
      })
    },
    close(_handle: Buffer, callback: (error: Error | undefined) => void) {
      closes += 1
      callback(undefined)
    },
  }
  return { sftp, writes, peak: () => peak, peakBytes: () => peakBytes, closes: () => closes }
}

test('a local file is written one chunk at a time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stream-'))
  try {
    const source = join(dir, 'in.bin')
    const body = Buffer.alloc(CHUNK + 10, 0x7a)
    await writeFile(source, body)
    let releaseFirst: (() => void) | undefined
    let started = 0
    const fake = fakeSftp(() => {
      started += 1
      if (started === 1) return new Promise<void>(resolve => { releaseFirst = resolve })
      releaseFirst?.()
      return undefined
    })
    const bytes = await streamLocalToSftp(fake.sftp as never, source, '/remote/in.bin', 0)
    assert.equal(bytes, body.length)
    assert.ok(fake.peak() > 1)
    assert.ok(fake.peak() <= 16)
    assert.equal(fake.writes.length, 2)
    assert.ok(fake.writes.every(chunk => chunk.length <= CHUNK))
    assert.deepEqual(Buffer.concat(fake.writes), body)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a file that grows past the ceiling stops the copy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stream-grow-'))
  try {
    const source = join(dir, 'grow.bin')
    await writeFile(source, Buffer.alloc(4, 0x01))
    let grew = false
    const fake = fakeSftp(() => {
      if (grew) return
      grew = true
      appendFileSync(source, Buffer.alloc(20, 0x02))
    })
    await assert.rejects(
      () => streamLocalToSftp(fake.sftp as never, source, '/remote/grow.bin', 8),
      (error: SshFailure) => error.limitExceeded === true && /over the 8 byte transfer ceiling/.test(error.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the bytes already written are still the original prefix when growth trips the ceiling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stream-prefix-'))
  try {
    const source = join(dir, 'grow.bin')
    await writeFile(source, Buffer.from('abcd'))
    const fake = fakeSftp(() => {
      appendFileSync(source, Buffer.alloc(20, 0x02))
    })
    await assert.rejects(() => streamLocalToSftp(fake.sftp as never, source, '/remote/grow.bin', 8))
    const written = Buffer.concat(fake.writes)
    assert.ok(written.length <= 8)
    assert.deepEqual(written.subarray(0, 4), Buffer.from('abcd'))
    assert.equal(await readFile(source).then(buf => buf.length) > 4, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a server packet limit caps each write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stream-packet-'))
  try {
    const source = join(dir, 'in.bin')
    const body = Buffer.alloc(50_000, 0x11)
    await writeFile(source, body)
    const fake = fakeSftp(undefined, 20_000)
    const bytes = await streamLocalToSftp(fake.sftp as never, source, '/remote/in.bin', 0)
    assert.equal(bytes, body.length)
    assert.ok(fake.writes.length >= 3)
    assert.ok(fake.writes.every(chunk => chunk.length <= 20_000))
    assert.deepEqual(Buffer.concat(fake.writes), body)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a queued reservation is granted in order and each grant takes one slot', async () => {
  const pool = new SshPool(1)
  const internal = pool as unknown as { reserve(): Promise<void>, release(): void, active: number }
  await internal.reserve()
  const first = internal.reserve()
  const second = internal.reserve()
  assert.equal(internal.active, 1, 'the limit is still reached')
  internal.release()
  await first
  assert.equal(internal.active, 1, 'the first queued waiter took the freed slot')
  internal.release()
  await second
  assert.equal(internal.active, 1)
  internal.release()
  assert.equal(internal.active, 0)
})

test('an aborted caller detaches from the shared connection without leaking a slot', async () => {
  // A transfer deadline must stop this caller waiting, but the pending
  // connection stays available for everyone else on the host, so the slot it
  // eventually takes is never orphaned: the caller that detaches is not the
  // one that owns it.
  const pool = new SshPool(1)
  const internal = pool as unknown as { reserve(): Promise<void>, release(): void, active: number }
  await internal.reserve()
  const queued = internal.reserve()
  assert.equal(internal.active, 1)
  internal.release()
  await queued
  assert.equal(internal.active, 1, 'the queued waiter, not a detached caller, owns the slot')
  internal.release()
  assert.equal(internal.active, 0)
})

test('openEval drains stderr that no caller reads', async () => {
  const pool = new SshPool(1)
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  pool.openPtcExec = (async () => ({
    stdout,
    stderr,
    done: Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, stdoutTruncated: false, stderrTruncated: false }),
    write() {},
    end() {},
    close() {},
  })) as never
  await pool.openEval({} as never, {}, 'probe')
  for (let index = 0; index < 4; index += 1) stderr.write(Buffer.alloc(1024 * 1024))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stderr.writableLength, 0)
})

test('the in-flight budget is measured in bytes for copy and local upload', async () => {
  const slow = () => new Promise<void>(resolve => setTimeout(resolve, 5))
  const chunks = Array.from({ length: 40 }, () => Buffer.alloc(CHUNK, 0x55))
  const copyFake = fakeSftp(slow, 8_192)
  await streamChunksToSftp(copyFake.sftp as never, '/remote/copy.bin', source(chunks).iterable, { maxBytes: 0 })
  assert.ok(copyFake.peakBytes() <= 1024 * 1024, `copy peak ${copyFake.peakBytes()} exceeds 1 MiB`)
  assert.ok(copyFake.peakBytes() >= 1024 * 1024 - CHUNK, `copy peak ${copyFake.peakBytes()} did not fill the budget`)

  const dir = await mkdtemp(join(tmpdir(), 'dsh-stream-budget-'))
  try {
    const file = join(dir, 'in.bin')
    await writeFile(file, Buffer.concat(chunks))
    const uploadFake = fakeSftp(slow, 260_096)
    await streamLocalToSftp(uploadFake.sftp as never, file, '/remote/upload.bin', 0)
    assert.ok(uploadFake.peakBytes() <= 1024 * 1024, `upload peak ${uploadFake.peakBytes()} exceeds 1 MiB`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('finishOrCleanup settles near the cooperative window and awaits cleanup', async () => {
  const controller = new AbortController()
  const events: string[] = []
  const started = Date.now()
  controller.abort()
  await assert.rejects(
    () => finishOrCleanup(new Promise(() => {}), controller.signal, async () => { events.push('rm') }),
    (error: Error) => error.name === 'AbortError',
  )
  // The 5 s bound is for cleanup itself, not for waiting out a hung transfer.
  assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started}ms`)
  assert.deepEqual(events, ['rm'])
})

test('finishOrCleanup always confirms the channel close before rm', async () => {
  // The transfer answers its own abort promptly. The old code skipped
  // `beforeCleanup` in that case and ran `rm` first, letting a server-side OPEN
  // that was still in flight recreate the temp file afterwards.
  const events: string[] = []
  const controller = new AbortController()
  const work = Promise.reject(new Error('open finished after abort'))
  controller.abort()
  await assert.rejects(
    () => finishOrCleanup(work, controller.signal, async () => { events.push('rm') }, async () => { await new Promise(resolve => setTimeout(resolve, 50)); events.push('close') }),
    (error: Error) => error.name === 'AbortError',
  )
  assert.deepEqual(events, ['close', 'rm'])
})

test('finishOrCleanup skips rm when the channel close is not confirmed', async () => {
  const events: string[] = []
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => finishOrCleanup(Promise.reject(new Error('aborted')), controller.signal, async () => { events.push('rm') }, async () => false),
    (error: Error) => error.name === 'AbortError',
  )
  assert.deepEqual(events, [])
})

test('cleanup waits until a late open has created the temp file', async () => {
  const events: string[] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const controller = new AbortController()
  const work = (async () => {
    await gate
    events.push('created')
    throw new Error('open finished after abort')
  })()
  controller.abort()
  const finished = finishOrCleanup(work, controller.signal, async () => {
    events.push('rm')
  })
  assert.deepEqual(events, [])
  release()
  await assert.rejects(finished, (error: Error) => error.name === 'AbortError')
  assert.deepEqual(events, ['created', 'rm'])
})

test('a fifo is refused without waiting for a writer', async () => {
  if (process.platform === 'win32') return
  const dir = await mkdtemp(join(tmpdir(), 'dsh-stream-fifo-'))
  try {
    const source = join(dir, 'pipe')
    execFileSync('mkfifo', [source])
    await assert.rejects(
      () => streamLocalToSftp(fakeSftp().sftp as never, source, '/remote/pipe', 0),
      (error: NodeJS.ErrnoException) => error.code === 'ENXIO' || /not a regular file/.test(error.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ─────────── streamChunksToSftp: the writer behind both local and cross-host copies ─────────── */

/**
 * Chunks a fixed sequence and records whether the consumer closed it.
 *
 * `next()` waits a macrotask like a real network read, so writes stay in
 * flight across chunks instead of settling between two microtasks.
 */
function source(chunks: Buffer[], options: { failAt?: number, before?: (index: number) => void } = {}) {
  const state = { returned: 0, pulled: 0 }
  const iterable: AsyncIterable<Buffer> = {
    [Symbol.asyncIterator](): AsyncIterator<Buffer> {
      let index = 0
      return {
        async next() {
          await new Promise(resolve => setImmediate(resolve))
          if (options.failAt !== undefined && index === options.failAt) {
            throw new Error('source failed')
          }
          if (index >= chunks.length) return { done: true, value: undefined }
          options.before?.(index)
          state.pulled += 1
          return { done: false, value: chunks[index++]! }
        },
        async return() {
          state.returned += 1
          return { done: true, value: undefined }
        },
      }
    },
  }
  return { iterable, state }
}

test('chunks from another source go out in windows, not one round trip each', async () => {
  const chunks = Array.from({ length: 8 }, (_, index) => Buffer.alloc(CHUNK, 0x40 + index))
  // Hold the first write open: a network round trip is what makes the next
  // chunk overlap with it. Without that, the local fake settles too fast to
  // observe more than one write in flight.
  let releaseFirst: (() => void) | undefined
  let started = 0
  const fake = fakeSftp(() => {
    started += 1
    if (started === 1) return new Promise<void>(resolve => { releaseFirst = resolve })
    releaseFirst?.()
    return undefined
  })
  const body = Buffer.concat(chunks)
  const fed = source(chunks)
  const bytes = await streamChunksToSftp(fake.sftp as never, '/remote/in.bin', fed.iterable, { maxBytes: 0 })
  assert.equal(bytes, body.length)
  assert.deepEqual(Buffer.concat(fake.writes), body)
  // Several writes in flight, still bounded by the ~1 MiB budget.
  assert.ok(fake.peak() > 1)
  assert.ok(fake.peak() <= 16)
  // A source that ran to its end is not closed again.
  assert.equal(fed.state.returned, 0)
})

test('a chunk stream over the ceiling stops and names the source side', async () => {
  const fake = fakeSftp()
  const fed = source([Buffer.alloc(4, 0x01), Buffer.alloc(20, 0x02)])
  await assert.rejects(
    () => streamChunksToSftp(fake.sftp as never, '/remote/grow.bin', fed.iterable, { maxBytes: 8, overflowLabel: 'source file' }),
    (error: SshFailure) => error.limitExceeded === true && /source file is over the 8 byte transfer ceiling/.test(error.message),
  )
  // Stopping early closes the source, so a generator holding an SFTP handle
  // releases it instead of leaking the channel.
  assert.equal(fed.state.returned, 1)
})

test('an abort between chunks stops the copy and closes the source', async () => {
  const controller = new AbortController()
  const fake = fakeSftp()
  // The abort lands after the first chunk reached the target side, which is
  // the case that leaves a live source open.
  const fed = source([Buffer.alloc(CHUNK, 0x11), Buffer.alloc(CHUNK, 0x22)], {
    before: index => { if (index === 1) controller.abort() },
  })
  await assert.rejects(
    () => streamChunksToSftp(fake.sftp as never, '/remote/in.bin', fed.iterable, { maxBytes: 0, signal: controller.signal }),
    (error: Error) => error.name === 'AbortError',
  )
  assert.equal(fed.state.returned, 1)
})

test('an already-aborted signal opens neither the target nor the source', async () => {
  const controller = new AbortController()
  controller.abort()
  const fake = fakeSftp()
  const fed = source([Buffer.alloc(CHUNK, 0x11)])
  await assert.rejects(
    () => streamChunksToSftp(fake.sftp as never, '/remote/in.bin', fed.iterable, { maxBytes: 0, signal: controller.signal }),
    (error: Error) => error.name === 'AbortError',
  )
  assert.deepEqual(fake.writes, [])
  assert.equal(fed.state.pulled, 0)
  assert.equal(fed.state.returned, 0)
})

test('a failing source closes the target handle and does not leave the window hanging', async () => {
  const fake = fakeSftp()
  const fed = source([Buffer.alloc(CHUNK, 0x33)], { failAt: 1 })
  await assert.rejects(
    () => streamChunksToSftp(fake.sftp as never, '/remote/in.bin', fed.iterable, { maxBytes: 0 }),
    /source failed/,
  )
  assert.deepEqual(fake.writes.map(chunk => chunk.length), [CHUNK])
  assert.equal(fake.closes(), 1)
  assert.equal(fed.state.returned, 1)
})

test('empty chunks are skipped without moving the byte count', async () => {
  const fake = fakeSftp()
  const fed = source([Buffer.alloc(0), Buffer.from('ab'), Buffer.alloc(0), Buffer.from('cd')])
  const bytes = await streamChunksToSftp(fake.sftp as never, '/remote/in.bin', fed.iterable, { maxBytes: 0 })
  assert.equal(bytes, 4)
  assert.deepEqual(Buffer.concat(fake.writes), Buffer.from('abcd'))
})
