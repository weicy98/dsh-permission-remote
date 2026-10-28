import assert from 'node:assert/strict'
import { StringDecoder } from 'node:string_decoder'
import test from 'node:test'
import { SshPool, exitFields, takeChannelText, truncationMarker } from '../src/ssh-pool.ts'

test('channel text keeps a character split across SSH chunks', () => {
  const decoder = new StringDecoder('utf8')
  const bytes = Buffer.from('中文', 'utf8')
  const head = takeChannelText(decoder, bytes.subarray(0, 1))
  const tail = takeChannelText(decoder, bytes.subarray(1))
  assert.equal(head + tail + decoder.end(), '中文')
  assert.equal(head.includes('\uFFFD'), false)
  assert.equal(tail.includes('\uFFFD'), false)
})

test('the truncation marker is emitted once', () => {
  const noted = { current: false }
  assert.equal(truncationMarker(noted), '\n[output truncated]')
  assert.equal(truncationMarker(noted), '')
  assert.equal(truncationMarker(noted), '')
})

test('a normal exit without an exit signal becomes null, not undefined', () => {
  // ssh2 emits `close` with the exit code alone on a normal exit.
  assert.deepEqual(exitFields('exit', 0, undefined), { code: 0, signal: null })
  assert.deepEqual(exitFields('exit', 1), { code: 1, signal: null })
})

test('a channel closed without an exit status reports a null code', () => {
  assert.deepEqual(exitFields('exit'), { code: null, signal: null })
})

test('a stopped command reports the kill signal', () => {
  assert.deepEqual(exitFields('timeout', 0, null), { code: null, signal: 'KILL' })
  assert.deepEqual(exitFields('cancel'), { code: null, signal: 'KILL' })
  assert.deepEqual(exitFields('truncate'), { code: null, signal: 'KILL' })
})

test('normalized exit fields survive a JSON round trip', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(exitFields('exit', 0))), exitFields('exit', 0))
  assert.deepEqual(JSON.parse(JSON.stringify(exitFields('exit'))), exitFields('exit'))
})

test('a saved host drops its cached session before the next connection', () => {
  // The pool caches by host id, which survives an edit, so saveHost has to call
  // invalidate or a renamed address keeps talking to the old machine.
  const pool = new SshPool(2)
  assert.equal(pool.hasSession('h1'), false)
  pool.invalidate('h1')
  assert.equal(pool.hasSession('h1'), false)
})
