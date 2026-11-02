import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateRemoteRoot } from '../src/migrate.ts'
import { defaultRemoteRoot, expandRemoteRoot, remoteRoot, setRemoteRootOverride } from '../src/router.ts'
import {
  exportHostConfig,
  mergeImportedHosts,
  normalizeHostRow,
  parseHostImport,
  type DeletedHost,
  type HostConfig,
} from '../src/config.ts'

async function scratch(): Promise<{ dir: string, dispose: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-root-'))
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) }
}

function host(id: string, over: Partial<HostConfig> = {}): HostConfig {
  return {
    id,
    name: '',
    host: '192.0.2.1',
    port: 22,
    username: 'u',
    auth: 'key',
    privateKeyPath: '',
    fingerprint: '',
    opsPolicy: 'ask',
    loginEnv: false,
    ...over,
  }
}

test('an absent target is copied whole', async () => {
  const box = await scratch()
  try {
    const from = join(box.dir, 'old')
    const to = join(box.dir, 'new')
    await mkdir(join(from, 'host1', 'abc'), { recursive: true })
    await writeFile(join(from, 'host1', 'abc', 'x.txt'), 'hi')
    const report = await migrateRemoteRoot(from, to)
    assert.equal(report.action, 'copied')
    assert.equal(report.targetWasEmpty, true)
    assert.equal(await readFile(join(to, 'host1', 'abc', 'x.txt'), 'utf8'), 'hi')
  } finally {
    await box.dispose()
  }
})

test('an empty target directory is copied into, not nested', async () => {
  const box = await scratch()
  try {
    const from = join(box.dir, 'old')
    const to = join(box.dir, 'new')
    await mkdir(join(from, 'h'), { recursive: true })
    await writeFile(join(from, 'h', 'a'), 'a')
    await mkdir(to, { recursive: true })
    const report = await migrateRemoteRoot(from, to)
    assert.equal(report.action, 'copied')
    assert.equal(await readFile(join(to, 'h', 'a'), 'utf8'), 'a')
  } finally {
    await box.dispose()
  }
})

test('a non-empty target merges: copies missing, skips identical, keeps conflicts', async () => {
  const box = await scratch()
  try {
    const from = join(box.dir, 'old')
    const to = join(box.dir, 'new')
    await mkdir(from, { recursive: true })
    await mkdir(to, { recursive: true })
    await writeFile(join(from, 'missing.txt'), 'from')
    await writeFile(join(to, 'missing.txt'), 'from') // identical -> skipped
    await writeFile(join(from, 'add.txt'), 'add')
    await writeFile(join(from, 'clash.txt'), 'from-version')
    await writeFile(join(to, 'clash.txt'), 'target-version')
    await writeFile(join(to, 'only-target.txt'), 'keep')

    const report = await migrateRemoteRoot(from, to, 'auto')
    assert.equal(report.action, 'merged')
    assert.equal(report.copied, 1) // add.txt
    assert.equal(report.skipped, 1) // missing.txt (identical)
    assert.deepEqual(report.conflicts, ['clash.txt'])
    assert.equal(report.overwritten, 0)
    assert.equal(await readFile(join(to, 'add.txt'), 'utf8'), 'add')
    // auto keeps the target's differing copy
    assert.equal(await readFile(join(to, 'clash.txt'), 'utf8'), 'target-version')
    assert.equal(await readFile(join(to, 'only-target.txt'), 'utf8'), 'keep')
  } finally {
    await box.dispose()
  }
})

test('overwrite replaces conflicting target files from the old root', async () => {
  const box = await scratch()
  try {
    const from = join(box.dir, 'old')
    const to = join(box.dir, 'new')
    await mkdir(from, { recursive: true })
    await mkdir(to, { recursive: true })
    await writeFile(join(from, 'clash.txt'), 'from-version')
    await writeFile(join(to, 'clash.txt'), 'target-version')
    const report = await migrateRemoteRoot(from, to, 'overwrite')
    assert.equal(report.overwritten, 1)
    assert.deepEqual(report.conflicts, ['clash.txt'])
    assert.equal(await readFile(join(to, 'clash.txt'), 'utf8'), 'from-version')
  } finally {
    await box.dispose()
  }
})

test('a target nested inside the old root is refused', async () => {
  const box = await scratch()
  try {
    const from = join(box.dir, 'old')
    await mkdir(from, { recursive: true })
    await assert.rejects(() => migrateRemoteRoot(from, join(from, 'nested'), 'auto'), /must not be inside/)
  } finally {
    await box.dispose()
  }
})

test('a missing old root just creates the target', async () => {
  const box = await scratch()
  try {
    const from = join(box.dir, 'never')
    const to = join(box.dir, 'new')
    const report = await migrateRemoteRoot(from, to, 'auto')
    assert.equal(report.action, 'copied')
    assert.equal(report.copied, 0)
  } finally {
    await box.dispose()
  }
})

test('setRemoteRootOverride wins over the environment until cleared', () => {
  const env = { DSH_HOME: '/tmp/home' }
  try {
    setRemoteRootOverride('/tmp/somewhere')
    assert.equal(remoteRoot(env), '/tmp/somewhere')
    // The built-in default ignores the override, so the page can still show it.
    assert.equal(defaultRemoteRoot(env), '/tmp/home/remote')
  } finally {
    setRemoteRootOverride(null)
  }
  assert.equal(remoteRoot(env), '/tmp/home/remote')
})

test('expandRemoteRoot expands ~ and refuses relative input', () => {
  const env = { HOME: '/home/me' }
  assert.equal(expandRemoteRoot('~/mirror', env), '/home/me/mirror')
  assert.equal(expandRemoteRoot('~', env), '/home/me')
  assert.equal(expandRemoteRoot('/abs/path', env), '/abs/path')
  assert.equal(expandRemoteRoot('relative/path', env), null)
  assert.equal(expandRemoteRoot('   ', env), null)
})

test('normalizeHostRow applies defaults and validates required fields', () => {
  const row = normalizeHostRow({ id: 'host-1', host: '10.0.0.1', username: 'root' })
  assert.equal(row.port, 22)
  assert.equal(row.auth, 'key')
  assert.equal(row.opsPolicy, 'ask')
  assert.equal(row.loginEnv, false)
  assert.throws(() => normalizeHostRow({ id: 'Bad Id', host: 'x', username: 'u' }), /invalid id/)
  assert.throws(() => normalizeHostRow({ id: 'h', username: 'u' }), /missing its address/)
  assert.throws(() => normalizeHostRow({ id: 'h', host: 'x' }), /missing its username/)
})

test('parseHostImport accepts a bare array and rejects duplicate ids', () => {
  const parsed = parseHostImport([{ id: 'a', host: 'x', username: 'u' }])
  assert.equal(parsed.hosts.length, 1)
  assert.throws(
    () => parseHostImport([{ id: 'a', host: 'x', username: 'u' }, { id: 'a', host: 'y', username: 'u' }]),
    /more than once/,
  )
})

test('mergeImportedHosts merges by id and revives tombstones', () => {
  const current = [host('a', { port: 2200 }), host('b')]
  const tombstone: DeletedHost = { host: host('a'), deletedAt: '2024-01-01' }
  const incoming = parseHostImport({ hosts: [{ id: 'a', host: '10.0.0.9', username: 'u', port: 22 }, { id: 'c', host: '10.0.0.3', username: 'u' }] })
  const result = mergeImportedHosts(current, [tombstone], incoming, 'merge')
  assert.equal(result.added, 1)
  assert.equal(result.updated, 1)
  assert.equal(result.hosts.length, 3)
  assert.equal(result.hosts.find(item => item.id === 'a')?.host, '10.0.0.9')
  // A host that is imported live must not stay in the deleted list.
  assert.equal(result.deletedHosts.length, 0)
})

test('mergeImportedHosts replace makes the file the whole list', () => {
  const current = [host('a'), host('b')]
  const incoming = parseHostImport([{ id: 'c', host: '10.0.0.3', username: 'u' }])
  const result = mergeImportedHosts(current, [], incoming, 'replace')
  assert.equal(result.added, 1)
  assert.equal(result.removed, 2)
  assert.deepEqual(result.hosts.map(item => item.id), ['c'])
})

test('exportHostConfig round-trips through parseHostImport', () => {
  const payload = exportHostConfig([host('a', { name: 'Alpha', opsPolicy: 'trust' })], [])
  const parsed = parseHostImport(payload)
  assert.equal(parsed.hosts.length, 1)
  assert.equal(parsed.hosts[0]?.name, 'Alpha')
  assert.equal(parsed.hosts[0]?.opsPolicy, 'trust')
})
