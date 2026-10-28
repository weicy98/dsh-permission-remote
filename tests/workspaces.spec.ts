import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import type { HostConfig } from '../src/config.ts'
import { mapRemoteToLocal } from '../src/router.ts'
import {
  autoTaggedTitle,
  createdWorkspaceTitle,
  hostTag,
  remoteWorkspaces,
  retaggedTitle,
  stripKnownPrefix,
  tagRemoteWorkspaces,
  taggedTitle,
  workspaceRoute,
  type WorkspaceLike,
} from '../src/workspaces.ts'

const env = { DSH_HOME: '/tmp/dsh-home' }

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
  readonly id: string
  path: string
  title: string
  readonly createdAt = '2026-01-01T00:00:00.000Z'
  readonly sessionIds: readonly unknown[]

  constructor(id: string, remotePath: string, title: string, sessions = 0) {
    const local = mapRemoteToLocal('host1', remotePath, env)
    assert.ok(local)
    this.id = id
    this.path = local!
    this.title = title
    this.sessionIds = Array.from({ length: sessions }, (_, index) => `s${index}`)
  }

  async setTitle(title: string): Promise<void> {
    this.title = title
  }
}

function workspace(id: string, remotePath: string, title: string, sessions = 0): FakeWorkspace {
  return new FakeWorkspace(id, remotePath, title, sessions)
}

test('a workspace path maps back to its host and remote directory', () => {
  const local = mapRemoteToLocal('host1', '/srv/app', env)!
  assert.deepEqual(workspaceRoute(local, env), { hostId: 'host1', remotePath: '/srv/app' })
  assert.equal(workspaceRoute('/home/me/project', env), null)
})

test('only remote workspaces are listed, with their host and remote path', () => {
  const beside = new FakeWorkspace('b', '/srv/app', 'app')
  beside.path = '/home/me/local'
  const items = remoteWorkspaces([workspace('a', '/srv/app', 'app', 2), beside], env)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.hostId, 'host1')
  assert.equal(items[0]!.remotePath, '/srv/app')
  assert.equal(items[0]!.sessions, 2)
  assert.equal(items[0]!.workspaceId, 'a')
})

test('a host without a name is tagged by its address', () => {
  const plain = host({ name: '' })
  assert.equal(hostTag(plain), '10.0.0.5')
  assert.equal(taggedTitle(plain, 'app'), '10.0.0.5 · app')
})

test('tagging prefixes the server once and leaves a tagged title alone', () => {
  assert.equal(taggedTitle(host(), 'app'), 'dev · app')
  assert.equal(taggedTitle(host(), 'dev · app'), 'dev · app')
  assert.equal(taggedTitle(host(), 'dev · dev · app'), 'dev · dev · app')
  assert.equal(taggedTitle(host(), ''), 'dev')
})

test('tagging rewrites only titles that lack the server, and survives a rerun', async () => {
  const rows = [workspace('a', '/srv/app', 'app'), workspace('b', '/srv/other', 'dev · other')]
  const changed = await tagRemoteWorkspaces([host()], rows, {}, env)
  assert.equal(changed, 1)
  assert.equal(rows[0]!.title, 'dev · app')
  assert.equal(rows[1]!.title, 'dev · other')
  assert.equal(await tagRemoteWorkspaces([host()], rows, {}, env), 0)
})

test('tagging can be narrowed to one host or one workspace', async () => {
  const rows = [workspace('a', '/srv/app', 'app'), workspace('b', '/srv/other', 'other')]
  assert.equal(await tagRemoteWorkspaces([host()], rows, { workspaceId: 'b' }, env), 1)
  assert.equal(rows[0]!.title, 'app')
  assert.equal(rows[1]!.title, 'dev · other')
  const other = host({ id: 'host2' })
  assert.equal(await tagRemoteWorkspaces([other], rows, { hostId: 'host2' }, env), 0)
  assert.equal(await tagRemoteWorkspaces([host()], rows, { hostId: 'host1' }, env), 1)
  assert.equal(rows[0]!.title, 'dev · app')
})

test('a workspace under an unconfigured host is listed but never tagged', async () => {
  const items = remoteWorkspaces([workspace('a', '/srv/app', 'app')], env)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.hostId, 'host1')
  assert.equal(await tagRemoteWorkspaces([host({ id: 'host2' })], [workspace('a', '/srv/app', 'app')], {}, env), 0)
})

test('a renamed host rewrites the old prefix and keeps the name', () => {
  assert.equal(retaggedTitle(host({ name: 'prod' }), 'dev', 'dev · app'), 'prod · app')
  assert.equal(retaggedTitle(host({ name: 'prod' }), 'dev', 'dev · dev · app'), 'prod · dev · app')
  // A title without the old prefix is the operator's own name: leave it alone.
  assert.equal(retaggedTitle(host({ name: 'prod' }), 'dev', 'app'), 'app')
})

test('load-time tagging leaves a renamed workspace alone', async () => {
  const rows = [workspace('a', '/srv/app', 'my app'), workspace('b', '/srv/other', 'other')]
  assert.equal(await tagRemoteWorkspaces([host()], rows, {}, env), 1)
  assert.equal(rows[0]!.title, 'my app')
  assert.equal(rows[1]!.title, 'dev · other')
  assert.equal(autoTaggedTitle(host(), '/srv/app', 'my app'), 'my app')
})

test('manual tagging replaces a known prefix instead of stacking it', async () => {
  const oldAddress = host({ id: 'host2', name: '', host: '10.0.0.5' })
  const rows = [workspace('a', '/srv/app', '10.0.0.5 · app')]
  assert.equal(stripKnownPrefix('10.0.0.5 · app', [host({ name: '' })]), 'app')
  assert.equal(stripKnownPrefix('custom · app', [host({ name: '' })]), 'custom · app')
  assert.equal(await tagRemoteWorkspaces([host(), oldAddress], rows, { workspaceId: 'a' }, env), 1)
  assert.equal(rows[0]!.title, 'dev · app')
})

test('a new workspace is tagged only when the setting allows it', () => {
  assert.equal(createdWorkspaceTitle(host(), 'app', true), 'dev · app')
  assert.equal(createdWorkspaceTitle(host(), 'app', false), 'app')
  // A title the operator typed is not prefixed twice.
  assert.equal(createdWorkspaceTitle(host(), 'dev · app', true), 'dev · app')
})

test('tagging one host prefixes every workspace once and replaces a stale prefix', async () => {
  const oldAddress = host({ id: 'gone', name: '', host: '10.0.0.9' })
  const rows = [
    workspace('a', '/srv/app', '10.0.0.9 · app'),
    workspace('b', '/srv/notes', 'my notes'),
    workspace('c', '/srv/lib', 'lib'),
  ]
  const known = [host(), oldAddress]
  // The settings button is explicit: all three end up naming this server.
  assert.equal(await tagRemoteWorkspaces([host()], rows, { hostId: 'host1', knownHosts: known }, env), 3)
  assert.equal(rows[0]!.title, 'dev · app')
  assert.equal(rows[1]!.title, 'dev · my notes')
  assert.equal(rows[2]!.title, 'dev · lib')
  assert.equal(await tagRemoteWorkspaces([host()], rows, { hostId: 'host1', knownHosts: known }, env), 0)
})

test('load-time tagging does not replace another server prefix', async () => {
  const rows = [workspace('a', '/srv/app', '10.0.0.9 · app')]
  assert.equal(await tagRemoteWorkspaces([host()], rows, {}, env), 0)
  assert.equal(rows[0]!.title, '10.0.0.9 · app')
})

test('an unnamed host that changes address retags its workspaces', async () => {
  const rows = [workspace('a', '/srv/app', '10.0.0.5 · app')]
  const moved = host({ name: '', host: '10.0.0.9' })
  assert.equal(await tagRemoteWorkspaces([moved], rows, { previousTag: '10.0.0.5' }, env), 1)
  assert.equal(rows[0]!.title, '10.0.0.9 · app')
})

test('the registry path may be the realpath of the remote root', () => {
  const local = path.join('/tmp/dsh-home/remote/host1', Buffer.from('/srv/app').toString('base64url'))
  assert.deepEqual(workspaceRoute(local, env), { hostId: 'host1', remotePath: '/srv/app' })
})
