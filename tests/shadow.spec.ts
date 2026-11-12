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
  const plans = planShadows(name => name === 'glob' || name === 'bash' ? official : undefined)
  assert.deepEqual(plans.map(plan => plan.name), ['bash', 'glob'])
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

test('terminal_open stays routed so a remote cwd can be rewritten before the official tool', () => {
  // The official tool resolves an absolute cwd on this computer. The plan has
  // to exist so that rewrite runs per call, once the session cwd is known.
  const plans = planShadows(name => name === 'terminal_open' || name === 'bash' ? { execute: async () => 'local' } : undefined)
  assert.deepEqual(plans.map(plan => plan.name), ['bash', 'terminal_open'])
  const open = plans.find(plan => plan.name === 'terminal_open')
  assert.ok(open?.official)
})

test('present is routed so a remote session can deliver a file', () => {
  // The official tool stats every path through the local filesystem, which
  // never holds a remote file; without a shadow, `present` fails on every
  // remote workspace with "file not found".
  const plans = planShadows(name => name === 'present' || name === 'bash' ? { execute: async () => 'local' } : undefined)
  const present = plans.find(plan => plan.name === 'present')
  assert.ok(present, 'present must appear in the routed tool list')
  assert.ok(present!.official, 'the official execute is captured for delegation')
})

test('official read, write, edit and apply_patch tools stay outside the shadow plan', () => {
  const plans = planShadows(name => ({ execute: async () => name }))
  const names = plans.map(plan => String(plan.name))
  // Adding a name here means the official function has no cwd seam. Say which
  // seam is missing in src/shadow.ts. read_image is served by ctx.fs.readBytes.
  assert.deepEqual(names, ['bash', 'glob', 'grep', 'working_directory', 'terminal_open', 'present', 'str_replace_editor'])
  assert.equal(names.some(name => name === 'read' || name === 'write' || name === 'edit' || name === 'apply_patch' || name === 'read_image'), false)
})
