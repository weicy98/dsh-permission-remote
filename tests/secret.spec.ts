import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { HostConfig } from '../src/config.ts'
import { apply } from '../src/index.ts'

const hostId = 'h33903407c792164f'

function host(): HostConfig {
  return {
    id: hostId,
    name: 'box',
    host: '127.0.0.1',
    port: 22,
    username: 'u',
    auth: 'password',
    privateKeyPath: '',
    fingerprint: '',
    opsPolicy: 'ask',
  }
}

interface Grant {
  kind: 'grant'
  payload: Record<string, unknown>
}

/** Same admission `credentials-local` uses before it writes a grant payload. */
function assertJsonRepresentable(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    assert.equal(Number.isFinite(value), true)
    return
  }
  if (typeof value !== 'object') assert.fail(`JSON cannot represent ${typeof value}`)
  if (seen.has(value)) assert.fail('cyclic payload')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && !Array.isArray(value)) assert.fail('payload is not a plain object or array')
  seen.add(value)
  for (const nested of Object.values(value)) assertJsonRepresentable(nested, seen)
  seen.delete(value)
}

function plugin(): { api: { saveHost(input: HostConfig): Promise<unknown>, saveSecret(input: { hostId: string, password?: string, passphrase?: string }): Promise<unknown> }, record(): Grant | undefined, keys: string[] } {
  const records = new Map<string, Grant>()
  const keys: string[] = []
  const ctx = new Context()
  ctx.provide('settings', {
    configure: () => () => undefined,
    describe: () => [],
    update: async () => undefined,
  })
  ctx.provide('credentials', {
    readRecord: async (key: string) => records.get(String(key)),
    modifyRecord: async (key: string, mutate: (current: Grant | undefined) => Promise<Grant | undefined>) => {
      const id = String(key)
      keys.push(id)
      const next = await mutate(records.get(id))
      if (next === undefined) return records.get(id)
      assert.equal(next.kind, 'grant')
      assertJsonRepresentable(next.payload)
      records.set(id, next)
      return next
    },
  })
  apply(ctx, { hosts: [], maxConnections: 4 })
  const api = ctx.get('sshPermission') as { saveHost(input: HostConfig): Promise<unknown>, saveSecret(input: { hostId: string, password?: string, passphrase?: string }): Promise<unknown> }
  return { api, record: () => records.get(`dsh-permission-remote/${hostId}`), keys }
}

test('saving a password leaves the passphrase field off the grant', async () => {
  const { api, record, keys } = plugin()
  await api.saveHost(host())
  await api.saveSecret({ hostId, password: 's3cret' })
  assert.deepEqual(keys, [`dsh-permission-remote/${hostId}`])
  assert.deepEqual(record()?.payload, { password: 's3cret' })
})

test('saving a key passphrase leaves the password field off the grant', async () => {
  const { api, record } = plugin()
  await api.saveHost({ ...host(), auth: 'key' })
  await api.saveSecret({ hostId, passphrase: 'key-pass' })
  assert.deepEqual(record()?.payload, { passphrase: 'key-pass' })
})

test('a later secret update keeps the field it does not mention', async () => {
  const { api, record } = plugin()
  await api.saveHost(host())
  await api.saveSecret({ hostId, password: 's3cret' })
  await api.saveSecret({ hostId, passphrase: 'key-pass' })
  assert.deepEqual(record()?.payload, { password: 's3cret', passphrase: 'key-pass' })
  await api.saveSecret({ hostId, password: 'next' })
  assert.deepEqual(record()?.payload, { password: 'next', passphrase: 'key-pass' })
})

test('an empty password is stored and still omits the other field', async () => {
  const { api, record } = plugin()
  await api.saveHost(host())
  await api.saveSecret({ hostId, password: '' })
  assert.deepEqual(record()?.payload, { password: '' })
})
