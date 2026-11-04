import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FsError, FsTargetKey, type FsDirEntry, type FsTarget } from '@deepseek-ai/dsh-fs'
import type { HostConfig } from '../src/config.ts'
import { installRemoteFs, type RemoteAccess } from '../src/remote-fs.ts'
import { addSupersededRoot, clearSupersededRoots, encodeRemotePath, setRemoteRootOverride } from '../src/router.ts'
import { listingType, probeOpenDir, readOpenChunks, readOpenRange, SshFailure, type RemoteDirEntry, type SftpAttrs } from '../src/ssh-pool.ts'

const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-fs-'))
process.env.DSH_SSH_REMOTE_ROOT = root
setRemoteRootOverride(null)

const REMOTE = '/home/me/project'
const host = { id: 'lo' } as HostConfig

function placeholder(...extra: string[]): string {
  return path.join(root, 'lo', encodeRemotePath(REMOTE), ...extra)
}

interface Pool {
  realpath(remotePath: string): Promise<string>
  attrs(remotePath: string, follow: boolean): Promise<SftpAttrs | undefined>
  readDir(remotePath: string): Promise<RemoteDirEntry[]>
  readLink(remotePath: string): Promise<string>
  read(remotePath: string, maxBytes?: number): Promise<Buffer>
  readAt(remotePath: string, offset: number, length: number): Promise<Buffer>
  chunks(remotePath: string): AsyncIterable<Buffer>
  reads: number
  readAts: Array<{ offset: number, length: number }>
}

function createHarness(warnings: string[] = [], options?: { now?: () => number, metaTtlMs?: number, attrTtlMs?: number }) {
  const pool: Pool = {
    reads: 0,
    readAts: [],
    async realpath(remotePath) { return remotePath },
    async attrs() { return { type: 'directory', size: 0, mtime: 1 } },
    async readDir() { return [] },
    async readLink() { throw new SshFailure('Failure', 'sftp-readlink') },
    async read() {
      pool.reads += 1
      return Buffer.alloc(0)
    },
    async readAt(_remotePath, offset, length) {
      pool.readAts.push({ offset, length })
      return Buffer.from('hi')
    },
    async *chunks() { yield Buffer.from('ok') },
  }
  class Backend {
    delegated = false
    watched = 0
    writes = 0
    edits = 0
    get sandboxMode(): string { return 'workspace-write' }
    async resolve(requested: string, _opts?: { cwd?: string, signal?: AbortSignal }): Promise<FsTarget> {
      this.delegated = true
      return { targetKey: FsTargetKey(requested), displayPath: requested }
    }
    processPath(target: FsTarget): string { return String(target.targetKey) }
    contains(parent: FsTarget, child: FsTarget): boolean {
      const rel = path.relative(String(parent.targetKey), String(child.targetKey))
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    }
    localStat: (target?: FsTarget) => Promise<{ type: string, version?: string, size?: number } | undefined> = async () => undefined
    localLstat: (requested?: string) => Promise<{ type: string, version?: string, size?: number } | undefined> = async () => undefined
    async stat(target?: FsTarget, _signal?: AbortSignal): Promise<{ type: string, version?: string, size?: number } | undefined> { return this.localStat(target) }
    async lstat(requested?: string, _opts?: { cwd?: string }, _signal?: AbortSignal): Promise<{ type: string, version?: string, size?: number } | undefined> { return this.localLstat(requested) }
    async readText(): Promise<string> { return '' }
    async streamText(_target?: FsTarget, _signal?: AbortSignal): Promise<AsyncIterable<string>> { return empty() }
    async readBytes(_target?: FsTarget, _signal?: AbortSignal, _maxBytes?: number): Promise<Uint8Array> { return new Uint8Array() }
    async readByteRange(_target?: FsTarget, _range?: { offset: number, length: number }, _signal?: AbortSignal): Promise<Uint8Array> { return new Uint8Array() }
    async listDir(_target?: FsTarget, _signal?: AbortSignal): Promise<Array<{ name: string, type: string }>> { return [] }
    async writeText(_target?: FsTarget, _content?: string): Promise<string> {
      this.writes += 1
      return 'original-write'
    }
    async editText(_target?: FsTarget, _edit?: unknown): Promise<string> {
      this.edits += 1
      return 'original-edit'
    }
    async watch(_target?: FsTarget, _changed?: (error?: Error) => void, _signal?: AbortSignal): Promise<() => Promise<void>> {
      this.watched += 1
      return async () => undefined
    }
  }
  const backend = new Backend()
  const access: RemoteAccess = {
    requireHost: () => host,
    async secret() { return {} },
    pool: {
      sftpRealpath: (_host, _secret, remotePath) => pool.realpath(remotePath),
      sftpAttrs: (_host, _secret, remotePath, follow) => pool.attrs(remotePath, follow),
      sftpReadLink: (_host, _secret, remotePath) => pool.readLink(remotePath),
      sftpProbeDir: async (_host, _secret, remotePath) => { await pool.readDir(remotePath) },
      sftpReadDir: (_host, _secret, remotePath) => pool.readDir(remotePath),
      sftpRead: (_host, _secret, remotePath, maxBytes) => pool.read(remotePath, maxBytes),
      sftpReadAt: (_host, _secret, remotePath, offset, length) => pool.readAt(remotePath, offset, length),
      sftpReadChunks: (_host, _secret, remotePath) => pool.chunks(remotePath),
    },
  }
  const ctx = {
    get(name: string) {
      if (name === 'fs') return backend
      throw new Error(name)
    },
    logger: { warn(message: string) { warnings.push(message) } },
  }
  const remove = installRemoteFs(ctx, access, options)
  assert.equal(typeof remove, 'function')
  return { backend, pool, remove: remove!, access, ctx, Backend }
}

function empty(): AsyncIterable<string> {
  return (async function* () {})()
}

function codeOf(error: unknown): string {
  assert.ok(error instanceof FsError)
  return error.code
}

test('a placeholder lists the remote directory and a local path stays local', async () => {
  const { backend, pool } = createHarness()
  let listed = ''
  pool.attrs = async (remotePath, follow) => {
    if (remotePath === `${REMOTE}/src` && follow) return { type: 'directory', size: 0, mtime: 4 }
    if (remotePath === `${REMOTE}/gone` && follow) return undefined
    if (remotePath === REMOTE) return { type: 'directory', size: 0, mtime: 1 }
    return { type: 'file', size: 4, mtime: 2 }
  }
  pool.readDir = async remotePath => {
    listed = remotePath
    return [
      { name: 'src', type: 'symlink', size: 1, mtime: 3 },
      { name: 'a.ts', type: 'file', size: 4, mtime: 2 },
      { name: 'note', type: 'symlink', size: 1, mtime: 6 },
      { name: 'gone', type: 'symlink', size: 1, mtime: 5 },
    ]
  }
  const target = await backend.resolve(placeholder())
  assert.equal(backend.delegated, false)
  assert.equal(String(target.targetKey), placeholder())
  assert.equal(backend.processPath(target), placeholder())
  const entries = await backend.listDir(target)
  assert.equal(listed, REMOTE)
  assert.deepEqual(entries.map(entry => [entry.name, entry.type]), [['a.ts', 'file'], ['gone', 'other'], ['note', 'other'], ['src', 'directory']])

  listed = ''
  await backend.resolve('/tmp/not-a-placeholder')
  assert.equal(backend.delegated, true)
  assert.equal(listed, '')
})

test('a placeholder subdirectory and a superseded root both list the remote directory', async () => {
  const old = mkdtempSync(path.join(tmpdir(), 'dsh-remote-fs-old-'))
  addSupersededRoot(old)
  try {
    const { backend, pool } = createHarness()
    const listed: string[] = []
    pool.readDir = async remotePath => {
      listed.push(remotePath)
      return []
    }
    const nested = await backend.resolve(placeholder('src'))
    await backend.listDir(nested)
    const stale = await backend.resolve(path.join(old, 'lo', encodeRemotePath(REMOTE)))
    await backend.listDir(stale)
    assert.deepEqual(listed, [`${REMOTE}/src`, REMOTE])
  } finally {
    clearSupersededRoots()
  }
})

test('readByteRange reads one window, an oversize file is FS_TOO_LARGE, and a NUL byte is FS_NOT_TEXT', async () => {
  const { backend, pool } = createHarness()
  pool.read = async () => {
    pool.reads += 1
    throw new Error('whole file')
  }
  const file = await backend.resolve(placeholder('a.ts'))
  const window = await backend.readByteRange(file, { offset: 3, length: 2 })
  assert.equal(Buffer.from(window).toString(), 'hi')
  assert.deepEqual(pool.readAts, [{ offset: 3, length: 2 }])
  assert.equal(pool.reads, 0)
  pool.attrs = async remotePath => remotePath.endsWith('/missing') ? undefined : { type: 'file', size: 4, mtime: 1, mode: 0o100644 }
  const empty = await backend.readByteRange(file, { offset: 0, length: 0 })
  assert.equal(empty.length, 0)
  assert.equal(pool.readAts.length, 1)
  const missing = await backend.resolve(placeholder('missing'))
  await assert.rejects(() => backend.readByteRange(missing, { offset: 0, length: 0 }), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_NOT_FOUND')
    return true
  })

  pool.read = async () => {
    throw new SshFailure('file is 99 bytes, over the 4 byte limit', 'sftp-read')
  }
  await assert.rejects(() => backend.readBytes(file, undefined, 4), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_TOO_LARGE')
    return true
  })

  pool.chunks = async function* () { yield Buffer.from([0x68, 0x00]) }
  const stream = await backend.streamText(file)
  await assert.rejects(async () => {
    for await (const chunk of stream) void chunk
  }, (error: unknown) => {
    assert.equal(codeOf(error), 'FS_NOT_TEXT')
    return true
  })
})

test('lstat of a mode-less symlink stays a symlink when readdir would follow it', async () => {
  const { backend, pool } = createHarness()
  const listed: string[] = []
  const linked: string[] = []
  pool.attrs = async () => ({ type: 'other', size: 10, mtime: 1 })
  pool.readLink = async remotePath => {
    linked.push(remotePath)
    if (remotePath.endsWith('/link')) return '/etc/passwd'
    throw new SshFailure('Failure', 'sftp-readlink')
  }
  pool.readDir = async remotePath => {
    listed.push(remotePath)
    return []
  }
  const link = await backend.lstat(placeholder('link'))
  assert.equal(link?.type, 'symlink')
  assert.equal(listed.length, 0)
  assert.deepEqual(linked, [`${REMOTE}/link`])

  pool.readDir = async remotePath => {
    listed.push(remotePath)
    throw new SshFailure('Not a directory', 'sftp-list')
  }
  assert.equal((await backend.lstat(placeholder('link')))?.type, 'symlink')
  assert.equal(listed.length, 0)

  const followed = await backend.stat(await backend.resolve(placeholder('link')))
  assert.equal(followed?.type, 'file')
  assert.deepEqual(listed, [`${REMOTE}/link`])
  // lstat is deliberately not served from the attribute cache; a second call
  // re-probes readlink so a swap between clicks cannot hide.
  assert.deepEqual(linked, [`${REMOTE}/link`, `${REMOTE}/link`])
})

test('a mode-less lstat stays other when readlink cannot prove it is not a symlink', async () => {
  const { backend, pool } = createHarness()
  let listed = 0
  pool.attrs = async () => ({ type: 'other', size: 10, mtime: 1 })
  pool.readLink = async () => { throw new SshFailure('Permission denied', 'sftp-readlink') }
  pool.readDir = async () => {
    listed += 1
    return []
  }
  assert.equal((await backend.lstat(placeholder('link')))?.type, 'other')
  assert.equal(listed, 0)
})

test('a directory listing does not make an unresolved child contained', async () => {
  const { backend, pool } = createHarness()
  pool.realpath = async remotePath => remotePath.endsWith('/link') ? '/etc' : remotePath
  pool.attrs = async () => ({ type: 'directory', size: 0, mtime: 1 })
  pool.readDir = async () => [
    { name: 'a.ts', type: 'file', size: 4, mtime: 2 },
    { name: 'src', type: 'directory', size: 0, mtime: 3 },
    { name: 'link', type: 'symlink', size: 1, mtime: 4 },
  ]
  const workspace = await backend.resolve(placeholder())
  const entries = (await backend.listDir(workspace)) as FsDirEntry[]
  const file = entries.find(entry => entry.name === 'a.ts')
  const src = entries.find(entry => entry.name === 'src')
  const link = entries.find(entry => entry.name === 'link')
  assert.ok(file !== undefined && src !== undefined && link !== undefined)
  assert.equal(backend.contains(workspace, file.target), false)
  assert.equal(backend.contains(workspace, link.target), false)
  assert.equal(backend.contains(workspace, await backend.resolve(placeholder('link'))), false)
  assert.equal(backend.contains(workspace, await backend.resolve(placeholder('a.ts'))), true)

  let nested = ''
  pool.readDir = async remotePath => {
    nested = remotePath
    return []
  }
  await backend.listDir(src.target)
  assert.equal(nested, `${REMOTE}/src`)
})

test('a symlink that realpaths outside the workspace is not contained', async () => {
  const { backend, pool } = createHarness()
  pool.realpath = async remotePath => remotePath.endsWith('/link') ? '/etc' : remotePath
  const workspace = await backend.resolve(placeholder())
  const link = await backend.resolve(placeholder('link'))
  assert.equal(backend.contains(workspace, link), false)
  const stray: FsTarget = { targetKey: FsTargetKey(placeholder('not-resolved')), displayPath: placeholder('not-resolved') }
  assert.equal(backend.contains(workspace, stray), false)
})

test('a missing remote file is absent and lstat does not follow a symlink', async () => {
  const { backend, pool } = createHarness()
  pool.realpath = async remotePath => {
    if (remotePath.endsWith('/missing')) throw new SshFailure('no such file', 'sftp-realpath')
    return remotePath
  }
  pool.attrs = async (remotePath, follow) => {
    if (remotePath.endsWith('/missing')) return undefined
    if (remotePath.endsWith('/link') && !follow) return { type: 'symlink', size: 4, mtime: 1 }
    return { type: 'directory', size: 0, mtime: 1 }
  }
  const missing = await backend.resolve(placeholder('missing'))
  assert.equal(await backend.stat(missing), undefined)
  assert.equal(await backend.lstat(placeholder('missing')), undefined)
  const link = await backend.lstat(placeholder('link'))
  assert.equal(link?.type, 'symlink')
})

test('remote watch is unsupported, uninstall restores the backend, and a second install warns', async () => {
  const warnings: string[] = []
  const { backend, remove, access, ctx, Backend } = createHarness(warnings)
  const workspace = await backend.resolve(placeholder())
  await assert.rejects(backend.watch(workspace, () => undefined, new AbortController().signal), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_IO_ERROR')
    return true
  })
  assert.equal(backend.watched, 0)
  await backend.watch({ targetKey: FsTargetKey('/tmp/local'), displayPath: '/tmp/local' }, () => undefined, new AbortController().signal)
  assert.equal(backend.watched, 1)
  assert.equal(Object.hasOwn(backend, 'sandboxMode'), false)
  assert.equal(backend.sandboxMode, 'workspace-write')
  assert.equal(Object.hasOwn(backend, 'writeText'), true)
  assert.equal(Object.hasOwn(backend, 'processPath'), false)

  const again = installRemoteFs(ctx, access)
  assert.equal(again, undefined)
  assert.match(warnings.join('\n'), /already installed/)

  remove()
  assert.equal(Object.hasOwn(backend, 'resolve'), false)
  assert.equal(backend.resolve, Backend.prototype.resolve)
  assert.equal(backend.watch, Backend.prototype.watch)
  assert.equal(backend.writeText, Backend.prototype.writeText)
  assert.equal(backend.editText, Backend.prototype.editText)
  assert.equal(Object.hasOwn(backend, 'sandboxMode'), false)
})

test('a remote write is refused and a local write reaches the backend', async () => {
  const { backend } = createHarness()
  const remote = await backend.resolve(placeholder('a.ts'))
  const local: FsTarget = { targetKey: FsTargetKey('/tmp/local'), displayPath: '/tmp/local' }
  await assert.rejects(backend.writeText(remote, 'x'), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_SANDBOX_DENIED')
    return true
  })
  await assert.rejects(backend.editText(remote, { old: 'a', new: 'b' }), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_SANDBOX_DENIED')
    return true
  })
  assert.equal(backend.writes, 0)
  assert.equal(backend.edits, 0)
  assert.equal(await backend.writeText(local, 'x'), 'original-write')
  assert.equal(await backend.editText(local, { old: 'a', new: 'b' }), 'original-edit')
  assert.equal(backend.writes, 1)
  assert.equal(backend.edits, 1)
})

test('a listing without permissions uses a directory probe, and a file probe stays a file', async () => {
  const { backend, pool } = createHarness()
  pool.attrs = async () => ({ type: 'other', size: 4, mtime: 1 })
  pool.readDir = async remotePath => {
    if (remotePath.endsWith('/a.ts')) throw new SshFailure('Not a directory', 'sftp-list')
    if (remotePath.endsWith('/locked')) throw new SshFailure('Permission denied', 'sftp-list')
    return [{ name: 'a.ts', type: 'file', size: 4, mtime: 1 }]
  }
  const root = await backend.lstat(placeholder())
  assert.equal(root?.type, 'directory')
  const file = await backend.stat(await backend.resolve(placeholder('a.ts')))
  assert.equal(file?.type, 'file')
  const locked = await backend.lstat(placeholder('locked'))
  assert.equal(locked?.type, 'other')
})

test('a repeated resolve and stat reuse the remote probe until the ttl', async () => {
  let now = 1_000
  const { backend, pool } = createHarness([], { now: () => now, attrTtlMs: 1_000 })
  const real: string[] = []
  let attrs = 0
  pool.realpath = async remotePath => {
    real.push(remotePath)
    if (remotePath.endsWith('/AGENTS.md') || remotePath.endsWith('/CLAUDE.md')) throw new SshFailure('no such file', 'sftp-realpath')
    return remotePath
  }
  pool.attrs = async () => {
    attrs += 1
    return { type: 'file', size: 1, mtime: 1, mode: 0o100644 }
  }
  const agents = await backend.resolve(placeholder('AGENTS.md'))
  await backend.stat(agents)
  await backend.resolve(placeholder('AGENTS.md'))
  await backend.stat(agents)
  assert.equal(attrs, 1)
  assert.equal(real.filter(remotePath => remotePath === REMOTE).length, 1)

  await backend.resolve(placeholder('CLAUDE.md'))
  assert.equal(real.filter(remotePath => remotePath === REMOTE).length, 1)
  assert.equal(real.filter(remotePath => remotePath.endsWith('/CLAUDE.md')).length, 1)

  now = 2_001
  await backend.stat(agents)
  assert.equal(attrs, 2)
})

test('a disconnected host does not fail ensure or a missing marker, and a read still fails', async () => {
  const { backend, pool } = createHarness()
  const down = new SshFailure('connect ECONNREFUSED', 'sftp-stat')
  pool.realpath = async () => { throw down }
  pool.attrs = async () => { throw down }
  pool.read = async () => { throw down }
  backend.localStat = async target => String(target?.targetKey) === placeholder()
    ? { type: 'directory', version: 'local', size: 0 }
    : undefined
  const root = await backend.stat(await backend.resolve(placeholder()))
  assert.equal(root?.type, 'directory')
  assert.equal(await backend.lstat(placeholder('.git')), undefined)
  await assert.rejects(async () => backend.readBytes(await backend.resolve(placeholder('a.ts')), undefined, 8), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_IO_ERROR')
    return true
  })
  await assert.rejects(async () => backend.listDir(await backend.resolve(placeholder())), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_IO_ERROR')
    return true
  })
})

test('a later connection answers a path that failed while the host was down', async () => {
  const { backend, pool } = createHarness()
  let down = true
  let attrs = 0
  pool.attrs = async () => {
    attrs += 1
    if (down) throw new SshFailure('connect ECONNREFUSED', 'sftp-stat')
    return { type: 'file', size: 4, mtime: 2, mode: 0o100644 }
  }
  const file = await backend.resolve(placeholder('a.ts'))
  assert.equal(await backend.stat(file), undefined)
  down = false
  assert.equal((await backend.stat(file))?.type, 'file')
  assert.equal(attrs, 2)
})

test('forgetting a host drops its realpath and the cached stat', async () => {
  const { backend, pool, remove } = createHarness()
  let real = '/old/tree'
  const seen: string[] = []
  pool.realpath = async () => real
  pool.attrs = async remotePath => {
    seen.push(remotePath)
    return { type: 'file', size: 1, mtime: 1, mode: 0o100644 }
  }
  const file = await backend.resolve(placeholder('a.ts'))
  await backend.stat(file)
  assert.equal(seen[0], '/old/tree')
  remove.invalidateHost('lo')
  real = `${REMOTE}/a.ts`
  await backend.stat(file)
  assert.equal(seen.at(-1), `${REMOTE}/a.ts`)
  assert.equal(seen.length, 2)
})

test('a programming error is not reported as a missing file', async () => {
  const { backend, pool } = createHarness()
  pool.realpath = async () => { throw new TypeError('bad path') }
  await assert.rejects(() => backend.resolve(placeholder('a.ts')), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_IO_ERROR')
    return true
  })
  pool.realpath = async remotePath => remotePath
  pool.attrs = async () => { throw new TypeError('bad attrs') }
  const file = await backend.resolve(placeholder('a.ts'))
  await assert.rejects(() => backend.stat(file), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_IO_ERROR')
    return true
  })
})

test('permission denied is not reused as an absent file', async () => {
  const { backend, pool } = createHarness()
  let attrs = 0
  pool.attrs = async () => {
    attrs += 1
    throw new SshFailure('Permission denied', 'sftp-stat')
  }
  const file = await backend.resolve(placeholder('a.ts'))
  await assert.rejects(() => backend.stat(file), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_PERMISSION_DENIED')
    return true
  })
  await assert.rejects(() => backend.stat(file), (error: unknown) => {
    assert.equal(codeOf(error), 'FS_PERMISSION_DENIED')
    return true
  })
  assert.equal(attrs, 2)
})

test('a disconnected host keeps the last remote stat after the ttl', async () => {
  let now = 1_000
  const { backend, pool } = createHarness([], { now: () => now, attrTtlMs: 1_000 })
  let down = false
  let attrs = 0
  pool.attrs = async () => {
    attrs += 1
    if (down) throw new SshFailure('No response from server', 'sftp-stat')
    return { type: 'directory', size: 0, mtime: 3, mode: 0o040755 }
  }
  const root = await backend.resolve(placeholder())
  assert.equal((await backend.stat(root))?.type, 'directory')
  down = true
  now = 3_000
  assert.equal((await backend.stat(root))?.type, 'directory')
  assert.equal(attrs, 2)
})

test('a missing filesystem does not install the file tree', () => {
  const warnings: string[] = []
  const remove = installRemoteFs({
    get() { throw new Error('fs is down') },
    logger: { warn(message) { warnings.push(message) } },
  }, {
    requireHost: () => host,
    async secret() { return {} },
    pool: {
      async sftpRealpath() { return '/' },
      async sftpAttrs() { return undefined },
      async sftpReadLink() { throw new SshFailure('Failure', 'sftp-readlink') },
      async sftpProbeDir() { return undefined },
      async sftpReadDir() { return [] },
      async sftpRead() { return Buffer.alloc(0) },
      async sftpReadAt() { return Buffer.alloc(0) },
      async *sftpReadChunks() { /* empty */ },
    },
  })
  assert.equal(remove, undefined)
  assert.match(warnings[0] ?? '', /unavailable/)
})

test('listingType uses a permission-shaped longname only when STAT omitted the mode', () => {
  const bare = { mode: undefined, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => false }
  assert.equal(listingType(bare, '-rw-r--r-- 1 me me 3 Jan 1 notes.txt'), 'file')
  assert.equal(listingType(bare, 'drwxr-xr-x 2 me me 40 Jan 1 src'), 'directory')
  assert.equal(listingType(bare, 'lrwxrwxrwx 1 me me 4 Jan 1 link -> /etc'), 'symlink')
  assert.equal(listingType(bare, 'notes.txt'), 'other')
  assert.equal(listingType({ mode: 0o100644, isDirectory: () => false, isFile: () => true }, 'drwxr-xr-x ignored'), 'file')
})

test('readOpenRange reads one window and readOpenChunks closes when the consumer stops', async () => {
  let opened = 0
  let closed = 0
  const sftp = {
    open(_remotePath: string, _flags: string, callback: (error: Error | undefined, handle: Buffer) => void) {
      opened += 1
      callback(undefined, Buffer.from('handle'))
    },
    read(_handle: Buffer, buffer: Buffer, _offset: number, length: number, position: number, callback: (error: Error | undefined, bytesRead: number) => void) {
      const data = Buffer.from('abcdef')
      const slice = data.subarray(position, Math.min(data.length, position + length))
      slice.copy(buffer)
      callback(undefined, slice.length)
    },
    close(_handle: Buffer, callback: (error: Error | undefined) => void) {
      closed += 1
      callback(undefined)
    },
  }
  const window = await readOpenRange(sftp as never, '/a', 1, 2)
  assert.equal(window.toString(), 'bc')
  assert.equal(opened, 1)
  assert.equal(closed, 1)

  let calls = 0
  const short = {
    ...sftp,
    read(_handle: Buffer, buffer: Buffer, _offset: number, length: number, position: number, callback: (error: Error | undefined, bytesRead: number) => void) {
      calls += 1
      const data = Buffer.from('abcdef')
      const take = Math.min(1, length, Math.max(0, data.length - position))
      if (take > 0) data.copy(buffer, 0, position, position + take)
      callback(undefined, take)
    },
  }
  const filled = await readOpenRange(short as never, '/a', 0, 4)
  assert.equal(filled.toString(), 'abcd')
  assert.equal(calls, 4)
  const empty = await readOpenRange(sftp as never, '/a', 0, 0)
  assert.equal(empty.length, 0)
  assert.equal(opened, 2)

  let names = 0
  let closedProbe = 0
  await probeOpenDir({
    opendir(_remotePath: string, callback: (error: Error | undefined, handle?: Buffer) => void) {
      callback(undefined, Buffer.from('dir'))
    },
    readdir() { names += 1 },
    close(_handle: Buffer, callback: (error: Error | undefined) => void) {
      closedProbe += 1
      callback(undefined)
    },
  } as never, '/big')
  assert.equal(names, 0)
  assert.equal(closedProbe, 1)

  const chunks = readOpenChunks(sftp as never, '/a')
  const first = await chunks.next()
  assert.equal(Buffer.from(first.value ?? []).toString(), 'abcdef')
  await chunks.return(undefined)
  assert.equal(closed, 3)
})

test('a server that cannot realpath fails closed instead of degrading containment', async () => {
  const { backend, pool } = createHarness()
  pool.realpath = async () => { throw new SshFailure('Operation unsupported', 'sftp-realpath', 8) }
  await assert.rejects(
    () => backend.resolve(placeholder('a.ts')),
    (error: unknown) => error instanceof FsError && error.code === 'FS_IO_ERROR',
  )
  const workspace: FsTarget = { targetKey: FsTargetKey(placeholder()), displayPath: placeholder() }
  const stray: FsTarget = { targetKey: FsTargetKey(placeholder('a.ts')), displayPath: placeholder('a.ts') }
  assert.equal(backend.contains(workspace, stray), false)
})

test('a swapped symlink stops being contained after the realpath cache expires', async () => {
  let clock = 0
  let swapped = false
  const { backend, pool } = createHarness([], { now: () => clock, metaTtlMs: 3000 })
  pool.realpath = async remotePath => (swapped && remotePath.endsWith('/link') ? '/etc' : remotePath)
  const workspace = await backend.resolve(placeholder())
  const before = await backend.resolve(placeholder('link'))
  assert.equal(backend.contains(workspace, before), true)
  // Within the window the cached (old) realpath is still used.
  swapped = true
  clock = 1000
  assert.equal(backend.contains(workspace, await backend.resolve(placeholder('link'))), true)
  // Once it expires, the current target is probed and containment fails closed.
  clock = 4000
  const after = await backend.resolve(placeholder('link'))
  assert.equal(backend.contains(workspace, after), false)
})

test('a symlink observed in a listing drops the child identity so the next resolve re-probes', async () => {
  const { backend, pool } = createHarness()
  pool.realpath = async remotePath => (remotePath.endsWith('/link') ? `${REMOTE}/link` : remotePath)
  pool.attrs = async () => ({ type: 'directory', size: 0, mtime: 1 })
  const workspace = await backend.resolve(placeholder())
  const link = await backend.resolve(placeholder('link'))
  assert.equal(backend.contains(workspace, link), true)

  pool.realpath = async remotePath => (remotePath.endsWith('/link') ? '/etc' : remotePath)
  pool.readDir = async () => [{ name: 'link', type: 'symlink', size: 1, mtime: 2 }]
  await backend.listDir(workspace)
  assert.equal(backend.contains(workspace, await backend.resolve(placeholder('link'))), false)
})

test('a directory that becomes a symlink is rejected before listDir follows it', async () => {
  const { backend, pool } = createHarness()
  pool.realpath = async remotePath => (remotePath.endsWith('/link') ? '/etc' : remotePath)
  pool.attrs = async (remotePath, follow) =>
    remotePath.endsWith('/link') && !follow
      ? { type: 'symlink', size: 1, mtime: 1 }
      : { type: 'directory', size: 0, mtime: 1 }
  const workspace = await backend.resolve(placeholder())
  const link = await backend.resolve(placeholder('link'))
  await assert.rejects(
    () => backend.listDir(link),
    (error: unknown) => error instanceof FsError && error.code === 'FS_PERMISSION_DENIED',
  )
  assert.equal(backend.contains(workspace, link), false)
})
