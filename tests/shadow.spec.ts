import assert from 'node:assert/strict'
import test from 'node:test'
import { dispatchShadow, planShadows } from '../src/shadow.ts'

test('shadow plans close over the official execute captured before register', async () => {
  const calls: string[] = []
  const official = {
    execute: async () => {
      calls.push('official')
      return 'local'
    },
  }
  const plans = planShadows(name => name === 'read' || name === 'bash' ? official : undefined)
  assert.deepEqual(plans.map(plan => plan.name), ['bash', 'read'])
  const bash = plans[0]!
  const result = await dispatchShadow(bash.official, false, async () => {
    calls.push('remote')
    return 'remote'
  }, {}, {})
  assert.equal(result, 'local')
  assert.deepEqual(calls, ['official'])
})

test('a remote cwd does not call the captured official execute', async () => {
  let officialCalls = 0
  const result = await dispatchShadow(async () => {
    officialCalls += 1
    return 'local'
  }, true, async () => 'remote', {}, {})
  assert.equal(result, 'remote')
  assert.equal(officialCalls, 0)
})
