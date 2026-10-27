import assert from 'node:assert/strict'
import { StringDecoder } from 'node:string_decoder'
import test from 'node:test'
import { takeChannelText, truncationMarker } from '../src/ssh-pool.ts'

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
