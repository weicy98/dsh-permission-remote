import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { HostConfig } from '../src/config.ts'
import { encodeRemotePath, resolveRemotePath, setRemoteRootOverride } from '../src/router.ts'
import { SshFailure } from '../src/ssh-pool.ts'
import { installRemoteUploads, remoteUploadPath, type UploadAccess } from '../src/uploads.ts'

const root = mkdtempSync(path.join(tmpdir(), 'dsh-remote-uploads-'))
process.env.DSH_SSH_REMOTE_ROOT = root
setRemoteRootOverride(null)

const REMOTE = '/home/me/project'
const placeholder = path.join(root, 'lo', encodeRemotePath(REMOTE))
const ID = 'abcdef0123456789ffff'
const HOST_PATH = '/tmp/notes.txt'
const UPLOADED = '/home/me/.dsh-permission-remote/uploads/abcdef0123456789/notes.txt'
const CAP = 32 * 1024 * 1024

interface StreamOptions {
  sessionId?: string
  messages?: unknown
  signal?: AbortSignal
}

type StreamListener = (options: StreamOptions, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>

function fileMessage(bytes = 4, name = 'notes.txt', id = ID, copies = 1) {
  return [{
    role: 'user',
    content: Array.from({ length: copies }, () => ({ type: 'file', attachment: { attachmentId: id, name, bytes } })),
  }]
}

function setup() {
  const puts: Array<{ local: string, remote: string }> = []
  let sawNextDuringPut = false
  let nextCalled = false
  let stat = async (): Promise<{ isDirectory: boolean, size: number }> => {
    throw new SshFailure('no such file', 'sftp-stat')
  }
  let attrs: () => Promise<{ type: 'file' | 'directory' | 'symlink' | 'other', size: number } | undefined> = async () => undefined
  let failPut = false
  let home = '/home/me'
  let putHook: () => void | Promise<void> = () => undefined
  const fs = {
    processPathFromHostPath(hostPath: string): string | undefined { return hostPath },
  }
  let initiator: { session: { header: { cwd: string } } } | undefined
  const session = { header: { cwd: placeholder } }
  let listener: StreamListener | undefined
  const ctx = {
    get(name: string) {
      if (name === 'fs') return fs
      if (name === 'sessions') return { get(id: string) { return id === 's1' ? session : undefined } }
      if (name === 'workingDirectory') return { get(value: { header?: { cwd?: string } }) { return value.header?.cwd ?? '' } }
      if (name === 'agents') return { currentInitiator() { return initiator } }
      if (name === 'attachments') return { fileHostPath() { return HOST_PATH } }
      throw new Error(name)
    },
    on(_event: 'llm/stream', fn: StreamListener) {
      listener = fn
      return () => { listener = undefined }
    },
    logger: { warn(_message: string) { /* expected on failed copies */ } },
  }
  const access: UploadAccess = {
    requireHost: () => ({ id: 'lo' } as HostConfig),
    async secret() { return {} },
    pool: {
      async sftpRealpath(_host, _secret, remotePath) { return remotePath === '.' ? home : remotePath },
      sftpStat: () => stat(),
      sftpAttrs: () => attrs(),
      async sftpPutFile(_host, _secret, local, remote) {
        sawNextDuringPut = nextCalled
        await putHook()
        if (failPut) throw new Error('disk full')
        puts.push({ local, remote })
      },
    },
  }
  const remove = installRemoteUploads(ctx, access)
  assert.equal(typeof remove, 'function')
  assert.ok(listener)
  assert.ok(remove)
  return {
    fs,
    remove,
    puts,
    listener: listener!,
    session,
    get sawNextDuringPut() { return sawNextDuringPut },
    get nextCalled() { return nextCalled },
    set nextCalled(value: boolean) { nextCalled = value },
    setStat(next: typeof stat) { stat = next },
    setAttrs(next: typeof attrs) { attrs = next },
    setFailPut(value: boolean) { failPut = value },
    setHome(value: string) { home = value },
    setPut(hook: () => void | Promise<void>) { putHook = hook },
    setInitiator(cwd: string | undefined) {
      initiator = cwd === undefined ? undefined : { session: { header: { cwd } } }
    },
  }
}

async function pull(listener: StreamListener, options: StreamOptions): Promise<void> {
  let nextCalled = false
  const stream = listener(options, () => {
    nextCalled = true
    return (async function* () { yield 'chunk' })()
  })
  const harnessNext = nextCalled
  if (options.sessionId === 's1' && options.signal?.aborted !== true) assert.equal(harnessNext, false)
  const first = await stream[Symbol.asyncIterator]().next()
  assert.equal(first.value, 'chunk')
}

test('remoteUploadPath keeps the leaf inside the upload directory', () => {
  assert.equal(remoteUploadPath('/home/me', ID, '../x'), '/home/me/.dsh-permission-remote/uploads/abcdef0123456789/x')
  assert.equal(remoteUploadPath('/home/me', ID, '..'), '/home/me/.dsh-permission-remote/uploads/abcdef0123456789/file')
  assert.equal(remoteUploadPath('/home/me', `sha256:${ID}`, 'notes.txt'), UPLOADED)
  assert.throws(() => remoteUploadPath('/home/me', 'sha256:abcdef', 'x'), /safe digest/)
})

test('forgetting a host drops its cached home and the published upload path', async () => {
  const harness = setup()
  await pull(harness.listener, { sessionId: 's1', messages: fileMessage() })
  harness.setInitiator(placeholder)
  assert.equal(harness.fs.processPathFromHostPath(HOST_PATH), UPLOADED)
  harness.remove.invalidateHost('lo')
  assert.equal(harness.fs.processPathFromHostPath(HOST_PATH), HOST_PATH)
  harness.setHome('/home/other')
  harness.setInitiator(undefined)
  await pull(harness.listener, { sessionId: 's1', messages: fileMessage() })
  harness.setInitiator(placeholder)
  assert.equal(harness.fs.processPathFromHostPath(HOST_PATH), '/home/other/.dsh-permission-remote/uploads/abcdef0123456789/notes.txt')
  assert.equal(harness.puts.at(-1)?.remote, '/home/other/.dsh-permission-remote/uploads/abcdef0123456789/notes.txt')
})

test('a remote turn copies the file before the model stream starts', async () => {
  const harness = setup()
  const stream = harness.listener({ sessionId: 's1', messages: fileMessage() }, () => {
    harness.nextCalled = true
    return (async function* () { yield 'chunk' })()
  })
  assert.equal(harness.nextCalled, false)
  assert.equal(harness.puts.length, 0)
  const first = await stream[Symbol.asyncIterator]().next()
  assert.equal(first.value, 'chunk')
  assert.equal(harness.nextCalled, true)
  assert.equal(harness.sawNextDuringPut, false)
  assert.deepEqual(harness.puts, [{ local: HOST_PATH, remote: UPLOADED }])
})

test('a local session starts the model stream without uploading', () => {
  const harness = setup()
  harness.session.header.cwd = '/tmp/local-work'
  let nextCalled = false
  const stream = harness.listener({ sessionId: 's1', messages: fileMessage() }, () => {
    nextCalled = true
    return (async function* () { yield 'chunk' })()
  })
  assert.equal(nextCalled, true)
  assert.equal(harness.puts.length, 0)
  assert.equal(typeof stream[Symbol.asyncIterator], 'function')
})

test('the same remote size is not copied again and the model sees the remote path', async () => {
  const harness = setup()
  harness.setStat(async () => ({ isDirectory: false, size: 4 }))
  await pull(harness.listener, { sessionId: 's1', messages: fileMessage() })
  assert.equal(harness.puts.length, 0)
  harness.setInitiator(placeholder)
  const seen = harness.fs.processPathFromHostPath(HOST_PATH)
  assert.equal(seen, UPLOADED)
  assert.equal(resolveRemotePath(seen ?? '', REMOTE, placeholder), seen)
  harness.setInitiator(undefined)
  assert.equal(harness.fs.processPathFromHostPath(HOST_PATH), HOST_PATH)
})

test('a failed copy and an oversize file leave no readable path, and the turn continues', async () => {
  const failed = setup()
  failed.setFailPut(true)
  await pull(failed.listener, { sessionId: 's1', messages: fileMessage() })
  failed.setInitiator(placeholder)
  assert.equal(failed.fs.processPathFromHostPath(HOST_PATH), undefined)

  const oversize = setup()
  await pull(oversize.listener, { sessionId: 's1', messages: fileMessage(CAP + 1) })
  assert.equal(oversize.puts.length, 0)
  oversize.setInitiator(placeholder)
  assert.equal(oversize.fs.processPathFromHostPath(HOST_PATH), undefined)
})

test('a directory already at the upload path is not replaced', async () => {
  const harness = setup()
  harness.setStat(async () => ({ isDirectory: true, size: 4 }))
  await pull(harness.listener, { sessionId: 's1', messages: fileMessage() })
  assert.equal(harness.puts.length, 0)
  harness.setInitiator(placeholder)
  assert.equal(harness.fs.processPathFromHostPath(HOST_PATH), undefined)
})

test('two blocks of one upload share a single copy', async () => {
  const harness = setup()
  await pull(harness.listener, { sessionId: 's1', messages: fileMessage(4, 'notes.txt', ID, 2) })
  assert.equal(harness.puts.length, 1)
})

test('aborting during the copy rejects the turn and leaves no unhandled rejection', async () => {
  const harness = setup()
  const controller = new AbortController()
  harness.setPut(() => {
    controller.abort()
    const error = new Error('remote upload aborted')
    error.name = 'AbortError'
    throw error
  })
  const unhandled: unknown[] = []
  const onUnhandled = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  try {
    let nextCalled = false
    const stream = harness.listener({ sessionId: 's1', messages: fileMessage(), signal: controller.signal }, () => {
      nextCalled = true
      return (async function* () { yield 'chunk' })()
    })
    await assert.rejects(() => stream[Symbol.asyncIterator]().next(), (error: unknown) => {
      assert.equal((error as Error).name, 'AbortError')
      return true
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
    assert.equal(nextCalled, false)
    assert.equal(harness.puts.length, 0)
    harness.setInitiator(placeholder)
    assert.equal(harness.fs.processPathFromHostPath(HOST_PATH), HOST_PATH)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('an aborted remote turn does not start the model stream or keep a failure', async () => {
  const harness = setup()
  let nextCalled = false
  const stream = harness.listener({ sessionId: 's1', messages: fileMessage(), signal: AbortSignal.abort() }, () => {
    nextCalled = true
    return (async function* () { yield 'chunk' })()
  })
  await assert.rejects(() => stream[Symbol.asyncIterator]().next(), (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError')
    return true
  })
  assert.equal(nextCalled, false)
  assert.equal(harness.puts.length, 0)
  harness.setInitiator(placeholder)
  assert.equal(harness.fs.processPathFromHostPath(HOST_PATH), HOST_PATH)
})

test('an existing symbolic link at the upload path is refused, not followed and truncated', async () => {
  const harness = setup()
  harness.setAttrs(async () => ({ type: 'symlink', size: 4 }))
  await pull(harness.listener, { sessionId: 's1', messages: fileMessage() })
  assert.equal(harness.puts.length, 0)
  harness.setInitiator(placeholder)
  assert.notEqual(harness.fs.processPathFromHostPath(HOST_PATH), UPLOADED)
})
