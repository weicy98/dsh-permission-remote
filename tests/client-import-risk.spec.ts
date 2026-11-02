import assert from 'node:assert/strict'
import test from 'node:test'
import { importNeedsConfirm, type ImportRiskHost } from '../src/client/import-risk.ts'

const current: ImportRiskHost[] = [
  { id: 'host1', host: '10.0.0.5', opsPolicy: 'ask' },
  { id: 'locked', host: '10.0.0.8', opsPolicy: 'deny' },
]

test('an import needs a confirm when it moves an address or relaxes ops policy', () => {
  assert.equal(importNeedsConfirm({ hosts: [{ id: 'host1', name: 'renamed' }] }, current), false)
  assert.equal(importNeedsConfirm({ hosts: [{ id: 'host1', host: '10.0.0.5', opsPolicy: 'deny' }] }, current), false)
  assert.equal(importNeedsConfirm({ hosts: [{ id: 'fresh', host: '10.9.9.9', opsPolicy: 'trust' }] }, current), false)
  assert.equal(importNeedsConfirm({ hosts: [{ id: 'host1', host: '10.1.1.1' }] }, current), true)
  assert.equal(importNeedsConfirm({ hosts: [{ id: 'host1', host: ' 10.0.0.5 ' }] }, current), false)
  assert.equal(importNeedsConfirm({ hosts: [{ id: 'host1', opsPolicy: 'trust' }] }, current), true)
  assert.equal(importNeedsConfirm({ hosts: [{ id: 'locked', opsPolicy: 'ask' }] }, current), true)
  assert.equal(importNeedsConfirm({ hosts: [{ id: 'locked', opsPolicy: 'trust' }] }, current), true)
  assert.equal(importNeedsConfirm([{ id: 'host1', host: '10.2.2.2', username: 'me' }], current), true)
})
