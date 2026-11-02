import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readConfig, type HostConfig } from '../src/config.ts'
import { Core } from '../src/index.ts'
import { clearSupersededRoots, mapRemoteToLocal, remoteRoot, routeByCwd, setRemoteRootOverride } from '../src/router.ts'
import { workspaceRoute, type WorkspaceLike } from '../src/workspaces.ts'

/**
 * `Core.changeRemoteRoot` and `Core.importHostConfig` end to end.
 *
 * The placeholders are real directories under a temp root, and the workspace
 * registry is a list in memory. Each test sets the root through the config (the
 * same path a load takes) and clears the module-level routing state on the way
 * out.
 */

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
    loginEnv: false,
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

  async delete(id: unknown): Promise<boolean> {
    const before = this.rows.length
    this.rows = this.rows.filter(row => row.id !== id)
    return this.rows.length !== before
  }
}

interface Harness {
  box: string
  oldRoot: string
  newRoot: string
  registry: FakeRegistry
  core: Core
  updates: Array<Record<string, unknown>>
}

async function harness(options: { sessions?: number, failPersist?: boolean } = {}): Promise<Harness> {
  const box = await mkdtemp(join(tmpdir(), 'dsh-root-core-'))
  const oldRoot = join(box, 'old-root')
  const newRoot = join(box, 'new-root')
  await mkdir(oldRoot, { recursive: true })
  const updates: Array<Record<string, unknown>> = []
  const fail = options.failPersist === true
  const ctx = {
    logger: { info() {}, warn() {} },
    settings: {
      configure: () => () => undefined,
      describe: () => [{ ns: 'permission-remote' }],
      update: async (_ns: string, patch: Record<string, unknown>) => {
        if (fail) throw new Error('settings write refused')
        updates.push(patch)
      },
    },
    credentials: { readRecord: async () => undefined, modifyRecord: async () => undefined },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    tools: { get: () => undefined, register: () => () => undefined },
    get: () => undefined,
    on: () => () => undefined,
    effect: () => undefined,
  }
  const registry = new FakeRegistry()
  const config = readConfig({ hosts: [host()], deletedHosts: [], remoteRoot: oldRoot })
  const core = new Core(ctx as never, config, registry)
  core.applyRemoteRootOverride()
  return { box, oldRoot, newRoot, registry, core, updates }
}

async function dispose(box: Harness): Promise<void> {
  clearSupersededRoots()
  setRemoteRootOverride(null)
  await rm(box.box, { recursive: true, force: true })
}

/** Register a workspace the way the plugin does, then add a live session to it. */
async function seedWorkspace(box: Harness, remotePath: string, sessions = 0): Promise<FakeWorkspace> {
  const local = mapRemoteToLocal('host1', remotePath)
  assert.ok(local)
  await mkdir(local, { recursive: true })
  await writeFile(join(local, 'left-behind.txt'), 'from the remote command')
  const row = new FakeWorkspace('w-seed', local, 'dev · app', Array.from({ length: sessions }, (_, index) => `s${index}`))
  box.registry.rows.push(row)
  return row
}

test('a live session blocks the move until it is accepted, and then keeps routing to the server', async () => {
  const box = await harness()
  try {
    const seeded = await seedWorkspace(box, '/srv/app', 1)
    const blocked = await box.core.changeRemoteRoot(box.newRoot, { force: false })
    assert.equal(blocked.status, 'has-sessions')
    assert.equal(blocked.sessions, 1)
    // Nothing was written and nothing was copied.
    assert.equal(box.updates.length, 0)
    await assert.rejects(() => readFile(join(box.newRoot, 'host1', 'x'), 'utf8'), /ENOENT/)
    assert.equal(remoteRoot(), box.oldRoot)

    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.migration?.copied, 1)
    assert.equal(moved.workspacesRemapped, 1)

    // The setting was written once, with only the new root.
    assert.deepEqual(box.updates.at(-1), { remoteRoot: box.newRoot })
    assert.equal(remoteRoot(), box.newRoot)

    // The row now points at the new placeholder and keeps its title.
    const recreated = box.registry.rows.find(row => row.path !== seeded.path)
    assert.ok(recreated)
    assert.equal(recreated.title, 'dev · app')
    assert.equal(workspaceRoute(recreated.path)?.remotePath, '/srv/app')

    // The old placeholder still resolves to the same server, so the session that
    // was sitting on it does not silently become a local directory.
    const stale = routeByCwd(seeded.path)
    assert.equal(stale.kind, 'remote')
    assert.equal(stale.kind === 'remote' ? stale.hostId : '', 'host1')
    assert.equal(stale.kind === 'remote' ? stale.remoteCwd : '', '/srv/app')
  } finally {
    await dispose(box)
  }
})

test('conflicting files are reported before anything is copied, and the choice decides the outcome', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    // Put a different file where the merge would copy one.
    await mkdir(join(box.newRoot, 'host1'), { recursive: true })
    const relative = join('host1', 'w0')
    const targetFile = join(box.newRoot, relative)
    await writeFile(targetFile, 'target version')
    const sourceFile = join(box.oldRoot, relative)
    await writeFile(sourceFile, 'old version')

    const planned = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(planned.status, 'needs-strategy')
    assert.deepEqual(planned.conflicts, [relative.split('\\').join('/')])
    assert.equal(box.updates.length, 0)

    // "Keep target" leaves the differing file alone and still switches the root.
    const kept = await box.core.changeRemoteRoot(box.newRoot, { force: true, strategy: 'auto' })
    assert.equal(kept.status, 'changed')
    assert.equal(await readFile(targetFile, 'utf8'), 'target version')
  } finally {
    await dispose(box)
  }
})

test('overwrite replaces a conflicting file with the old root copy', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    await mkdir(join(box.newRoot, 'host1'), { recursive: true })
    const relative = join('host1', 'w0')
    await writeFile(join(box.newRoot, relative), 'target version')
    await writeFile(join(box.oldRoot, relative), 'old version')
    const done = await box.core.changeRemoteRoot(box.newRoot, { force: true, strategy: 'overwrite' })
    assert.equal(done.status, 'changed')
    assert.equal(done.migration?.overwritten, 1)
    assert.equal(await readFile(join(box.newRoot, relative), 'utf8'), 'old version')
  } finally {
    await dispose(box)
  }
})

test('a settings write that fails leaves the old root in charge and says so', async () => {
  const box = await harness({ failPersist: true })
  try {
    const seeded = await seedWorkspace(box, '/srv/app')
    await assert.rejects(
      () => box.core.changeRemoteRoot(box.newRoot, { force: true }),
      /copied to .*could not be saved/,
    )
    // The old root is unchanged and still routes, so the workspace is not stranded.
    assert.equal(remoteRoot(), box.oldRoot)
    assert.equal(workspaceRoute(seeded.path)?.remotePath, '/srv/app')
    assert.equal(routeByCwd(seeded.path).kind, 'remote')
  } finally {
    await dispose(box)
  }
})

test('an invalid target is an error before any prompt, not a failed confirmation', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app', 1)
    // Inside the old root: refused even though there are live sessions.
    await assert.rejects(
      () => box.core.changeRemoteRoot(join(box.oldRoot, 'nested'), { force: true }),
      /must not be inside/,
    )
    assert.equal(box.updates.length, 0)
  } finally {
    await dispose(box)
  }
})

test('the same path is unchanged and only pins the setting when it differs', async () => {
  const box = await harness()
  try {
    const same = await box.core.changeRemoteRoot(box.oldRoot, { force: false })
    assert.equal(same.status, 'unchanged')
    assert.equal(box.updates.length, 0)
    const info = box.core.remoteRootInfo()
    assert.equal(info.current, box.oldRoot)
    assert.equal(info.defaultRoot !== undefined, true)
  } finally {
    await dispose(box)
  }
})

test('import merges by id and retags a renamed host, like saveHost', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const result = await box.core.importHostConfig({
      hosts: [{ id: 'host1', host: '10.0.0.5', username: 'me', name: 'prod' }],
    }, 'merge')
    assert.equal(result.updated, 1)
    assert.equal(box.core.listHosts()[0]?.name, 'prod')
    // The sidebar prefix follows the new name.
    assert.equal(box.registry.rows[0]?.title, 'prod · app')
    // The connection key did not change, so nothing was invalidated.
    assert.equal(box.updates.at(-1) !== undefined, true)
  } finally {
    await dispose(box)
  }
})

test('import replace turns a dropped host into a tombstone so its workspaces stay reachable', async () => {
  const box = await harness()
  try {
    const seeded = await seedWorkspace(box, '/srv/app')
    const result = await box.core.importHostConfig({ hosts: [{ id: 'other', host: '10.0.0.7', username: 'me' }] }, 'replace')
    assert.equal(result.removed, 1)
    assert.deepEqual(box.core.listHosts().map(item => item.id), ['other'])
    const deleted = box.core.listDeletedHosts()
    assert.deepEqual(deleted.map(item => item.id), ['host1'])
    // The row is still listed under the host it belongs to, and can be purged.
    assert.equal(box.core.listWorkspaces().some(item => item.workspaceId === seeded.id), true)
    const purged = await box.core.purgeHost('host1')
    assert.equal(purged.workspaces, 1)
  } finally {
    await dispose(box)
  }
})

test('clearing the field resets the root to the built-in default and migrates there', async () => {
  const box = await harness()
  const savedEnv = process.env.DSH_SSH_REMOTE_ROOT
  const builtin = join(box.box, 'builtin-default')
  // The built-in default reads this env var, so point it at a temp dir instead of
  // the real home. The routing override stays on the configured old root.
  process.env.DSH_SSH_REMOTE_ROOT = builtin
  try {
    const seeded = await seedWorkspace(box, '/srv/app')
    assert.equal(remoteRoot(), box.oldRoot)
    const reset = await box.core.changeRemoteRoot('', { force: false })
    assert.equal(reset.status, 'changed')
    assert.equal(remoteRoot(), builtin)
    const moved = mapRemoteToLocal('host1', '/srv/app')!
    assert.equal(moved.startsWith(builtin), true)
    assert.equal(await readFile(join(moved, 'left-behind.txt'), 'utf8'), 'from the remote command')
    // The old registration is gone; a new one sits under the default root.
    assert.equal(box.registry.rows.some(row => row.path === seeded.path), false)
    assert.equal(box.registry.rows.some(row => row.path === moved), true)
  } finally {
    if (savedEnv === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = savedEnv
    await dispose(box)
  }
})
