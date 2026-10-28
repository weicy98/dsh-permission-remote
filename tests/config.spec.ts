import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, connectionKeyChanged, readConfig, type HostConfig } from '../src/config.ts'

const host = (id: string): HostConfig => ({
  id,
  name: '',
  host: '127.0.0.1',
  port: 22,
  username: 'u',
  auth: 'key',
  privateKeyPath: '',
  fingerprint: '',
  opsPolicy: 'ask',
})

test('the host list is a volatile settings field', () => {
  const hosts = Config.dict?.hosts
  assert.equal(hosts?.meta.volatile, true)
  assert.equal(Config.dict?.maxConnections?.meta.volatile, undefined)
})

test('readConfig accepts the resolved config and keeps its hosts reference', () => {
  const resolved = Config({ hosts: [host('h1')], maxConnections: 4 }) as unknown as { hosts: { get(): HostConfig[] } }
  const config = readConfig(resolved)
  assert.equal(config.hosts[0]?.id, 'h1')
  assert.equal(config.maxConnections, 4)
  config.hosts = [host('h1'), host('h2')]
  assert.deepEqual(resolved.hosts.get().map(item => item.id), ['h1', 'h2'])
  assert.deepEqual(config.hosts.map(item => item.id), ['h1', 'h2'])
})

test('readConfig accepts a plain settings object', () => {
  const config = readConfig({ hosts: [host('h1')], maxConnections: 2 })
  assert.equal(config.maxConnections, 2)
  assert.equal(config.hosts[0]?.id, 'h1')
  config.hosts = []
  assert.deepEqual(config.hosts, [])
})

test('a host saved before opsPolicy existed defaults to ask', () => {
  const { opsPolicy: _opsPolicy, ...legacy } = host('h1')
  const config = readConfig({ hosts: [legacy], maxConnections: 2 })
  assert.equal(config.hosts[0]?.opsPolicy, 'ask')
})

test('readConfig keeps an explicit opsPolicy', () => {
  const config = readConfig({ hosts: [host('h1'), { ...host('h2'), opsPolicy: 'deny' }] })
  assert.deepEqual(config.hosts.map(item => item.opsPolicy), ['ask', 'deny'])
})

test('changing a handshake field invalidates the cached session', () => {
  const base = host('h1')
  for (const patch of [
    { host: '10.0.0.99' },
    { port: 2222 },
    { username: 'other' },
    { auth: 'password' as const },
    { privateKeyPath: '/home/u/.ssh/id_ed25519' },
  ]) {
    assert.equal(connectionKeyChanged(base, { ...base, ...patch }), true, JSON.stringify(patch))
  }
})

test('renaming or retitling a host keeps the cached session', () => {
  const base = host('h1')
  assert.equal(connectionKeyChanged(base, { ...base, name: 'prod' }), false)
  assert.equal(connectionKeyChanged(base, { ...base, opsPolicy: 'trust' }), false)
  assert.equal(connectionKeyChanged(base, { ...base, fingerprint: 'SHA256:abc' }), false)
  assert.equal(connectionKeyChanged(base, base), false)
})
