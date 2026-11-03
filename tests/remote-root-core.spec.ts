import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { constants as zconst, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { readConfig, type HostConfig } from '../src/config.ts'
import { Core } from '../src/index.ts'
import { clearSupersededRoots, encodeRemotePath, mapRemoteToLocal, remoteRoot, routeByCwd, setRemoteRootOverride } from '../src/router.ts'
import { encodeSegment, projectKey, scanLogFrames } from '../src/session-relocate.ts'
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
  /** Ids this row was asked to account, in order — the registry's attachSession. */
  attached: unknown[] = []

  constructor(readonly id: string, readonly path: string, title: string, readonly sessionIds: readonly unknown[] = []) {
    this.title = title
  }

  async setTitle(title: string): Promise<void> {
    this.title = title
  }

  async attachSession(sessionId: unknown): Promise<void> {
    if (this.sessionIds.includes(sessionId)) return
    this.attached.push(sessionId)
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

/** The same host context for the first load and for simulated restarts. */
function makeCtx(options: {
  updates: Array<Record<string, unknown>>
  droppedSecrets: unknown[]
  liveAgents: Array<{ session?: { id?: string } }>
  failPersist?: boolean
  failMigrationPersist?: boolean
}) {
  return {
    logger: { info() {}, warn() {} },
    settings: {
      configure: () => () => undefined,
      describe: () => [{ ns: 'permission-remote' }],
      update: async (_ns: string, patch: Record<string, unknown>) => {
        if (options.failPersist === true) throw new Error('settings write refused')
        if (options.failMigrationPersist === true && ('supersededRemoteRoots' in patch || 'pendingSessionGrouping' in patch)) {
          throw new Error('migration bookkeeping write refused')
        }
        options.updates.push(patch)
      },
    },
    credentials: {
      readRecord: async () => undefined,
      modifyRecord: async () => undefined,
      deleteRecord: async (key: unknown) => { options.droppedSecrets.push(key) },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'read-only' }) },
    tools: { get: () => undefined, register: () => () => undefined },
    get: (service: string) => service === 'agents' ? { list: () => options.liveAgents } : undefined,
    on: () => () => undefined,
    effect: () => undefined,
  }
}

interface Harness {
  box: string
  oldRoot: string
  newRoot: string
  registry: FakeRegistry
  core: Core
  updates: Array<Record<string, unknown>>
  droppedSecrets: unknown[]
  /** Agents the plugin sees through `ctx.get('agents')`; their session ids are "live". */
  liveAgents: Array<{ session?: { id?: string } }>
  /** `DSH_HOME` before the harness pinned it to the fixture box. */
  savedHome: string | undefined
}

async function harness(options: { sessions?: number, failPersist?: boolean, failMigrationPersist?: boolean, hosts?: HostConfig[] } = {}): Promise<Harness> {
  const box = await mkdtemp(join(tmpdir(), 'dsh-root-core-'))
  const oldRoot = join(box, 'old-root')
  const newRoot = join(box, 'new-root')
  await mkdir(oldRoot, { recursive: true })
  const updates: Array<Record<string, unknown>> = []
  const droppedSecrets: unknown[] = []
  const liveAgents: Array<{ session?: { id?: string } }> = []
  const ctx = makeCtx({ updates, droppedSecrets, liveAgents, failPersist: options.failPersist === true, failMigrationPersist: options.failMigrationPersist === true })
  const registry = new FakeRegistry()
  const config = readConfig({ hosts: options.hosts ?? [host()], deletedHosts: [], remoteRoot: oldRoot })
  const core = new Core(ctx as never, config, registry)
  core.applyRemoteRootOverride()
  // Session relocation must scan a store the test owns, never the real home.
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = box
  return { box, oldRoot, newRoot, registry, core, updates, droppedSecrets, liveAgents, savedHome }
}

async function dispose(box: Harness): Promise<void> {
  clearSupersededRoots()
  setRemoteRootOverride(null)
  if (box.savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = box.savedHome
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

    // The root is written once, then the migration bookkeeping follows.
    assert.deepEqual(box.updates.at(0), { remoteRoot: box.newRoot })
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
    // The new registration is rolled back with the failed save.
    assert.deepEqual(box.registry.rows.map(row => row.id), [seeded.id])
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
    // Fields the file did not mention stay. A rename is not a new machine.
    assert.equal(box.core.listHosts()[0]?.fingerprint, 'SHA256:abc')
    assert.equal(box.core.listHosts()[0]?.opsPolicy, 'ask')
    assert.deepEqual(box.droppedSecrets, [])
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

test('a partial import keeps deny and an omitted fingerprint', async () => {
  const box = await harness({ hosts: [host({ opsPolicy: 'deny' })] })
  try {
    const result = await box.core.importHostConfig({
      hosts: [{ id: 'host1', host: '10.0.0.5', username: 'me', name: 'still' }],
    }, 'merge')
    assert.equal(result.updated, 1)
    assert.equal(box.core.listHosts()[0]?.name, 'still')
    assert.equal(box.core.listHosts()[0]?.opsPolicy, 'deny')
    assert.equal(box.core.listHosts()[0]?.fingerprint, 'SHA256:abc')
    assert.deepEqual(box.droppedSecrets, [])
  } finally {
    await dispose(box)
  }
})

test('a changed address drops the saved password and an omitted fingerprint', async () => {
  const box = await harness()
  try {
    await box.core.importHostConfig({
      hosts: [{ id: 'host1', host: '10.1.1.1', username: 'me' }],
    }, 'merge')
    const row = box.core.listHosts()[0]
    assert.equal(row?.host, '10.1.1.1')
    assert.equal(row?.fingerprint, '')
    assert.equal(row?.opsPolicy, 'ask')
    assert.deepEqual(box.droppedSecrets, [credentialKey('dsh-permission-remote', 'host1')])
  } finally {
    await dispose(box)
  }
})

test('replace keeps a deleted host that still owns a workspace', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    await box.core.deleteHost('host1')
    assert.deepEqual(box.core.listHosts().map(item => item.id), [])
    const result = await box.core.importHostConfig({
      hosts: [{ id: 'other', host: '10.0.0.7', username: 'me' }],
    }, 'replace')
    assert.equal(result.deletedHosts.some(row => row.host.id === 'host1'), true)
    assert.equal(box.core.listDeletedHosts().some(item => item.id === 'host1'), true)
    await box.core.restoreHost('host1')
    const restored = box.core.listHosts().find(item => item.id === 'host1')
    assert.equal(restored?.host, '10.0.0.5')
    assert.equal(restored?.fingerprint, 'SHA256:abc')
  } finally {
    await dispose(box)
  }
})

test('a placeholder that clashes with a file is refused before the root switches', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const rel = `host1/${encodeRemotePath('/srv/app')}`
    await mkdir(join(box.newRoot, 'host1'), { recursive: true })
    await writeFile(join(box.newRoot, rel), 'not a directory')
    await assert.rejects(
      () => box.core.changeRemoteRoot(box.newRoot, { force: true, strategy: 'auto' }),
      /conflicts with an existing file/,
    )
    assert.equal(remoteRoot(), box.oldRoot)
    assert.equal(box.updates.length, 0)
    assert.equal(await readFile(join(box.newRoot, rel), 'utf8'), 'not a directory')
  } finally {
    await dispose(box)
  }
})

test('a content conflict inside a placeholder does not block the move', async () => {
  const box = await harness()
  try {
    const seeded = await seedWorkspace(box, '/srv/app')
    const rel = relative(box.oldRoot, join(seeded.path, 'left-behind.txt')).split('\\').join('/')
    await mkdir(dirname(join(box.newRoot, rel)), { recursive: true })
    await writeFile(join(box.newRoot, rel), 'other')
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true, strategy: 'auto' })
    assert.equal(moved.status, 'changed')
    assert.equal(await readFile(join(box.newRoot, rel), 'utf8'), 'other')
  } finally {
    await dispose(box)
  }
})

test('a conflict that was not in the shown list is asked again and not copied', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    await mkdir(join(box.newRoot, 'host1'), { recursive: true })
    await writeFile(join(box.newRoot, 'host1', 'w0'), 'target version')
    await writeFile(join(box.oldRoot, 'host1', 'w0'), 'old version')
    const planned = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(planned.status, 'needs-strategy')
    await writeFile(join(box.newRoot, 'extra.txt'), 'target extra')
    await writeFile(join(box.oldRoot, 'extra.txt'), 'old extra')
    const again = await box.core.changeRemoteRoot(box.newRoot, {
      force: true,
      strategy: 'overwrite',
      acceptedConflicts: planned.conflicts,
    })
    assert.equal(again.status, 'needs-strategy')
    assert.equal(again.conflicts?.includes('extra.txt'), true)
    assert.equal(remoteRoot(), box.oldRoot)
    assert.equal(box.updates.length, 0)
    assert.equal(await readFile(join(box.newRoot, 'host1', 'w0'), 'utf8'), 'target version')
    assert.equal(await readFile(join(box.newRoot, 'extra.txt'), 'utf8'), 'target extra')
  } finally {
    await dispose(box)
  }
})

test('a workspace that cannot be removed is reported after the root has switched', async () => {
  const box = await harness()
  try {
    const seeded = await seedWorkspace(box, '/srv/app')
    const original = box.registry.delete.bind(box.registry)
    box.registry.delete = (id: unknown) => {
      if (id === seeded.id) return Promise.reject(new Error('registry busy'))
      return original(id)
    }
    await assert.rejects(
      () => box.core.changeRemoteRoot(box.newRoot, { force: true }),
      /the remote root is now .*could not be removed.*w-seed/,
    )
    assert.equal(remoteRoot(), box.newRoot)
    assert.equal(box.registry.rows.some(row => row.id === seeded.id), true)
    assert.equal(box.registry.rows.some(row => row.path !== seeded.path), true)
  } finally {
    await dispose(box)
  }
})

/** Build a stored session log the way the persistence backend does: checksummed header frame plus event frames. */
async function seedStoredLog(dir: string, id: string, cwd: string, options: {
  events?: Array<Record<string, unknown>>
  name?: string
  tornTail?: Buffer
} = {}): Promise<string> {
  const checksum = { params: { [zconst.ZSTD_c_checksumFlag]: 1 } }
  const frames = [
    zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', id, cwd, version: 4 })}\n`, 'utf8'), checksum),
    ...(options.events ?? []).map(event => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'), checksum)),
  ]
  await mkdir(dir, { recursive: true })
  const log = join(dir, options.name ?? 'session.v4.jsonl.zstd')
  await writeFile(log, Buffer.concat([...frames, ...(options.tornTail === undefined ? [] : [options.tornTail])]))
  return log
}

/** A stored session at the canonical location its cwd implies. */
function storedSessionDir(box: Harness, cwd: string, id: string): string {
  return join(box.box, 'sessions', projectKey(cwd), encodeSegment(id))
}

async function seedStoredSession(box: Harness, id: string, cwd: string, events: Array<Record<string, unknown>> = []): Promise<string> {
  return seedStoredLog(storedSessionDir(box, cwd, id), id, cwd, { events })
}

/** Decode the header record of a stored log. */
function headerOf(bytes: Buffer): Record<string, unknown> {
  const scan = scanLogFrames(bytes)
  if (scan.frames.length === 0) throw new Error('no complete header frame')
  return JSON.parse(zstdDecompressSync(bytes.subarray(scan.frames[0].start, scan.frames[0].end)).subarray(0, -1).toString('utf8'))
}

async function logAt(path: string): Promise<Buffer> {
  return readFile(path)
}

/** Write a session log with an explicit header record (for reconciliation fixtures). */
async function seedRawLog(dir: string, name: string, header: Buffer): Promise<string> {
  const checksum = { params: { [zconst.ZSTD_c_checksumFlag]: 1 } }
  await mkdir(dir, { recursive: true })
  const log = join(dir, name)
  await writeFile(log, Buffer.concat([zstdCompressSync(header, checksum), zstdCompressSync(Buffer.from('{"type":"session/append","seq":1}\n', 'utf8'), checksum)]))
  return log
}

test('a migration moves stored sessions onto the new root and queues their group restoration', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    const original = await readFile(await seedStoredSession(box, 'session-move-1', oldLocal, [
      { type: 'session/append', seq: 1, data: { text: 'history must survive byte for byte' } },
    ]))

    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 1)
    assert.equal(moved.sessionsSkippedLive, 0)
    assert.equal(moved.sessionsFailed, 0)

    // The log now sits where the new placeholder implies, header naming it and
    // the event history byte for byte identical.
    const newLocal = mapRemoteToLocal('host1', '/srv/app')!
    assert.equal(newLocal.startsWith(box.newRoot), true)
    const movedLog = join(storedSessionDir(box, newLocal, 'session-move-1'), 'session.v4.jsonl.zstd')
    const bytes = await logAt(movedLog)
    const frames = scanLogFrames(bytes).frames
    assert.equal(frames.length, 2)
    const header = headerOf(bytes)
    assert.equal(header.cwd, newLocal)
    assert.equal(header.id, 'session-move-1')
    assert.equal(bytes.subarray(frames[1].start).equals(original.subarray(scanLogFrames(original).frames[1].start)), true)

    // The old session directory and the emptied old project directory are gone.
    await assert.rejects(() => readFile(join(storedSessionDir(box, oldLocal, 'session-move-1'), 'session.v4.jsonl.zstd')), /ENOENT/)
    await assert.rejects(() => stat(join(box.box, 'sessions', projectKey(oldLocal))), /ENOENT/)

    // Grouping cannot be restored in-process (the registry caches headers at
    // startup), so the move is persisted for the next load instead of being
    // reported as finished.
    const recreated = box.registry.rows.find(row => row.path !== undefined && row.path !== oldLocal)
    assert.ok(recreated)
    const pending = box.updates.map(patch => patch.pendingSessionGrouping).filter(Array.isArray).at(-1) as Array<{ path: string, id: string }>
    assert.deepEqual(pending, [{ path: newLocal, id: 'session-move-1' }])
    assert.equal((box.updates.at(-1)?.supersededRemoteRoots as string[]).includes(box.oldRoot), true)
    assert.deepEqual((recreated as FakeWorkspace).attached, [])
  } finally {
    await dispose(box)
  }
})

test('open sessions are skipped by a migration and follow on a re-save', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    await seedStoredSession(box, 'session-closed', oldLocal, [{ type: 'session/append', seq: 1 }])
    const openLog = await seedStoredSession(box, 'session-open', oldLocal, [{ type: 'session/append', seq: 1 }])
    box.liveAgents.push({ session: { id: 'session-open' } })

    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 1)
    assert.equal(moved.sessionsSkippedLive, 1)
    // The open session's file was never touched and still names the old root;
    // the superseded root keeps it routing to its server until it is closed.
    assert.equal(headerOf(await readFile(openLog)).cwd, oldLocal)
    await assert.rejects(() => readFile(join(storedSessionDir(box, oldLocal, 'session-closed'), 'session.v4.jsonl.zstd')), /ENOENT/)

    // The operator closes the session and saves the same root again: the
    // catch-up sweep moves what the migration had to leave behind.
    box.liveAgents.length = 0
    const again = await box.core.changeRemoteRoot(box.newRoot, { force: false })
    assert.equal(again.status, 'unchanged')
    assert.equal(again.sessionsRelocated, 1)
    assert.equal(again.sessionsSkippedLive, 0)
    const newLocal = mapRemoteToLocal('host1', '/srv/app')!
    const sweptLog = join(storedSessionDir(box, newLocal, 'session-open'), 'session.v4.jsonl.zstd')
    assert.equal(headerOf(await readFile(sweptLog)).cwd, newLocal)
    await assert.rejects(() => readFile(openLog), /ENOENT/)
  } finally {
    await dispose(box)
  }
})

test('a plain save with no known old root does not scan the store', async () => {
  const box = await harness()
  try {
    const same = await box.core.changeRemoteRoot(box.oldRoot, { force: false })
    assert.equal(same.status, 'unchanged')
    assert.equal(same.sessionsRelocated, undefined)
    assert.equal(box.updates.length, 0)
  } finally {
    await dispose(box)
  }
})

test('generation 0 logs are relocated too', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    // DSH writes generation 0 without a version tag; a v4-only matcher would
    // silently skip these (real stores keep half their sessions this way).
    const oldLog = await seedStoredLog(storedSessionDir(box, oldLocal, 'session-v0'), 'session-v0', oldLocal, {
      name: 'session.jsonl.zstd',
      events: [{ type: 'session/append', seq: 1 }],
    })
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 1)
    assert.equal(moved.sessionsFailed, 0)
    const newLocal = mapRemoteToLocal('host1', '/srv/app')!
    const newLog = join(storedSessionDir(box, newLocal, 'session-v0'), 'session.jsonl.zstd')
    assert.equal(headerOf(await readFile(newLog)).cwd, newLocal)
    await assert.rejects(() => readFile(oldLog), /ENOENT/)
  } finally {
    await dispose(box)
  }
})

test('a torn final frame is preserved and does not block the move', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    const goodFrame = zstdCompressSync(Buffer.from('{"type":"session/append","seq":2}\n', 'utf8'), { params: { [zconst.ZSTD_c_checksumFlag]: 1 } })
    // A crash mid-append leaves a truncated frame; DSH opens such logs as a
    // committed prefix, so the migration must move them, not refuse them.
    const torn = goodFrame.subarray(0, Math.max(4, goodFrame.length - 6))
    const log = await seedStoredLog(storedSessionDir(box, oldLocal, 'session-torn'), 'session-torn', oldLocal, {
      events: [{ type: 'session/append', seq: 1 }],
      tornTail: torn,
    })
    const before = await readFile(log)
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 1)
    assert.equal(moved.sessionsFailed, 0)
    const newLocal = mapRemoteToLocal('host1', '/srv/app')!
    const after = await readFile(join(storedSessionDir(box, newLocal, 'session-torn'), 'session.v4.jsonl.zstd'))
    // Complete frames moved, torn bytes kept exactly, header rewritten.
    assert.equal(scanLogFrames(after).frames.length, 2)
    assert.equal(scanLogFrames(after).tornStart !== undefined, true)
    const beforeScan = scanLogFrames(before)
    const afterScan = scanLogFrames(after)
    assert.equal(after.subarray(afterScan.tornStart!).equals(before.subarray(beforeScan.tornStart!)), true)
    assert.equal(headerOf(after).cwd, newLocal)
  } finally {
    await dispose(box)
  }
})

test('a rename that died before the rewrite is finished in place on the next run', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    const newLocal = join(box.newRoot, 'host1', encodeRemotePath('/srv/app'))
    // The earlier run renamed the directory but died before rewriting the
    // header: the session sits at the destination still naming the old root.
    await seedRawLog(
      join(box.box, 'sessions', projectKey(newLocal), encodeSegment('session-renamed')),
      'session.v4.jsonl.zstd',
      Buffer.from(`${JSON.stringify({ type: 'session', id: 'session-renamed', cwd: oldLocal, version: 4 })}\n`, 'utf8'),
    )
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 1)
    assert.equal(moved.sessionsFailed, 0)
    assert.equal(headerOf(await readFile(join(storedSessionDir(box, newLocal, 'session-renamed'), 'session.v4.jsonl.zstd'))).cwd, newLocal)
  } finally {
    await dispose(box)
  }
})

test('a rewrite that died before the cleanup only removes the stale source', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    const newLocal = join(box.newRoot, 'host1', encodeRemotePath('/srv/app'))
    // Completed destination plus a leftover source copy: the next run finishes
    // by deleting the source, never by writing a duplicate log.
    await seedStoredLog(join(box.box, 'sessions', projectKey(newLocal), encodeSegment('session-done')), 'session-done', newLocal, {
      events: [{ type: 'session/append', seq: 1 }],
    })
    const staleSource = await seedStoredSession(box, 'session-done', oldLocal, [{ type: 'session/append', seq: 1 }])
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 1)
    assert.equal(moved.sessionsFailed, 0)
    await assert.rejects(() => readFile(staleSource), /ENOENT/)
    const dest = join(storedSessionDir(box, newLocal, 'session-done'), 'session.v4.jsonl.zstd')
    assert.equal(headerOf(await readFile(dest)).cwd, newLocal)
  } finally {
    await dispose(box)
  }
})

test('a session whose target belongs to another session is reported, not overwritten', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    await seedStoredSession(box, 'session-clash', oldLocal)
    const newLocal = join(box.newRoot, 'host1', encodeRemotePath('/srv/app'))
    // A different session already occupies the destination id segment.
    const destination = await seedStoredLog(join(box.box, 'sessions', projectKey(newLocal), encodeSegment('session-clash')), 'session-other', newLocal)
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 0)
    assert.equal(moved.sessionsFailed, 1)
    assert.equal(headerOf(await readFile(destination)).cwd, newLocal)
    assert.equal(headerOf(await readFile(join(storedSessionDir(box, oldLocal, 'session-clash'), 'session.v4.jsonl.zstd'))).cwd, oldLocal)
  } finally {
    await dispose(box)
  }
})

test('a directory whose name disagrees with projectKey(cwd) is refused loudly', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    // A drifted copy of the project-key algorithm would have placed this log
    // under a wrong directory; the drift guard must report it, not move it.
    const drifted = join(box.box, 'sessions', '--not-the-right-project--', encodeSegment('session-drift'))
    await seedRawLog(drifted, 'session.v4.jsonl.zstd', Buffer.from(`${JSON.stringify({ type: 'session', id: 'session-drift', cwd: oldLocal, version: 4 })}\n`, 'utf8'))
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 0)
    assert.equal(moved.sessionsFailed, 1)
    assert.equal(headerOf(await readFile(join(drifted, 'session.v4.jsonl.zstd'))).cwd, oldLocal)
  } finally {
    await dispose(box)
  }
})

/** A registry whose attachSession validates a header cache, like the real one. */
class ValidatingRegistry extends FakeRegistry {
  /** id → header cwd the registry would answer from; undefined means "read the disk". */
  constructor(readonly cache: Map<string, string>) {
    super()
  }

  override create(dir: string, title?: string): Promise<WorkspaceLike> {
    return super.create(dir, title)
  }

  /** Validate like the real registry: cached header cwd must equal the row path. */
  attachInto(row: FakeWorkspace): void {
    row.attachSession = async (sessionId: unknown) => {
      const id = String(sessionId)
      const cache = this.cache.get(id)
      let cwd = cache
      if (cwd === undefined) {
        const bytes = await readFile(join(storedSessionDirAt(row.path, id), 'session.v4.jsonl.zstd'))
        cwd = String(headerOf(bytes).cwd)
      }
      if (cwd !== row.path) throw new Error(`its cwd resolves to '${cwd}'`)
      row.attached.push(id)
    }
  }
}

function storedSessionDirAt(workspacePath: string, id: string): string {
  return join(process.env.DSH_HOME!, 'sessions', projectKey(workspacePath), encodeSegment(id))
}

test('a moved session joins its workspace on the next load, when the cache is fresh', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    await seedStoredSession(box, 'session-later', oldLocal, [{ type: 'session/append', seq: 1 }])
    box.liveAgents.push({ session: { id: 'session-other-open' } })
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.sessionsRelocated, 1)

    // The registry row now points at the new placeholder.
    const row = box.registry.rows.find(item => item.path.startsWith(box.newRoot))
    assert.ok(row)
    // Real registries validate against the cwd from their header cache; a
    // stale entry (the pre-move cwd) is exactly why an in-process attach had
    // to be deferred. The next load's cache is rebuilt from disk instead.
    ;(row as FakeWorkspace).attachSession = async (sessionId: unknown) => {
      const bytes = await readFile(join(storedSessionDir(box, mapRemoteToLocal('host1', '/srv/app')!, String(sessionId)), 'session.v4.jsonl.zstd'))
      if (headerOf(bytes).cwd !== row.path) throw new Error('stale header')
      ;(row as FakeWorkspace).attached.push(String(sessionId))
    }
    const pendingBefore = box.updates.map(patch => patch.pendingSessionGrouping).filter(Array.isArray).at(-1) as Array<{ path: string, id: string }>
    assert.equal(pendingBefore.length, 1)
    // Simulated restart: a fresh Core over the same context, config and store.
    const reloadCtx = makeCtx({ updates: box.updates, droppedSecrets: box.droppedSecrets, liveAgents: [] })
    const reloadConfig = readConfig({
      hosts: [host()],
      deletedHosts: [],
      remoteRoot: box.newRoot,
      supersededRemoteRoots: pendingBefore.length > 0 ? [box.oldRoot] : [],
      pendingSessionGrouping: pendingBefore,
    })
    const reloaded = new Core(reloadCtx as never, reloadConfig, box.registry)
    reloaded.applyRemoteRootOverride()
    await reloaded.resumeSessionMigrationState()
    assert.deepEqual((row as FakeWorkspace).attached, ['session-later'])
    const cleared = box.updates.map(patch => patch.pendingSessionGrouping).filter(Array.isArray).at(-1) as Array<{ path: string, id: string }>
    assert.deepEqual(cleared, [])
  } finally {
    await dispose(box)
  }
})

test('membership that cannot validate yet stays pending for the next load', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    await seedStoredSession(box, 'session-stuck', oldLocal, [{ type: 'session/append', seq: 1 }])
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.sessionsRelocated, 1)
    const row = box.registry.rows.find(item => item.path.startsWith(box.newRoot))
    assert.ok(row)
    // The destination is still named by the old root in a stale cache: attach
    // throws, and the entry must survive so the next load retries it.
    ;(row as FakeWorkspace).attachSession = async () => { throw new Error("its cwd resolves to the old root") }
    const pending = box.updates.map(patch => patch.pendingSessionGrouping).filter(Array.isArray).at(-1) as Array<{ path: string, id: string }>
    const reloadCtx = makeCtx({ updates: box.updates, droppedSecrets: box.droppedSecrets, liveAgents: [] })
    const reloadConfig = readConfig({
      hosts: [host()],
      deletedHosts: [],
      remoteRoot: box.newRoot,
      supersededRemoteRoots: [box.oldRoot],
      pendingSessionGrouping: pending,
    })
    const reloaded = new Core(reloadCtx as never, reloadConfig, box.registry)
    reloaded.applyRemoteRootOverride()
    await reloaded.resumeSessionMigrationState()
    const stillPending = box.updates.map(patch => patch.pendingSessionGrouping).filter(Array.isArray).at(-1) as Array<{ path: string, id: string }>
    assert.deepEqual(stillPending, pending)
  } finally {
    await dispose(box)
  }
})

test('a plaintext log is relocated with its body preserved', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    const dir = storedSessionDir(box, oldLocal, 'session-plain')
    await mkdir(dir, { recursive: true })
    const body = '{"type":"session/append","seq":1,"data":{"t":"kept"}}\n{"type":"session/append","seq":2}\n'
    const oldLog = join(dir, 'session.jsonl')
    await writeFile(oldLog, `{"type":"session","id":"session-plain","cwd":${JSON.stringify(oldLocal)},"version":4}\n${body}`)
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 1)
    assert.equal(moved.sessionsFailed, 0)
    const newLocal = mapRemoteToLocal('host1', '/srv/app')!
    const text = await readFile(join(storedSessionDir(box, newLocal, 'session-plain'), 'session.jsonl'), 'utf8')
    const cut = text.indexOf('\n')
    assert.equal(JSON.parse(text.slice(0, cut)).cwd, newLocal)
    assert.equal(text.slice(cut + 1), body)
    await assert.rejects(() => readFile(oldLog), /ENOENT/)
  } finally {
    await dispose(box)
  }
})

test('a session id that needs path encoding is not mistaken for a mismatch', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    const id = 'weird id:with chars'
    const dir = join(box.box, 'sessions', projectKey(oldLocal), encodeSegment(id))
    await seedStoredLog(dir, id, oldLocal, { name: 'session.v4.jsonl.zstd', events: [{ type: 'session/append', seq: 1 }] })
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 1)
    assert.equal(moved.sessionsFailed, 0)
    const newLocal = mapRemoteToLocal('host1', '/srv/app')!
    assert.equal(headerOf(await readFile(join(box.box, 'sessions', projectKey(newLocal), encodeSegment(id), 'session.v4.jsonl.zstd'))).cwd, newLocal)
  } finally {
    await dispose(box)
  }
})

test('a settings write that fails only for the bookkeeping does not fail the move', async () => {
  const box = await harness({ failMigrationPersist: true })
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    await seedStoredSession(box, 'session-keep', oldLocal, [{ type: 'session/append', seq: 1 }])
    const moved = await box.core.changeRemoteRoot(box.newRoot, { force: true })
    assert.equal(moved.status, 'changed')
    assert.equal(moved.sessionsRelocated, 1)
    const newLocal = mapRemoteToLocal('host1', '/srv/app')!
    assert.equal(headerOf(await readFile(join(storedSessionDir(box, newLocal, 'session-keep'), 'session.v4.jsonl.zstd'))).cwd, newLocal)
  } finally {
    await dispose(box)
  }
})

test('a drained superseded root is pruned so startup stops rescanning it', async () => {
  const box = await harness()
  try {
    await seedWorkspace(box, '/srv/app')
    const oldLocal = mapRemoteToLocal('host1', '/srv/app')!
    await seedStoredSession(box, 'session-drain', oldLocal, [{ type: 'session/append', seq: 1 }])
    await box.core.changeRemoteRoot(box.newRoot, { force: true })
    // Simulated restart: the migration is done, old root holds nothing left.
    const reloadCtx = makeCtx({ updates: box.updates, droppedSecrets: box.droppedSecrets, liveAgents: [] })
    const reloadConfig = readConfig({
      hosts: [host()],
      deletedHosts: [],
      remoteRoot: box.newRoot,
      supersededRemoteRoots: [box.oldRoot],
      pendingSessionGrouping: [],
    })
    const reloaded = new Core(reloadCtx as never, reloadConfig, box.registry)
    reloaded.applyRemoteRootOverride()
    await reloaded.resumeSessionMigrationState()
    const lastSuperseded = box.updates.map(patch => patch.supersededRemoteRoots).filter(Array.isArray).at(-1) as string[]
    assert.deepEqual(lastSuperseded, [])
  } finally {
    await dispose(box)
  }
})
