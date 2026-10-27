import assert from 'node:assert/strict'
import test from 'node:test'
import { buildResolveMode } from '../src/execute.ts'
import type { SandboxMode } from '../src/profile.ts'

function resolver(mode: SandboxMode, requests: string[] = []) {
  return buildResolveMode({
    sandboxPolicy: { resolve: () => ({ mode }) },
    get: name => {
      if (name !== 'approval') return undefined
      return {
        request: async (req: { reason: string }) => {
          requests.push(req.reason)
          return 'allowed-once'
        },
      }
    },
  })
}

const agent = { id: 'a1', session: { id: 's1', header: { cwd: '/tmp/ws' } } }

test('a danger-full-access session ignores a narrower requested mode', async () => {
  const requests: string[] = []
  const resolve = resolver('danger-full-access', requests)
  const mode = await resolve({ agent }, 'read-only', 'inspect logs', 'ssh_exec', 'remote command')
  assert.equal(mode, 'danger-full-access')
  assert.deepEqual(requests, [])
})

test('a danger-full-access session ignores a repeated requested mode', async () => {
  const requests: string[] = []
  const resolve = resolver('danger-full-access', requests)
  const mode = await resolve({ agent }, 'danger-full-access', 'inspect logs', 'ssh_exec', 'remote command')
  assert.equal(mode, 'danger-full-access')
  assert.deepEqual(requests, [])
})

test('a narrower session asks before a wider mode', async () => {
  const requests: string[] = []
  const resolve = resolver('read-only', requests)
  const mode = await resolve({ agent }, 'danger-full-access', 'restart nginx', 'ssh_exec', 'remote command')
  assert.equal(mode, 'danger-full-access')
  assert.equal(requests.length, 1)
  assert.match(requests[0]!, /restart nginx/)
})

test('a call without escalation args keeps the standing mode', async () => {
  const requests: string[] = []
  const resolve = resolver('workspace-write', requests)
  assert.equal(await resolve({ agent }, undefined, undefined, 'ssh_exec', 'remote command'), 'workspace-write')
  assert.deepEqual(requests, [])
})
