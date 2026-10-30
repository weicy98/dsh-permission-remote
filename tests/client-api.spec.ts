import assert from 'node:assert/strict'
import test from 'node:test'
import { callHost, readHosts, readWorkspaces, writeRgRegistry, type ClientFace } from '../src/client/api.ts'

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

test('a host saved before loginEnv existed is shown as off', async () => {
  const face = {
    connection: { rpc: { async call() { return { ok: true, value: {} } } } },
    remote: {
      settings: {
        async describe() {
          return {
            value: {
              namespaces: [{
                ns: 'permission-remote',
                revision: 4,
                value: {
                  hosts: [{
                    id: 'h1',
                    name: '',
                    host: '10.0.0.1',
                    port: 22,
                    username: 'me',
                    auth: 'key',
                    privateKeyPath: '',
                    fingerprint: '',
                    opsPolicy: 'ask',
                  }, {
                    id: 'h2',
                    name: '',
                    host: '10.0.0.2',
                    port: 22,
                    username: 'me',
                    auth: 'key',
                    privateKeyPath: '',
                    fingerprint: '',
                    opsPolicy: 'ask',
                    loginEnv: true,
                  }],
                },
              }],
            },
          }
        },
        async mutate() { return undefined },
      },
    },
  } as unknown as ClientFace
  const loaded = await readHosts(face)
  assert.deepEqual(loaded.hosts.map(item => item.loginEnv), [false, true])
  assert.equal(loaded.revision, 4)
})

test('saving the download source sets one volatile path with the loaded revision', async () => {
  const mutations: Array<{ ns: string, ops: unknown, revision: unknown }> = []
  const face = {
    connection: { rpc: { async call() { return { ok: true, value: {} } } } },
    remote: {
      settings: {
        async describe() { return { namespaces: [] } },
        async mutate(ns: string, ops: unknown, revision: unknown) {
          mutations.push({ ns, ops, revision })
        },
      },
    },
  } as unknown as ClientFace
  await writeRgRegistry(face, 'https://mirror.example.test', 7)
  // The host only ever reads this field; the settings write is the one path.
  assert.deepEqual(mutations, [{
    ns: 'permission-remote',
    ops: [{ op: 'set', path: ['rgRegistry'], value: 'https://mirror.example.test' }],
    revision: 7,
  }])
})
