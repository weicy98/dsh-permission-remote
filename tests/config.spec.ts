import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../src/config.ts'

test('the host list is a volatile settings field', () => {
  const hosts = Config.dict?.hosts
  assert.equal(hosts?.meta.volatile, true)
  assert.equal(Config.dict?.maxConnections?.meta.volatile, undefined)
})
