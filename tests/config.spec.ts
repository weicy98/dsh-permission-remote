import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Config, connectionKeyChanged, normalizeLoginEnv, readConfig, type HostConfig } from '../src/config.ts'
import { migrationStatePath, readMigrationState, writeMigrationState } from '../src/migration-state.ts'

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

test('a host saved before loginEnv existed stays off', () => {
  const config = readConfig({ hosts: [host('h1')], maxConnections: 2 })
  assert.equal(config.hosts[0]?.loginEnv, false)
})

test('readConfig keeps an explicit loginEnv', () => {
  const config = readConfig({ hosts: [{ ...host('h1'), loginEnv: true }, host('h2')] })
  assert.deepEqual(config.hosts.map(item => item.loginEnv), [true, false])
})

test('normalizeLoginEnv accepts only an explicit true', () => {
  assert.equal(normalizeLoginEnv(true), true)
  assert.equal(normalizeLoginEnv(false), false)
  assert.equal(normalizeLoginEnv(undefined), false)
  assert.equal(normalizeLoginEnv('true'), false)
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
  assert.equal(connectionKeyChanged(base, { ...base, loginEnv: true }), false)
  assert.equal(connectionKeyChanged(base, { ...base, fingerprint: 'SHA256:abc' }), false)
  assert.equal(connectionKeyChanged(base, base), false)
})

test('migration bookkeeping lives in its own file, not in the settings schema', async () => {
  const box = await mkdtemp(join(tmpdir(), 'dsh-mig-state-'))
  const env = { DSH_HOME: box } as NodeJS.ProcessEnv
  try {
    // Nothing on disk yet: empty bookkeeping, no error.
    const first = await readMigrationState(env)
    assert.deepEqual(first.state, { supersededRemoteRoots: [], pendingSessionGrouping: [] })
    assert.equal(first.problem, undefined)

    await writeMigrationState({
      supersededRemoteRoots: ['/old/root'],
      pendingSessionGrouping: [{ path: '/new/host1/abc', id: 'session-1' }],
    }, env)
    const back = await readMigrationState(env)
    assert.deepEqual(back.state.supersededRemoteRoots, ['/old/root'])
    assert.deepEqual(back.state.pendingSessionGrouping, [{ path: '/new/host1/abc', id: 'session-1' }])

    // Private permissions: the file names local paths.
    const mode = (await stat(migrationStatePath(env))).mode & 0o777
    assert.equal(mode & 0o077, 0, 'no group/other bits')

    // A corrupt document degrades to empty bookkeeping instead of throwing.
    await writeFile(migrationStatePath(env), '{not json', 'utf8')
    const corrupt = await readMigrationState(env)
    assert.deepEqual(corrupt.state, { supersededRemoteRoots: [], pendingSessionGrouping: [] })
    assert.ok(corrupt.problem !== undefined)

    // Entries are validated: relative roots and half-formed rows are dropped.
    await writeFile(migrationStatePath(env), JSON.stringify({
      supersededRemoteRoots: ['/', 'relative/path', 'C:\\old', ''],
      pendingSessionGrouping: [{ path: '/a', id: 's1' }, { path: '', id: 's2' }, { path: '/a', id: 's1' }],
    }), 'utf8')
    const sanitized = await readMigrationState(env)
    assert.deepEqual(sanitized.state.supersededRemoteRoots, ['/', 'C:\\old'])
    assert.deepEqual(sanitized.state.pendingSessionGrouping, [{ path: '/a', id: 's1' }])
  } finally {
    await rm(box, { recursive: true, force: true })
  }
})
