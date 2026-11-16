import assert from 'node:assert/strict'
import test from 'node:test'
import { readConfig } from '../src/config.ts'
import { Core } from '../src/index.ts'

test('Core forwards one-time transfer approval to the approval service', async () => {
  const requests: Array<Record<string, unknown>> = []
  const ctx = {
    get(name: string) {
      if (name !== 'approval') return undefined
      return {
        async request(request: Record<string, unknown>) {
          requests.push(request)
          return 'allowed-once'
        },
      }
    },
  }
  const core = new Core(ctx as never, readConfig({ hosts: [], maxConnections: 4 }) as never, { list: () => [] } as never)
  const host = core.toolHost(undefined)
  assert.equal(typeof host.requestTransferApproval, 'function')
  const agent = { id: 'agent-1', session: { id: 'session-1' } }
  const outcome = await host.requestTransferApproval!(
    { agent } as never,
    'ssh_upload',
    'remote file upload',
    { en: 'upload a.bin to host', zh: '上传 a.bin' },
  )
  assert.equal(outcome, 'allowed-once')
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0]?.agent, agent)
  assert.equal(requests[0]?.toolName, 'ssh_upload')
  assert.equal((requests[0]?.displayReason as { en: string }).en, 'upload a.bin to host')
})

test('Core fails closed when no approval answerer exists', async () => {
  const core = new Core({ get: () => undefined } as never, readConfig({ hosts: [], maxConnections: 4 }) as never, { list: () => [] } as never)
  const host = core.toolHost(undefined)
  assert.equal(await host.requestTransferApproval!({ agent: { id: 'a' } } as never, 'ssh_upload', 'x', { en: 'x', zh: 'x' }), 'unavailable')
})
