import assert from 'node:assert/strict'
import test from 'node:test'
import { callHost, readHosts, readWorkspaces, writeRgRegistry, writeTransferLimits, type ClientFace } from '../src/client/api.ts'

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

test('transfer limits are read back, with 0 preserved as "no limit"', async () => {
  const { face } = fakeFace(undefined)
  // The describe() double has no namespaces; assert the documented defaults.
  const loaded = await readHosts(face)
  assert.equal(loaded.transferMaxBytes, 32 * 1024 * 1024)
  assert.equal(loaded.transferTimeoutMs, 120_000)

  const stored = {
    namespaces: [{
      ns: 'permission-remote',
      revision: 7,
      value: { hosts: [], transferMaxBytes: 0, transferTimeoutMs: 0 },
    }],
  }
  const zero = await readHosts({
    connection: face.connection,
    remote: { settings: { describe: async () => ({ namespaces: stored.namespaces }), mutate: async () => undefined } },
  } as unknown as ClientFace)
  assert.equal(zero.transferMaxBytes, 0)
  assert.equal(zero.transferTimeoutMs, 0)

  const cappedRow = await readHosts({
    connection: face.connection,
    remote: {
      settings: {
        describe: async () => ({
          namespaces: [{
            ns: 'permission-remote',
            revision: 8,
            value: { hosts: [], transferMaxBytes: 0, transferTimeoutMs: 2 ** 40 },
          }],
        }),
        mutate: async () => undefined,
      },
    },
  } as unknown as ClientFace)
  // The server getter caps at the timer limit; the settings form must show
  // the value that applies, not the stale stored number.
  assert.equal(cappedRow.transferTimeoutMs, 2 ** 31 - 1)
})

test('saving the transfer limits writes both fields in one mutation', async () => {
  const calls: Array<{ endpoint: string, payload: unknown }> = []
  const face = {
    connection: {
      rpc: { async call(_channel: string, endpoint: string, payload: unknown) { calls.push({ endpoint, payload }); return { ok: true } } },
    },
    remote: {
      settings: {
        async describe() { return { namespaces: [] } },
        async mutate(ns: string, ops: Array<{ op: string, path: string[], value: unknown }>, revision?: number) {
          calls.push({ endpoint: 'mutate', payload: { ns, ops, revision } })
          return undefined
        },
      },
    },
  } as unknown as ClientFace
  await writeTransferLimits(face, 1024, 5000, 3)
  assert.deepEqual(calls, [{
    endpoint: 'mutate',
    payload: {
      ns: 'permission-remote',
      ops: [
        { op: 'set', path: ['transferMaxBytes'], value: 1024 },
        { op: 'set', path: ['transferTimeoutMs'], value: 5000 },
      ],
      revision: 3,
    },
  }])
})

test('a negative transfer limit is clamped to the "no limit" sentinel', async () => {
  const calls: unknown[] = []
  const face = {
    connection: { rpc: { async call() { return { ok: true } } } },
    remote: {
      settings: {
        async describe() { return { namespaces: [] } },
        async mutate(_ns: string, ops: unknown) { calls.push(ops); return undefined },
      },
    },
  } as unknown as ClientFace
  await writeTransferLimits(face, -1, Number.NaN, 1)
  assert.deepEqual(calls, [[
    { op: 'set', path: ['transferMaxBytes'], value: 0 },
    { op: 'set', path: ['transferTimeoutMs'], value: 0 },
  ]])
})

test('a saved transfer timeout is capped at the 32-bit timer limit', async () => {
  const calls: unknown[] = []
  const face = {
    connection: { rpc: { async call() { return { ok: true } } } },
    remote: {
      settings: {
        async describe() { return { namespaces: [] } },
        async mutate(_ns: string, ops: unknown) { calls.push(ops); return undefined },
      },
    },
  } as unknown as ClientFace
  await writeTransferLimits(face, 1024, 2 ** 40, 1)
  assert.deepEqual(calls, [[
    { op: 'set', path: ['transferMaxBytes'], value: 1024 },
    { op: 'set', path: ['transferTimeoutMs'], value: 2 ** 31 - 1 },
  ]])
})
