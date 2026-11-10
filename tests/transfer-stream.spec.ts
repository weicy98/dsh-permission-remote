import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { finishOrCleanup, streamLocalToSftp, type SshFailure } from '../src/ssh-pool.ts'

const CHUNK = 64 * 1024

function fakeSftp(onWrite?: (bytes: number) => Promise<void> | void, maxWriteLen?: number) {
  const writes: Buffer[] = []
  let inflight = 0
  let peak = 0
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
      peak = Math.max(peak, inflight)
      const copy = Buffer.from(buffer.subarray(offset, offset + length))
      // Report ssh2's end index, not a byte count.
      void Promise.resolve(onWrite?.(copy.length)).then(() => {
        writes.push(copy)
        inflight -= 1
        callback(undefined, offset + length)
      }, (error: Error) => {
        inflight -= 1
        callback(error, offset)
      })
    },
    close(_handle: Buffer, callback: (error: Error | undefined) => void) {
      callback(undefined)
    },
  }
  return { sftp, writes, peak: () => peak }
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
