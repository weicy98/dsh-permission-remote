import assert from 'node:assert/strict'
import test from 'node:test'
import { readConfig, type HostConfig } from '../src/config.ts'
import { Core } from '../src/index.ts'
import { mapRemoteToLocal } from '../src/router.ts'
import type { WorkspaceLike } from '../src/workspaces.ts'

const env = { DSH_HOME: '/tmp/dsh-host-lifecycle' }

function host(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id: 'host1',
    name: 'dev',
    host: '10.0.0.5',
    port: 22,
    username: 'me',
    auth: 'key',
    privateKeyPath: '',
    fingerprint: 'SHA256:abc',
    opsPolicy: 'ask',
    ...overrides,
  }
}

class FakeWorkspace implements WorkspaceLike {
  readonly createdAt = '2026-01-01T00:00:00.000Z'
  title: string

  constructor(readonly id: string, readonly path: string, title: string, readonly sessionIds: readonly unknown[] = []) {
    this.title = title
  }

  async setTitle(title: string): Promise<void> {
    this.title = title
  }
}

class FakeRegistry {
  rows: FakeWorkspace[] = []
  deleteResult = true

  create(dir: string, title?: string): Promise<WorkspaceLike> {
    const existing = this.rows.find(row => row.path === dir)
    if (existing !== undefined) return Promise.resolve(existing)
    const created = new FakeWorkspace(`w${this.rows.length + 1}`, dir, title ?? 'workspace')
    this.rows.push(created)
    return Promise.resolve(created)
  }

  list(): WorkspaceLike[] {
    return this.rows
  }

  delete(id: unknown): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter(row => row.id !== id)
    return Promise.resolve(this.deleteResult && this.rows.length !== before)
  }
}

function remoteWorkspace(registry: FakeRegistry, hostId: string, remotePath: string, title: string): FakeWorkspace {
  // Core reads process.env, so the fake workspace must live under the real
  // placeholder root rather than a test-only DSH_HOME.
  const local = mapRemoteToLocal(hostId, remotePath)
  assert.ok(local)
  const row = new FakeWorkspace(`w-${remotePath}`, local!, title)
  registry.rows.push(row)
  return row
}

function fakeContext(updates: Array<Record<string, unknown>> = []): object {
  return {
    logger: { info() {}, warn() {} },
    settings: {
      configure: () => () => undefined,
      describe: () => [{ ns: 'permission-remote' }],
      update: async (_ns: string, patch: Record<string, unknown>) => { updates.push(patch) },
    },
    credentials: {
      readRecord: async () => undefined,
      modifyRecord: async () => undefined,
    },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    tools: { get: () => undefined, register: () => () => undefined },
    get: () => undefined,
    on: () => () => undefined,
    effect: () => undefined,
  }
}

function build(registry: FakeRegistry, updates: Array<Record<string, unknown>> = [], hosts: HostConfig[] = [host()], extra: Record<string, unknown> = {}): Core {
  const config = readConfig({ hosts, deletedHosts: [], ...extra })
  return new Core(fakeContext(updates) as never, config, registry)
}

/** Record every pool invalidation without opening a connection. */
function watchInvalidate(core: Core): string[] {
  const invalidated: string[] = []
  core.pool.invalidate = (hostId: string) => { invalidated.push(hostId) }
  return invalidated
}

test('changing the address drops the pooled session, renaming keeps it', async () => {
  const registry = new FakeRegistry()
  const core = build(registry)
  const invalidated = watchInvalidate(core)

  await core.saveHost({ ...host(), name: 'renamed' })
  assert.deepEqual(invalidated, [])

  await core.saveHost({ ...host(), name: 'renamed', host: '10.0.0.9' })
  assert.deepEqual(invalidated, ['host1'])
})

test('saving a new secret drops the session authenticated with the old one', async () => {
  const registry = new FakeRegistry()
  const core = build(registry)
  const invalidated = watchInvalidate(core)
  await core.saveSecret('host1', { password: 'next' })
  assert.deepEqual(invalidated, ['host1'])
})

test('deleting a host keeps its workspaces and remembers the row', async () => {
  const registry = new FakeRegistry()
  const row = remoteWorkspace(registry, 'host1', '/srv/app', 'app')
  const updates: Array<Record<string, unknown>> = []
  const core = build(registry, updates)

  await core.deleteHost('host1')

  assert.deepEqual(core.listHosts(), [])
  assert.equal(registry.rows.length, 1)
  assert.equal(registry.rows[0]!.title, 'app')
  const listed = core.listWorkspaces()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.hostId, 'host1')
  assert.equal(listed[0]!.workspaceId, row.id)
  assert.deepEqual(core.listDeletedHosts().map(item => item.id), ['host1'])
  const persisted = updates.at(-1)
  assert.deepEqual(persisted?.hosts, [])
  assert.equal((persisted?.deletedHosts as unknown[]).length, 1)
})

test('a deleted host can be restored and cannot be restored twice', async () => {
  const registry = new FakeRegistry()
  remoteWorkspace(registry, 'host1', '/srv/app', 'app')
  const core = build(registry)
  await core.deleteHost('host1')
  assert.equal(core.listHosts().length, 0)

  await core.restoreHost('host1')
  assert.deepEqual(core.listHosts().map(item => item.id), ['host1'])
  assert.deepEqual(core.listDeletedHosts(), [])
  await assert.rejects(() => core.restoreHost('host1'), /already configured/)
})

test('a deleted host that still has workspaces stays restorable past the spare cap', async () => {
  const registry = new FakeRegistry()
  remoteWorkspace(registry, 'kept', '/srv/app', 'app')
  const hosts = [host({ id: 'kept', host: '10.0.0.1' })]
  for (let index = 0; index < 21; index += 1) hosts.push(host({ id: `spare${index}`, host: `10.1.0.${index}` }))
  const core = build(registry, [], hosts)
  await core.deleteHost('kept')
  for (let index = 0; index < 21; index += 1) await core.deleteHost(`spare${index}`)
  const deleted = core.listDeletedHosts().map(item => item.id)
  assert.equal(deleted.includes('kept'), true)
  assert.equal(deleted.includes('spare0'), false)
  assert.equal(deleted.includes('spare20'), true)
  assert.equal(deleted.filter(id => id.startsWith('spare')).length, 20)
})

test('restoring an unknown host reports that it cannot be recovered', async () => {
  const core = build(new FakeRegistry())
  await assert.rejects(() => core.restoreHost('host9'), /cannot be restored/)
})

test('unregistering refuses a workspace that belongs to another host', async () => {
  const registry = new FakeRegistry()
  const row = remoteWorkspace(registry, 'host1', '/srv/app', 'app')
  const core = build(registry)
  await assert.rejects(() => core.removeWorkspace('host2', row.id), /does not belong/)
  assert.equal(registry.rows.length, 1)
  assert.equal(await core.removeWorkspace('host1', 'missing'), false)
  assert.equal(await core.removeWorkspace('host1', row.id), true)
  assert.equal(registry.rows.length, 0)
})

test('an unregister the registry ignores is reported as not removed', async () => {
  const registry = new FakeRegistry()
  const row = remoteWorkspace(registry, 'host1', '/srv/app', 'app')
  registry.deleteResult = false
  const core = build(registry)
  assert.equal(await core.removeWorkspace('host1', row.id), false)
})

test('with tagging off, renaming a host leaves its workspace titles alone', async () => {
  const registry = new FakeRegistry()
  remoteWorkspace(registry, 'host1', '/srv/app', 'dev · app')
  const core = build(registry, [], [host()], { tagWorkspaceTitles: false })
  assert.equal(core.taggingEnabled, false)

  await core.saveHost(host({ name: 'prod' }))
  assert.equal(registry.rows[0]!.title, 'dev · app')
})

test('with tagging on, renaming a host rewrites a title that carries the old tag', async () => {
  const registry = new FakeRegistry()
  remoteWorkspace(registry, 'host1', '/srv/app', 'dev · app')
  const core = build(registry)

  await core.saveHost(host({ name: 'prod' }))
  assert.equal(registry.rows[0]!.title, 'prod · app')
})

test('manual tagging strips a prefix that belongs to a deleted host', async () => {
  const registry = new FakeRegistry()
  const row = remoteWorkspace(registry, 'host1', '/srv/app', '10.0.0.5 · app')
  const core = build(registry, [], [host({ name: '', host: '10.0.0.5' })])
  // Same id, new address: the old address survives as the tombstone's tag.
  await core.deleteHost('host1')
  await core.saveHost(host({ id: 'host1', name: '', host: '10.0.0.9' }))
  await core.tagWorkspaces('host1', row.id)
  assert.equal(registry.rows[0]!.title, '10.0.0.9 · app')
})
