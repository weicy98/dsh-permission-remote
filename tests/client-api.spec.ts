import assert from 'node:assert/strict'
import test from 'node:test'
import { callHost, readWorkspaces, type ClientFace } from '../src/client/api.ts'

interface Recorded {
  readonly endpoint: string
  readonly payload: unknown
}

function fakeFace(value: unknown = {}): { face: ClientFace, calls: Recorded[] } {
  const calls: Recorded[] = []
  const face = {
    connection: {
      rpc: {
        async call(_channel: string, endpoint: string, payload: unknown) {
          calls.push({ endpoint, payload })
          return { ok: true, value }
        },
      },
    },
    remote: {
      settings: {
        async describe() {
          return { namespaces: [] }
        },
        async mutate() {
          return undefined
        },
      },
    },
  } as unknown as ClientFace
  return { face, calls }
}

test('a method without parameters sends no input field', async () => {
  // The gateway rejects any argument field its descriptor does not declare, so
  // listWorkspaces() must travel as an empty args object.
  const { face, calls } = fakeFace({ items: [] })
  await readWorkspaces(face)
  assert.deepEqual(calls, [{ endpoint: 'sshPermission/listWorkspaces', payload: { args: {} } }])
})

test('a method with one parameter sends exactly that input field', async () => {
  const { face, calls } = fakeFace({ ok: true })
  await callHost(face, 'probe', { hostId: 'host1' })
  assert.deepEqual(calls, [{
    endpoint: 'sshPermission/probe',
    payload: { args: { input: { hostId: 'host1' } } },
  }])
})

test('a failed call surfaces the gateway message', async () => {
  const face = {
    connection: {
      rpc: {
        async call() {
          return { ok: false, error: { message: 'gateway/arguments-invalid' } }
        },
      },
    },
    remote: { settings: { async describe() { return { namespaces: [] } }, async mutate() { return undefined } } },
  } as unknown as ClientFace
  await assert.rejects(() => callHost(face, 'listWorkspaces'), /gateway\/arguments-invalid/)
})
