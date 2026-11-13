import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { HostConfig } from '../src/config.ts'
import type { ApprovalDetail, RunnerStatus, ToolHost } from '../src/execute.ts'
import {
  forgetOpsHost,
  NO_TRANSFER_LIMITS,
  renderOpsCopy,
  renderOpsDownload,
  renderOpsUpload,
  openExclusiveTemp,
  runSshCopy,
  runSshDownload,
  runSshUpload,
  runSshWrite,
  type OpsTransferLimits,
} from '../src/ops.ts'
import { mapRemoteToLocal, setRemoteRootOverride } from '../src/router.ts'
import { SFTP_STATUS, SshFailure, type ExecResult, type SshPool } from '../src/ssh-pool.ts'

/** `SSH_FX_PERMISSION_DENIED`; the numeric status wins over the message. */
const SFTP_PERMISSION_DENIED: number = SFTP_STATUS.PERMISSION_DENIED

function host(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id: 'prod1',
    name: 'prod',
    host: '10.0.0.1',
    port: 22,
    username: 'ops',
    auth: 'key',
    privateKeyPath: '',
    fingerprint: 'SHA256:trusted',
    opsPolicy: 'ask',
    ...overrides,
  }
}

const status: RunnerStatus = {
  os: 'linux',
  sandbox: { available: true, reason: 'ok' },
  sandboxTool: 'bwrap',
  ripgrep: 'system',
  ripgrepPath: '/usr/bin/rg',
  roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
  home: '/home/dev',
  install: null,
}

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  }
}

type Attrs = { type: 'file' | 'directory' | 'symlink' | 'other', size: number, mode?: number }

const markedHome = '__DSH_OPS_HOME_BEGIN__\n/home/ops\n__DSH_OPS_HOME_END__\n'

interface TransferApi {
  api: ToolHost
  /** Commands, excluding the harmless home probe. */
  commands: string[]
  bodies: Array<string | Buffer | undefined>
  execs: Array<{ command: string, timeoutMs: number | undefined, signal: AbortSignal | undefined }>
  reads: string[]
  attrs: Array<{ path: string, follow: boolean }>
  writes: Array<{ path: string, bytes: number }>
  modes: Array<[string | undefined, string | undefined, ApprovalDetail | undefined]>
  /** Hosts whose whole connection was dropped. A shared connection must not be. */
  invalidated: string[]
  /** Hosts whose SFTP channel alone was closed, which is what a stuck transfer needs. */
  sftpClosed: string[]
}

/** A pool double for the two transfers. Everything else is a hard failure. */
function api(options: {
  mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  exec?: (command: string, stdin?: string | Buffer) => ExecResult
  remoteBytes?: Buffer
  attrs?: (path: string, follow: boolean) => Attrs | undefined
  /** Replaces the local-to-remote copy. A rejection must still delete the temp. */
  send?: (limits?: { maxBytes?: number, signal?: AbortSignal }) => Promise<number>
  /** Replaces the remote-to-local chunk source. */
  chunks?: () => AsyncIterable<Buffer>
  /** Replaces the SFTP-to-SFTP chunk sink used by ssh_copy. */
  sendChunks?: (target: string, remotePath: string, source: AsyncIterable<Buffer>, limits: { maxBytes?: number, signal?: AbortSignal } | undefined) => Promise<number>
  /** A second configured host, so a copy has somewhere to go. */
  hosts?: HostConfig[]
  /** Mirrors the pool's configured connection limit. */
  maxConnections?: number
  /** Host ids whose SSH connection is already cached in the pool. */
  connectedHostIds?: string[]
  /** Free connection slots the pool reports for ssh_copy admission control. */
  freeSlots?: number
  /** When false, the lease reports that the server never confirmed its channel close. */
  leaseSettled?: boolean
} = {}): TransferApi {
  // The home probe is cached per host id across tests; every fixture starts
  // from an unknown `$HOME`, so a hang override is actually exercised.
  forgetOpsHost('prod1')
  const commands: string[] = []
  const bodies: Array<string | Buffer | undefined> = []
  const execs: Array<{ command: string, timeoutMs: number | undefined, signal: AbortSignal | undefined }> = []
  const reads: string[] = []
  const attrs: Array<{ path: string, follow: boolean }> = []
  const writes: Array<{ path: string, bytes: number }> = []
  const modes: Array<[string | undefined, string | undefined, ApprovalDetail | undefined]> = []
  const invalidated: string[] = []
  const sftpClosed: string[] = []

  const pool = {
    exec: async (
      _host: HostConfig,
      _secret: unknown,
      command: string,
      timeoutMs?: number,
      signal?: AbortSignal,
      stdin?: string | Buffer,
    ) => {
      // The override must be able to hang the home probe, so it comes before
      // the marked-home default.
      if (command.includes('"$HOME"')) return options.exec?.(command, stdin) ?? result({ stdout: markedHome })
      commands.push(command)
      bodies.push(stdin)
      execs.push({ command, timeoutMs, signal })
      return options.exec?.(command, stdin) ?? result()
    },
    sftpRead: async (_host: HostConfig, _secret: unknown, remotePath: string, maxBytes?: number) => {
      reads.push(remotePath)
      const body = options.remoteBytes ?? Buffer.from('remote bytes')
      if (maxBytes !== undefined && body.length > maxBytes) {
        throw new Error(`file is over the ${maxBytes} byte limit`)
      }
      return body
    },
    sftpAttrs: async (_host: HostConfig, _secret: unknown, remotePath: string, follow: boolean) => {
      attrs.push({ path: remotePath, follow })
      if (options.attrs !== undefined) return options.attrs(remotePath, follow)
      // Absent by default: an upload creates, and a download test says otherwise.
      return undefined
    },
    sftpRealpath: async (_host: HostConfig, _secret: unknown, remotePath: string) => remotePath,
    sftpWrite: async (_host: HostConfig, _secret: unknown, remotePath: string, data: Buffer | string) => {
      writes.push({ path: remotePath, bytes: typeof data === 'string' ? Buffer.byteLength(data) : data.length })
    },
    sftpSendLocal: async (_host: HostConfig, _secret: unknown, localPath: string, remotePath: string, limits?: { maxBytes?: number, signal?: AbortSignal }) => {
      if (options.send !== undefined) return options.send(limits)
      const data = await readFile(localPath)
      const maxBytes = limits?.maxBytes ?? 0
      if (maxBytes > 0 && data.length > maxBytes) {
        throw new Error(`local file is ${data.length} bytes, over the ${maxBytes} byte transfer ceiling`)
      }
      writes.push({ path: remotePath, bytes: data.length })
      bodies.push(data)
      return data.length
    },
    sftpReadChunks: async function* (_host: HostConfig, _secret: unknown, remotePath: string) {
      reads.push(remotePath)
      if (options.chunks !== undefined) {
        yield* options.chunks()
        return
      }
      const body = options.remoteBytes ?? Buffer.from('remote bytes')
      const window = 3
      for (let offset = 0; offset < body.length; offset += window) yield body.subarray(offset, offset + window)
    },
    maxConnections: options.maxConnections,
    hasSession: (id: string) => (options.connectedHostIds ?? []).includes(id),
    freeSlots: () => options.freeSlots ?? 32,
    invalidate: (hostId: string) => { invalidated.push(hostId) },
    openSftpLease: async (h: HostConfig) => {
      let closed = false
      return {
        api: {} as never,
        hostId: h.id,
        close: async () => { if (!closed) { closed = true; sftpClosed.push(h.id) } },
        settled: () => options.leaseSettled !== false,
      }
    },
    sftpSendLocalOn: async (lease: { hostId: string }, localPath: string, remotePath: string, limits?: { maxBytes?: number, signal?: AbortSignal }) => {
      if (options.send !== undefined) return options.send(limits)
      const data = await readFile(localPath)
      const maxBytes = limits?.maxBytes ?? 0
      if (maxBytes > 0 && data.length > maxBytes) {
        throw new Error(`local file is ${data.length} bytes, over the ${maxBytes} byte transfer ceiling`)
      }
      writes.push({ path: remotePath, bytes: data.length })
      bodies.push(data)
      return data.length
    },
    sftpReadChunksOn: async function* (_lease: unknown, remotePath: string) {
      reads.push(remotePath)
      if (options.chunks !== undefined) {
        yield* options.chunks()
        return
      }
      const body = options.remoteBytes ?? Buffer.from('remote bytes')
      const window = 3
      for (let offset = 0; offset < body.length; offset += window) yield body.subarray(offset, offset + window)
    },
    sftpSendChunksOn: async (
      lease: { hostId: string },
      remotePath: string,
      source: AsyncIterable<Buffer>,
      limits?: { maxBytes?: number, signal?: AbortSignal },
    ) => {
      if (options.sendChunks !== undefined) return options.sendChunks(lease.hostId, remotePath, source, limits)
      const parts: Buffer[] = []
      for await (const chunk of source) parts.push(chunk)
      const data = Buffer.concat(parts)
      const maxBytes = limits?.maxBytes ?? 0
      if (maxBytes > 0 && data.length > maxBytes) {
        throw new SshFailure(`source file is over the ${maxBytes} byte transfer ceiling`, 'sftp-write', undefined, true)
      }
      writes.push({ path: `${lease.hostId}:${remotePath}`, bytes: data.length })
      bodies.push(data)
      return data.length
    },
    sftpSendChunks: async (
      target: HostConfig,
      _secret: unknown,
      remotePath: string,
      source: AsyncIterable<Buffer>,
      limits?: { maxBytes?: number, signal?: AbortSignal },
    ) => {
      if (options.sendChunks !== undefined) return options.sendChunks(target.id, remotePath, source, limits)
      const parts: Buffer[] = []
      for await (const chunk of source) parts.push(chunk)
      const data = Buffer.concat(parts)
      const maxBytes = limits?.maxBytes ?? 0
      if (maxBytes > 0 && data.length > maxBytes) {
        throw new SshFailure(`source file is over the ${maxBytes} byte transfer ceiling`, 'sftp-write', undefined, true)
      }
      writes.push({ path: `${target.id}:${remotePath}`, bytes: data.length })
      bodies.push(data)
      return data.length
    },
  } as unknown as SshPool

  return {
    api: {
      pool,
      hostOf: id => (options.hosts ?? [host()]).find(item => item.id === id),
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async (_exec, requested, justification, _tool, _subject, detail) => {
        modes.push([requested, justification, detail])
        if (requested === 'danger-full-access' && justification !== undefined) return 'danger-full-access'
        return options.mode ?? 'read-only'
      },
    },
    commands,
    bodies,
    execs,
    reads,
    attrs,
    writes,
    modes,
    invalidated,
    sftpClosed,
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-transfer-'))
}

/** Create the parent directories of a fixture file the caller writes next. */
async function mkdirTree(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
}

const LIMITS: OpsTransferLimits = { maxBytes: 64 * 1024, timeoutMs: 30_000 }

/* ---------- gate ---------- */

const present: Attrs = { type: 'file', size: 12 }

test('both transfers refuse a deny host before any IO', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    const denied = host({ opsPolicy: 'deny' })
    const upload = api()
    await assert.rejects(() => runSshUpload(upload.api, denied, { local_path: source, remote_path: '/srv/a.bin' }, {}, LIMITS), /disabled/)
    assert.equal(upload.commands.length, 0)
    const download = api({ attrs: () => present })
    await assert.rejects(() => runSshDownload(download.api, denied, { remote_path: '/srv/a.bin', local_path: join(local, 'b.bin') }, {}, LIMITS), /disabled/)
    assert.equal(download.reads.length, 0)
    assert.equal(download.attrs.length, 0)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('both transfers refuse an untrusted host before any IO', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    const untrusted = host({ fingerprint: '' })
    await assert.rejects(() => runSshUpload(api().api, untrusted, { local_path: source, remote_path: '/srv/a.bin' }, {}, LIMITS), /trust its fingerprint/)
    await assert.rejects(() => runSshDownload(api().api, untrusted, { remote_path: '/srv/a.bin', local_path: join(local, 'b.bin') }, {}, LIMITS), /trust its fingerprint/)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('a trust host runs without asking for a mode', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    const trust = host({ opsPolicy: 'trust' })
    const upload = api()
    const value = await runSshUpload(upload.api, trust, { local_path: source, remote_path: '/srv/a.bin' }, {}, LIMITS)
    assert.equal(value.bytes, 3)
    assert.deepEqual(upload.modes, [])
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('an ask host needs danger-full-access, and names the transfer on the card', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    const upload = api()
    await assert.rejects(
      () => runSshUpload(upload.api, host(), { local_path: source, remote_path: '/srv/a.bin' }, {}, LIMITS),
      /sandbox: escalation available/,
    )
    assert.equal(upload.commands.length, 0)
    const detail = upload.modes[0]?.[2]
    assert.match(detail?.en ?? '', /upload/)
    assert.match(detail?.zh ?? '', /上传/)

    const approved = api()
    const value = await runSshUpload(
      approved.api,
      host(),
      { local_path: source, remote_path: '/srv/a.bin', sandbox_permissions: 'danger-full-access', justification: 'deploy the build' },
      {},
      LIMITS,
    )
    assert.equal(value.operation, 'create')
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('download is write-class: an ask host denies it outside danger-full-access', async () => {
  const local = await tempDir()
  try {
    const download = api()
    await assert.rejects(
      () => runSshDownload(download.api, host(), { remote_path: '/srv/a.bin', local_path: join(local, 'b.bin') }, {}, LIMITS),
      /sandbox: escalation available/,
    )
    assert.equal(download.reads.length, 0)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

/* ---------- path rules ---------- */

test('both transfers reject a relative path on either end', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    await assert.rejects(() => runSshUpload(api().api, host(), { local_path: 'a.bin', remote_path: '/srv/a.bin' }, {}, LIMITS), /absolute path on the machine running DSH/)
    await assert.rejects(() => runSshUpload(api().api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: 'srv/a.bin' }, {}, LIMITS), /absolute remote path or start with "~\/"/)
    await assert.rejects(() => runSshDownload(api().api, host(), { remote_path: '/srv/a.bin', local_path: 'b.bin' }, {}, LIMITS), /absolute path on the machine running DSH/)
    await assert.rejects(() => runSshDownload(api().api, host({ opsPolicy: 'trust' }), { remote_path: 'srv/a.bin', local_path: join(local, 'b.bin') }, {}, LIMITS), /absolute remote path or start with "~\/"/)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('download expands ~/ against the remote home', async () => {
  const local = await tempDir()
  try {
    const download = api({ attrs: () => present })
    const value = await runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '~/logs/app.log', local_path: join(local, 'app.log') }, {}, LIMITS)
    assert.equal(value.remotePath, '/home/ops/logs/app.log')
    assert.deepEqual(download.reads, ['/home/ops/logs/app.log'])
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

/* ---------- upload ---------- */

test('upload sends the exact bytes through a same-directory temp file', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'blob.bin')
    const body = Buffer.from([0x00, 0xff, 0xfe, 0x41, 0x00, 0x42])
    await writeFile(source, body)
    const upload = api()
    const value = await runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/blob.bin' }, {}, LIMITS)
    assert.equal(value.bytes, body.length)
    assert.equal(value.operation, 'create')
    const script = upload.commands.join('\n')
    assert.match(script, /mkdir -p '\/srv'/)
    assert.match(script, /mv -f '\/srv\/\.dsh-permission-remote-[0-9a-f]+' '\/srv\/blob\.bin'/)
    assert.doesNotMatch(script, /cat >/)
    const forwarded = upload.bodies.find(item => Buffer.isBuffer(item))
    assert.ok(forwarded)
    assert.deepEqual([...(forwarded as Buffer)], [...body])
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('upload refuses a directory, a symlink, and a special local source', async () => {
  const local = await tempDir()
  try {
    await writeFile(join(local, 'real.bin'), 'abc')
    await symlink(join(local, 'real.bin'), join(local, 'link.bin'))
    await assert.rejects(() => runSshUpload(api().api, host({ opsPolicy: 'trust' }), { local_path: local, remote_path: '/srv/x' }, {}, LIMITS), /is a directory/)
    await assert.rejects(
      () => runSshUpload(api().api, host({ opsPolicy: 'trust' }), { local_path: join(local, 'link.bin'), remote_path: '/srv/x' }, {}, LIMITS),
      /symbolic link/,
    )
    await assert.rejects(
      () => runSshUpload(api().api, host({ opsPolicy: 'trust' }), { local_path: join(local, 'missing.bin'), remote_path: '/srv/x' }, {}, LIMITS),
      /no such local file/,
    )
    if (process.platform !== 'win32') {
      const fifo = join(local, 'pipe')
      execFileSync('mkfifo', [fifo])
      await assert.rejects(
        () => runSshUpload(api().api, host({ opsPolicy: 'trust' }), { local_path: fifo, remote_path: '/srv/x' }, {}, LIMITS),
        /not a regular file/,
      )
    }
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('upload refuses a remote symlink, directory, or special file', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    for (const type of ['symlink', 'directory', 'other'] as const) {
      const upload = api({ attrs: () => ({ type, size: 3 }) })
      await assert.rejects(
        () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/target' }, {}, LIMITS),
        new RegExp(`remote path is not a regular file \\(${type}\\)`),
      )
      // Refused before any remote write.
      assert.equal(upload.commands.length, 0)
    }
    // The probe must not follow the final component.
    const upload = api()
    await runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/target' }, {}, LIMITS)
    assert.deepEqual(upload.attrs, [{ path: '/srv/target', follow: false }])
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('upload preserves the mode of an existing remote file and reports an update', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    const upload = api({ attrs: () => ({ type: 'file', size: 9, mode: 0o100640 }) })
    const value = await runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, LIMITS)
    assert.equal(value.operation, 'update')
    assert.match(upload.commands.join('\n'), /chmod 640 '\/srv\/a\.bin'/)
    const zero = api({ attrs: () => ({ type: 'file', size: 1, mode: 0 }) })
    await runSshUpload(zero.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, LIMITS)
    assert.match(zero.commands.join('\n'), /chmod 0 '\/srv\/a\.bin'/)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

/* ---------- ceilings ---------- */

test('upload refuses an oversize local file before any remote call', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'big.bin')
    await writeFile(source, Buffer.alloc(2048, 0x61))
    const upload = api()
    await assert.rejects(
      () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/big.bin' }, {}, { maxBytes: 1024, timeoutMs: 0 }),
      /over the 1024 byte transfer ceiling/,
    )
    assert.equal(upload.commands.length, 0)
    assert.equal(upload.attrs.length, 0)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('a zero ceiling is unlimited', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'big.bin')
    await writeFile(source, Buffer.alloc(4096, 0x61))
    const upload = api()
    const value = await runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/big.bin' }, {}, NO_TRANSFER_LIMITS)
    assert.equal(value.bytes, 4096)
    assert.equal(value.maxBytes, 0)
    assert.match(renderOpsUpload(value), /no byte ceiling, no timeout/)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('download refuses a remote file over the ceiling before reading it', async () => {
  const local = await tempDir()
  try {
    const download = api({ attrs: () => ({ type: 'file', size: 4096 }) })
    await assert.rejects(
      () => runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/big.bin', local_path: join(local, 'big.bin') }, {}, { maxBytes: 1024, timeoutMs: 0 }),
      /over the 1024 byte transfer ceiling/,
    )
    assert.deepEqual(download.reads, [])
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

/* ---------- download ---------- */

test('download writes the remote bytes atomically beside the target', async () => {
  const local = await tempDir()
  try {
    const body = Buffer.from([0x00, 0x01, 0xff])
    const download = api({ remoteBytes: body, attrs: () => present })
    const target = join(local, 'out.bin')
    const value = await runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/in.bin', local_path: target }, {}, LIMITS)
    assert.equal(value.bytes, body.length)
    assert.deepEqual([...await readFile(target)], [...body])
    // 0600 is stamped on the fresh inode and carried through the rename.
    if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600)
    // No sibling temp file survives.
    assert.deepEqual(await readdir(local), ['out.bin'])
    // Replacing a wider file publishes the temp inode's mode.
    await writeFile(target, 'old', { mode: 0o644 })
    await runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/in.bin', local_path: target }, {}, LIMITS)
    assert.deepEqual([...await readFile(target)], [...body])
    if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, 0o600)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('an exclusive temp create does not follow a symlink planted on that path', async () => {
  const local = await tempDir()
  try {
    const secret = join(local, 'secret')
    await writeFile(secret, 'keep')
    const planted = join(local, 'planted')
    await symlink(secret, planted)
    await assert.rejects(() => openExclusiveTemp(planted))
    assert.equal(await readFile(secret, 'utf8'), 'keep')
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('download refuses a missing remote file, a directory, a symlink, and a special file', async () => {
  const local = await tempDir()
  try {
    await assert.rejects(
      () => runSshDownload(api({ attrs: () => undefined }).api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/none', local_path: join(local, 'a') }, {}, LIMITS),
      /no file at remote path: \/srv\/none/,
    )
    for (const type of ['directory', 'symlink', 'other'] as const) {
      const download = api({ attrs: () => ({ type, size: 3 }) })
      await assert.rejects(
        () => runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/x', local_path: join(local, 'a') }, {}, LIMITS),
        new RegExp(`remote path is not a regular file \\(${type}\\)`),
      )
      assert.deepEqual(download.reads, [])
    }
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

/* ---------- transport faults are not "missing" ---------- */

test('a transport fault is reported as itself, never as "no file"', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    // A dropped connection, a refused permission, and a protocol fault all must
    // survive: turning one into "no file at remote path" would send the model
    // hunting for a path that exists on a host it cannot reach.
    const faults: Array<{ label: string, error: Error }> = [
      { label: 'dropped connection', error: new SshFailure('Connection lost', 'sftp-lstat') },
      { label: 'permission denied', error: new SshFailure('Permission denied', 'sftp-lstat', SFTP_PERMISSION_DENIED) },
      // Wording that a naive message match would misclassify as missing.
      { label: 'missing-looking message', error: new SshFailure('channel closed before the file could be found', 'sftp-lstat') },
    ]
    for (const fault of faults) {
      const failing = () => { throw fault.error }
      const upload = api({ attrs: () => failing() as never })
      await assert.rejects(
        () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, LIMITS),
        (error: Error) => error.message === fault.error.message,
        `upload should surface ${fault.label} unchanged`,
      )
      assert.equal(upload.commands.length, 0, `${fault.label}: no remote write`)

      const download = api({ attrs: () => failing() as never })
      await assert.rejects(
        () => runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/a.bin', local_path: join(local, 'b.bin') }, {}, LIMITS),
        (error: Error) => error.message === fault.error.message && !/no file at remote path/.test(error.message),
        `download should surface ${fault.label} unchanged`,
      )
      assert.deepEqual(download.reads, [], `${fault.label}: no bytes pulled`)
    }
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('download refuses a local directory, a local symlink, and a missing parent', async () => {
  const local = await tempDir()
  try {
    await writeFile(join(local, 'real.bin'), 'old')
    await symlink(join(local, 'real.bin'), join(local, 'link.bin'))
    await assert.rejects(
      () => runSshDownload(api({ attrs: () => present }).api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/x', local_path: local }, {}, LIMITS),
      /local path is a directory/,
    )
    await assert.rejects(
      () => runSshDownload(api({ attrs: () => present }).api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/x', local_path: join(local, 'link.bin') }, {}, LIMITS),
      /refusing to write through a symbolic link/,
    )
    const missingParent = api({ attrs: () => present })
    await assert.rejects(
      () => runSshDownload(missingParent.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/x', local_path: join(local, 'nested', 'out.bin') }, {}, LIMITS),
      /local parent directory does not exist/,
    )
    // The destination is checked before a single byte is pulled.
    assert.deepEqual(missingParent.reads, [])
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

/* ---------- timeout and cancellation ---------- */

test('the configured timeout reaches the remote write, and zero installs no deadline', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    const upload = api()
    await runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, { maxBytes: 0, timeoutMs: 4321 })
    assert.equal(upload.execs[0]?.timeoutMs, 4321)
    const unlimited = api()
    await runSshUpload(unlimited.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, NO_TRANSFER_LIMITS)
    assert.equal(unlimited.execs[0]?.timeoutMs, 0)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('a pre-aborted call performs no IO', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    const controller = new AbortController()
    controller.abort()
    const upload = api()
    await assert.rejects(
      () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, { signal: controller.signal }, LIMITS),
      /abort/i,
    )
    assert.equal(upload.commands.length, 0)
    const download = api()
    await assert.rejects(
      () => runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/a.bin', local_path: join(local, 'b.bin') }, { signal: controller.signal }, LIMITS),
      /abort/i,
    )
    assert.deepEqual(download.reads, [])
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

/* ---------- rendering ---------- */

test('renderers state both paths, the byte count, and the limits that applied', () => {
  const upload = renderOpsUpload({
    host: { name: 'prod', address: '10.0.0.1' },
    localPath: '/work/a.bin',
    remotePath: '/srv/a.bin',
    bytes: 12,
    operation: 'update',
    maxBytes: 1024,
    timeoutMs: 5000,
  })
  assert.match(upload, /uploaded \/work\/a\.bin → \/srv\/a\.bin on prod \(12 bytes, updated; 1024 byte ceiling, 5000 ms timeout\)/)
  const download = renderOpsDownload({
    host: { name: 'prod', address: '10.0.0.1' },
    remotePath: '/srv/a.bin',
    localPath: '/work/a.bin',
    bytes: 12,
    maxBytes: 0,
    timeoutMs: 0,
  })
  assert.match(download, /downloaded \/srv\/a\.bin from prod → \/work\/a\.bin \(12 bytes; no byte ceiling, no timeout\)/)
})

/* ===== review follow-ups ===== */

test('upload refuses the filesystem root as clearly as download does', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    const upload = api()
    await assert.rejects(
      () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/' }, {}, LIMITS),
      /must name a file, not the filesystem root/,
    )
    assert.equal(upload.commands.length, 0)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('a timeout is reported as a timeout, not as a cancellation', async () => {
  const local = await tempDir()
  // `AbortSignal.timeout` unrefs its timer, so a test that only awaits a
  // never-settling promise lets the runner exit before the deadline fires.
  // This handle keeps the loop alive for the duration of the assertion.
  const keepAlive = setInterval(() => undefined, 5)
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, Buffer.alloc(64, 0x61))
    const upload = api({ exec: () => new Promise(() => undefined) as unknown as ExecResult })
    await assert.rejects(
      () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, { maxBytes: 0, timeoutMs: 20 }),
      /transfer timed out after 20 ms/,
    )
  } finally {
    clearInterval(keepAlive)
    await rm(local, { recursive: true, force: true })
  }
})

test('a cancellation still reports as a cancellation, not a timeout', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, Buffer.alloc(64, 0x61))
    const controller = new AbortController()
    const upload = api({
      exec: () => {
        controller.abort()
        return new Promise(() => undefined) as unknown as ExecResult
      },
    })
    await assert.rejects(
      () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, { signal: controller.signal }, { maxBytes: 0, timeoutMs: 60_000 }),
      (error: Error) => error.name === 'AbortError' && !/timed out/.test(error.message),
    )
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('a timeout during the remote pre-check is reported as a timeout', async () => {
  const local = await tempDir()
  const keepAlive = setInterval(() => undefined, 5)
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abc')
    // The SFTP lstat never settles. The deadline lives on a combined signal,
    // so the step has to be raced through `withTransferDeadline`; otherwise
    // this reproduces as a bare AbortError.
    const hang = () => new Promise<never>(() => undefined) as never
    const upload = api({ attrs: hang })
    await assert.rejects(
      () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, { maxBytes: 0, timeoutMs: 30 }),
      (error: Error) => error.name === 'TimeoutError' && /transfer timed out after 30 ms/.test(error.message),
    )
    assert.equal(upload.commands.length, 0)

    const download = api({ attrs: hang })
    await assert.rejects(
      () => runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/a.bin', local_path: join(local, 'b.bin') }, {}, { maxBytes: 0, timeoutMs: 30 }),
      (error: Error) => error.name === 'TimeoutError' && /transfer timed out after 30 ms/.test(error.message),
    )
    assert.deepEqual(download.reads, [])
  } finally {
    clearInterval(keepAlive)
    await rm(local, { recursive: true, force: true })
  }
})

test('a timeout during ~ expansion is reported as a timeout', async () => {
  const local = await tempDir()
  const keepAlive = setInterval(() => undefined, 5)
  try {
    // `$HOME` is resolved by an exec without its own signal; the call has to
    // race it against the transfer deadline rather than wait it out.
    const download = api({ exec: () => new Promise(() => undefined) as unknown as ExecResult })
    await assert.rejects(
      () => runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '~/logs/app.log', local_path: join(local, 'app.log') }, {}, { maxBytes: 0, timeoutMs: 30 }),
      (error: Error) => error.name === 'TimeoutError' && /transfer timed out after 30 ms/.test(error.message),
    )
  } finally {
    clearInterval(keepAlive)
    await rm(local, { recursive: true, force: true })
  }
})

test('a cancellation during the remote pre-check stays a cancellation', async () => {
  const local = await tempDir()
  try {
    const controller = new AbortController()
    const download = api({ attrs: () => new Promise<never>(() => undefined) as never })
    const pending = runSshDownload(
      download.api,
      host({ opsPolicy: 'trust' }),
      { remote_path: '/srv/a.bin', local_path: join(local, 'b.bin') },
      { signal: controller.signal },
      { maxBytes: 0, timeoutMs: 60_000 },
    )
    controller.abort()
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError' && !/timed out/.test(error.message))
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('the 0-byte, exact-ceiling, and over-ceiling boundaries hold', async () => {
  const local = await tempDir()
  try {
    const cap = 4
    for (const size of [0, cap, cap + 1]) {
      const source = join(local, `u-${size}.bin`)
      await writeFile(source, Buffer.alloc(size, 0x61))
      const upload = api()
      const run = runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/x' }, {}, { maxBytes: cap, timeoutMs: 0 })
      if (size > cap) {
        await assert.rejects(run, /over the 4 byte transfer ceiling/)
      } else {
        assert.equal((await run).bytes, size)
      }

      const download = api({ attrs: () => ({ type: 'file', size }), remoteBytes: Buffer.alloc(size, 0x62) })
      const target = join(local, `d-${size}.bin`)
      const pulled = runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/x', local_path: target }, {}, { maxBytes: cap, timeoutMs: 0 })
      if (size > cap) {
        await assert.rejects(pulled, /over the 4 byte transfer ceiling/)
      } else {
        assert.equal((await pulled).bytes, size)
        assert.equal((await readFile(target)).length, size)
      }
    }
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('a remote file that grows after the pre-check is not read past the ceiling', async () => {
  const local = await tempDir()
  try {
    // `attrs` says one byte, but the read returns ten: the read-side cap is
    // what has to stop it, and the failure must not be rewritten as "missing".
    const target = join(local, 'b.bin')
    const download = api({ attrs: () => ({ type: 'file', size: 1 }), remoteBytes: Buffer.alloc(10, 0x63) })
    await assert.rejects(
      () => runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/a.bin', local_path: target }, {}, { maxBytes: 4, timeoutMs: 0 }),
      (error: Error) => /over the 4 byte transfer ceiling/.test(error.message) && !/no file at remote path/.test(error.message),
    )
    await assert.rejects(() => stat(target), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
    assert.deepEqual(await readdir(local), [])
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('an upload that fails during the copy deletes the temp and does not replace the target', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abcd')
    const upload = api({ send: async () => { throw new Error('local file is over the 8 byte transfer ceiling') } })
    await assert.rejects(
      () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, { maxBytes: 8, timeoutMs: 0 }),
      /over the 8 byte transfer ceiling/,
    )
    const script = upload.commands.join('\n')
    assert.match(script, /mkdir -p '\/srv'/)
    assert.match(script, /rm -f '\/srv\/\.dsh-permission-remote-[0-9a-f]+'/)
    assert.doesNotMatch(script, /mv -f/)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('an aborted upload closes its transfer lease and removes the temp without the aborted signal', async () => {
  const local = await tempDir()
  const keepAlive = setInterval(() => undefined, 5)
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abcd')
    const upload = api({
      send: limits => new Promise<number>((_resolve, reject) => {
        const signal = limits?.signal
        if (signal === undefined) {
          reject(new Error('upload copy was not given a deadline signal'))
          return
        }
        const aborted = (): void => reject(Object.assign(new Error('SSH operation aborted'), { name: 'AbortError' }))
        if (signal?.aborted === true) aborted()
        else signal?.addEventListener('abort', aborted, { once: true })
      }),
    })
    await assert.rejects(
      () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, { maxBytes: 0, timeoutMs: 20 }),
      (error: Error) => error.name === 'TimeoutError',
    )
    // The transfer's own SFTP channel is closed before `rm`; no shared session
    // is touched.
    assert.deepEqual(upload.sftpClosed, ['prod1'])
    assert.deepEqual(upload.invalidated, [])
    const removed = upload.execs.find(entry => entry.command.startsWith('rm -f '))
    assert.ok(removed)
    assert.equal(removed?.signal, undefined)
  } finally {
    clearInterval(keepAlive)
    await rm(local, { recursive: true, force: true })
  }
})

test('a never-settling upload copy is bounded, closes only the SFTP channel, and removes the temp', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abcd')
    const upload = api({ send: () => new Promise(() => {}) })
    const started = Date.now()
    await assert.rejects(
      () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, { maxBytes: 0, timeoutMs: 20 }),
      (error: Error) => error.name === 'TimeoutError',
    )
    // The cleanup window, not the transfer deadline, bounds the call. The
    // stuck write is what costs it; it must not grow with the transfer timeout.
    assert.ok(Date.now() - started < 2_000, 'a stuck transfer must not wait out the full cleanup bound')
    // The connection is shared with ssh_exec, terminals, and the PTC worker, so
    // dropping it would make one timed-out upload a host-wide outage.
    assert.deepEqual(upload.invalidated, [], 'the shared connection must stay up')
    assert.deepEqual(upload.sftpClosed, ['prod1'], 'the stuck SFTP channel must be closed')
    assert.match(upload.commands.join('\n'), /rm -f '\/srv\/\.dsh-permission-remote-[0-9a-f]+'/)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('an upload still publishes when every write was acknowledged but the close is slow', async () => {
  // `sending` resolving means every WRITE was acknowledged; a late CHANNEL_CLOSE
  // cannot lose the bytes. Failing (and deleting the temp) here wasted a whole
  // completed transfer.
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abcd')
    const upload = api({ leaseSettled: false })
    const value = await runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, { maxBytes: 0, timeoutMs: 0 })
    assert.equal(value.bytes, 4)
    assert.match(upload.commands.join('\n'), /mv -f/)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('a timed-out upload whose channel never closes names the possible leak but keeps its error type', async () => {
  const local = await tempDir()
  try {
    const source = join(local, 'a.bin')
    await writeFile(source, 'abcd')
    const upload = api({
      leaseSettled: false,
      send: limits => new Promise<number>((_resolve, reject) => {
        const signal = limits?.signal
        if (signal === undefined) { reject(new Error('no deadline signal')); return }
        const aborted = (): void => reject(Object.assign(new Error('SSH operation aborted'), { name: 'AbortError' }))
        if (signal.aborted) aborted()
        else signal.addEventListener('abort', aborted, { once: true })
      }),
    })
    await assert.rejects(
      () => runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: source, remote_path: '/srv/a.bin' }, {}, { maxBytes: 0, timeoutMs: 20 }),
      (error: Error) => error.name === 'TimeoutError'
        && /a temporary file may remain/.test(error.message)
        && /\.dsh-permission-remote-/.test(error.message),
    )
    // An unconfirmed close skips `rm`: the path is reported instead, because a
    // late OPEN could recreate the file after a premature delete.
    assert.doesNotMatch(upload.commands.join('\n'), /rm -f '\/srv\/\.dsh-permission-remote-[0-9a-f]+'/)
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})

test('a copy still publishes when every write was acknowledged but the close is slow', async () => {
  const copy = copyApi({ leaseSettled: false })
  const value = await runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS)
  assert.equal(value.bytes, 5)
  assert.match(copy.commands.join('\n'), /mv -f/)
})

test('a timeout during the download copy is a timeout and leaves no local file', async () => {
  const local = await tempDir()
  const keepAlive = setInterval(() => undefined, 5)
  try {
    const target = join(local, 'b.bin')
    const download = api({
      attrs: () => ({ type: 'file', size: 10 }),
      chunks: async function* () { await new Promise(() => undefined) },
    })
    await assert.rejects(
      () => runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/a.bin', local_path: target }, {}, { maxBytes: 0, timeoutMs: 30 }),
      (error: Error) => error.name === 'TimeoutError' && /transfer timed out after 30 ms/.test(error.message),
    )
    await assert.rejects(() => stat(target), (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
    assert.deepEqual(await readdir(local), [])
  } finally {
    clearInterval(keepAlive)
    await rm(local, { recursive: true, force: true })
  }
})

/* ─────────── ssh_copy: remote A → remote B, no local bytes ─────────── */

/** A second host so a copy has a target that is not the source. */
function backup(overrides: Partial<HostConfig> = {}): HostConfig {
  return host({ id: 'backup1', name: 'backup', host: '10.0.0.2', opsPolicy: 'trust', ...overrides })
}

/**
 * The default pair: source `ask` (reads need no approval), target `trust`, so a
 * success test is not also an approval test. The gate cases build their own pair.
 */
const TWO_HOSTS = [host(), backup()]

const COPY_BYTES = Buffer.from('hello')
const TARGET_PREFIX = '/backup'

/**
 * Both hosts in the copy fixture.
 *
 * The source side is any path under `/srv`, `/src`, or a home directory; the
 * target side is anything under `/backup`. That split keeps the attrs stub from
 * having to predict the exact path a `~/` expansion produces.
 */
function copyApi(options: {
  /** `null` means the source path does not exist on the source host. */
  source?: Attrs | null
  target?: Attrs | undefined
  hosts?: HostConfig[]
  sendChunks?: (target: string, remotePath: string, source: AsyncIterable<Buffer>, limits: { maxBytes?: number, signal?: AbortSignal } | undefined) => Promise<number>
  chunks?: () => AsyncIterable<Buffer>
  remoteBytes?: Buffer
  maxConnections?: number
  connectedHostIds?: string[]
  freeSlots?: number
  leaseSettled?: boolean
} = {}) {
  return api({
    hosts: options.hosts ?? TWO_HOSTS,
    chunks: options.chunks,
    remoteBytes: options.remoteBytes ?? COPY_BYTES,
    sendChunks: options.sendChunks as never,
    maxConnections: options.maxConnections,
    connectedHostIds: options.connectedHostIds,
    freeSlots: options.freeSlots,
    leaseSettled: options.leaseSettled,
    attrs: (path: string) => {
      if (path.startsWith(TARGET_PREFIX)) return options.target
      if (options.source === null) return undefined
      return options.source ?? { type: 'file', size: COPY_BYTES.length, mode: 0o100644 }
    },
  })
}

test('ssh_copy streams a file from one host to another without local bytes', async () => {
  const copy = copyApi()
  const value = await runSshCopy(copy.api, backup(), {
    source_path: '/srv/release.tar.gz',
    source_host: 'prod1',
    target_path: '/backup/release.tar.gz',
  }, {}, (selector) => (TWO_HOSTS.find(item => item.id === selector))!, LIMITS)
  assert.equal(value.bytes, 5)
  assert.equal(value.operation, 'create')
  assert.equal(value.sourcePath, '/srv/release.tar.gz')
  assert.equal(value.targetPath, '/backup/release.tar.gz')
  // The source host is only read; the target host gets mkdir and mv.
  assert.deepEqual(copy.reads, ['/srv/release.tar.gz'])
  const script = copy.commands.join('\n')
  assert.match(script, /mkdir -p '\/backup'/)
  assert.match(script, /mv -f '\/backup\/\.dsh-permission-remote-[0-9a-f]+' '\/backup\/release\.tar\.gz'/)
  assert.doesNotMatch(script, /cat >/)
  assert.match(renderOpsCopy(value), /^copied prod:\/srv\/release\.tar\.gz → backup:\/backup\/release\.tar\.gz \(5 bytes, created; 65536 byte ceiling, 30000 ms timeout\)$/)
})

test('a cross-host copy refuses a one-connection pool before approval', async () => {
  const copy = copyApi({ maxConnections: 1 })
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
    /maxConnections >= 2/,
  )
  assert.deepEqual(copy.reads, [])
  assert.deepEqual(copy.modes, [])
})

test('a cross-host copy fails fast when the pool has only one free slot', async () => {
  // The reported deadlock: maxConnections=2, one slot already held by a
  // sidebar terminal, and both copy hosts still unconnected. The second
  // reserve() would queue forever with no connection able to close.
  const copy = copyApi({ maxConnections: 2, freeSlots: 1 })
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
    (error: Error) => /needs 2 free SSH connection slots/.test(error.message) && /maxConnections=2/.test(error.message),
  )
  // Refuse before the approval card and before any connection is opened.
  assert.deepEqual(copy.modes, [])
  assert.deepEqual(copy.reads, [])
})

test('a copy whose hosts are already connected needs no free slots', async () => {
  const copy = copyApi({ connectedHostIds: ['prod1', 'backup1'], freeSlots: 0 })
  const value = await runSshCopy(copy.api, backup(), {
    source_path: '/srv/release.tar.gz',
    source_host: 'prod1',
    target_path: '/backup/release.tar.gz',
  }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS)
  assert.equal(value.bytes, 5)
})

test('a same-host copy needs only one new connection', async () => {
  const trusted = host({ opsPolicy: 'trust' })
  const copy = copyApi({ hosts: [trusted], freeSlots: 1 })
  const value = await runSshCopy(copy.api, trusted, {
    source_path: '/srv/release.tar.gz',
    source_host: 'prod1',
    target_path: '/srv/copy.tar.gz',
  }, {}, () => trusted, LIMITS)
  assert.equal(value.bytes, 5)
  assert.deepEqual(value.sourceHost, value.targetHost)
})

test('a relative target is refused before the approval card', async () => {
  const askTarget = backup({ opsPolicy: 'ask' })
  const pair = [host(), askTarget]
  const copy = copyApi({ hosts: pair })
  await assert.rejects(
    () => runSshCopy(copy.api, askTarget, { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: 'release.tar.gz' }, {}, selector => pair.find(item => item.id === selector)!, LIMITS),
    /target_path must be an absolute remote path or start with "~\/"/,
  )
  assert.deepEqual(copy.modes, [])
  assert.deepEqual(copy.reads, [])
})

test('a relative source with an explicit source_host is refused before approval', async () => {
  const askTarget = backup({ opsPolicy: 'ask' })
  const pair = [host(), askTarget]
  const copy = copyApi({ hosts: pair })
  await assert.rejects(
    () => runSshCopy(copy.api, askTarget, { source_path: 'release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => pair.find(item => item.id === selector)!, LIMITS),
    /source_path must be an absolute remote path or start with "~\/"/,
  )
  assert.deepEqual(copy.modes, [])
  assert.deepEqual(copy.reads, [])
})

test('the approval card shows normalized remote paths', async () => {
  const askTarget = backup({ opsPolicy: 'ask' })
  const pair = [host(), askTarget]
  const copy = copyApi({ hosts: pair })
  const value = await runSshCopy(copy.api, askTarget, {
    source_path: '/srv/../etc/cron.d/x',
    source_host: 'prod1',
    target_path: '/backup/../etc/cron.d/y',
    sandbox_permissions: 'danger-full-access',
    justification: 'mirror the release',
  }, {}, selector => pair.find(item => item.id === selector)!, LIMITS)
  const detail = copy.modes.at(-1)?.[2]
  assert.match(detail?.en ?? '', /copy \/etc\/cron\.d\/x on prod .* to \/etc\/cron\.d\/y on backup/)
  assert.doesNotMatch(detail?.en ?? '', /\.\./)
  assert.equal(value.sourcePath, '/etc/cron.d/x')
  assert.equal(value.targetPath, '/etc/cron.d/y')
})

test('a copy over an existing target keeps its permission bits and reports an update', async () => {
  const copy = copyApi({ target: { type: 'file', size: 9, mode: 0o100640 } })
  const value = await runSshCopy(copy.api, backup(), {
    source_path: '/srv/release.tar.gz',
    source_host: 'prod1',
    target_path: '/backup/release.tar.gz',
  }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS)
  assert.equal(value.operation, 'update')
  assert.match(copy.commands.join('\n'), /chmod 640 '\/backup\/release\.tar\.gz'/)
})

test('a placeholder source_path carries its own host and needs no source_host', async () => {
  const root = await tempDir()
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  setRemoteRootOverride(root)
  try {
    const placeholder = mapRemoteToLocal('prod1', '/srv/release.tar.gz')!
    const copy = copyApi()
    const value = await runSshCopy(copy.api, backup(), {
      source_path: placeholder,
      target_path: '/backup/release.tar.gz',
    }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS)
    assert.equal(value.sourcePath, '/srv/release.tar.gz')
    assert.deepEqual(copy.reads, ['/srv/release.tar.gz'])
  } finally {
    setRemoteRootOverride(null)
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('a placeholder source and a conflicting source_host are refused before any IO', async () => {
  const root = await tempDir()
  setRemoteRootOverride(root)
  try {
    const placeholder = mapRemoteToLocal('prod1', '/srv/release.tar.gz')!
    const copy = copyApi()
    await assert.rejects(
      () => runSshCopy(copy.api, backup(), { source_path: placeholder, source_host: 'backup1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
      /does not match the placeholder path, which belongs to prod1/,
    )
    assert.deepEqual(copy.reads, [])
    assert.equal(copy.commands.length, 0)
  } finally {
    setRemoteRootOverride(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('a local session must name source_host', async () => {
  const copy = copyApi()
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS, '/tmp/local-project'),
    /source_host is required/,
  )
  const value = await runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS, '/tmp/local-project')
  assert.equal(value.sourcePath, '/srv/release.tar.gz')
})

test('a remote session uses its own host as the source when source_host is omitted', async () => {
  const root = await tempDir()
  setRemoteRootOverride(root)
  try {
    const cwd = mapRemoteToLocal('prod1', '/srv/app')!
    const copy = copyApi()
    const value = await runSshCopy(copy.api, backup(), { source_path: 'release.tar.gz', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS, cwd)
    assert.equal(value.sourcePath, '/srv/app/release.tar.gz')
  } finally {
    setRemoteRootOverride(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('copying a file onto itself is refused before any read', async () => {
  const copy = copyApi()
  await assert.rejects(
    () => runSshCopy(copy.api, host({ opsPolicy: 'trust' }), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/srv/./release.tar.gz' }, {}, selector => (selector === 'prod1' ? host({ opsPolicy: 'trust' }) : backup())!, LIMITS),
    /same file on prod \(10\.0\.0\.1\)/,
  )
  assert.deepEqual(copy.reads, [])
})

test('the filesystem root is refused on either end', async () => {
  const copy = copyApi()
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
    /source_path must name a file/,
  )
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
    /target_path must name a file/,
  )
})

test('the source gate follows ssh_read: deny and untrusted refuse, trust does not need approval', async () => {
  const denied = copyApi({ hosts: [host({ opsPolicy: 'deny' }), backup()] })
  await assert.rejects(
    () => runSshCopy(denied.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => (selector === 'prod1' ? host({ opsPolicy: 'deny' }) : backup())!, LIMITS),
    /disabled for SSH host/,
  )
  assert.deepEqual(denied.reads, [])
  assert.deepEqual(denied.modes, [])

  const untrusted = copyApi()
  await assert.rejects(
    () => runSshCopy(untrusted.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => (selector === 'prod1' ? host({ fingerprint: '' }) : backup())!, LIMITS),
    /trust its fingerprint/,
  )
  assert.deepEqual(untrusted.modes, [])
})

test('the target gate is write-class: an ask host needs danger-full-access', async () => {
  const askTarget = backup({ opsPolicy: 'ask' })
  const pair = [host(), askTarget]
  const resolve = (selector: string) => pair.find(item => item.id === selector)!
  const copy = copyApi({ hosts: pair })
  await assert.rejects(
    () => runSshCopy(copy.api, askTarget, { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, resolve, LIMITS),
    /sandbox: escalation available/,
  )
  assert.deepEqual(copy.reads, [])
  assert.equal(copy.commands.length, 0)
})

test('the approval card names both ends', async () => {
  const askTarget = backup({ opsPolicy: 'ask' })
  const pair = [host(), askTarget]
  const resolve = (selector: string) => pair.find(item => item.id === selector)!
  const copy = copyApi({ hosts: pair })
  const value = await runSshCopy(copy.api, askTarget, {
    source_path: '/srv/release.tar.gz',
    source_host: 'prod1',
    target_path: '/backup/release.tar.gz',
    sandbox_permissions: 'danger-full-access',
    justification: 'mirror the release',
  }, {}, resolve, LIMITS)
  assert.equal(value.bytes, 5)
  const detail = copy.modes.at(-1)?.[2]
  assert.match(detail?.en ?? '', /copy \/srv\/release\.tar\.gz on prod \(10\.0\.0\.1\) to \/backup\/release\.tar\.gz on backup \(10\.0\.0\.2\)/)
  assert.match(detail?.zh ?? '', /把 prod \(10\.0\.0\.1\) 的 \/srv\/release\.tar\.gz 复制到 backup \(10\.0\.0\.2\) 的/)
})

test('a source that is not a regular file is refused before the target is touched', async () => {
  for (const type of ['directory', 'symlink', 'other'] as const) {
    const copy = copyApi({ source: { type, size: 3 } })
    await assert.rejects(
      () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
      new RegExp(`source path is not a regular file \\(${type}\\) on prod`),
    )
    assert.deepEqual(copy.reads, [])
    assert.equal(copy.commands.length, 0)
  }
})

test('a missing source names the source host, not the target', async () => {
  const copy = copyApi({ source: null })
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/srv/none', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
    /no file at source path on prod \(10\.0\.0\.1\): \/srv\/none/,
  )
})

test('a target that is a directory or symlink is refused before the copy starts', async () => {
  for (const type of ['directory', 'symlink', 'other'] as const) {
    const copy = copyApi({ target: { type, size: 3 } })
    await assert.rejects(
      () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
      new RegExp(`target path is not a regular file \\(${type}\\) on backup`),
    )
    assert.deepEqual(copy.reads, [])
  }
})

test('a source over the ceiling fails on the pre-check, and one that grows fails on the stream', async () => {
  const big = copyApi({ source: { type: 'file', size: 4096 } })
  await assert.rejects(
    () => runSshCopy(big.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, { maxBytes: 1024, timeoutMs: 0 }),
    /source file is 4096 bytes, over the 1024 byte transfer ceiling/,
  )
  assert.deepEqual(big.reads, [])

  const grows = copyApi({
    // The pre-check sees a file inside the ceiling; the stream is what trips.
    source: { type: 'file', size: 2 },
    remoteBytes: Buffer.alloc(10, 0x41),
    sendChunks: async () => { throw new SshFailure('source file is over the 4 byte transfer ceiling', 'sftp-write', undefined, true) },
  })
  await assert.rejects(
    () => runSshCopy(grows.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, { maxBytes: 4, timeoutMs: 0 }),
    /over the 4 byte transfer ceiling/,
  )
  const script = grows.commands.join('\n')
  assert.match(script, /rm -f '\/backup\/\.dsh-permission-remote-[0-9a-f]+'/)
  assert.doesNotMatch(script, /mv -f/)
})

test('a failing copy closes the source chunks and removes the target temp', async () => {
  const events: string[] = []
  const sourceState = { returned: 0 }
  const copy = copyApi({
    chunks: () => ({
      [Symbol.asyncIterator]() {
        let sent = false
        return {
          async next() {
            if (sent) return { done: true, value: undefined }
            sent = true
            return { done: false, value: Buffer.from('x') }
          },
          async return() {
            sourceState.returned += 1
            return { done: true, value: undefined }
          },
        }
      },
    }) as AsyncIterable<Buffer>,
    sendChunks: async (_target, _remotePath, source) => {
      // Pull one chunk, then fail; a real writer closes the source generator in
      // its finally block, so mirror that here.
      const iterator = source[Symbol.asyncIterator]()
      await iterator.next()
      events.push('failed')
      await iterator.return?.()
      throw new Error('target write failed')
    },
  })
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
    /target write failed/,
  )
  assert.deepEqual(events, ['failed'])
  assert.equal(sourceState.returned, 1)
  assert.match(copy.commands.join('\n'), /rm -f '\/backup\/\.dsh-permission-remote-[0-9a-f]+'/)
  assert.doesNotMatch(copy.commands.join('\n'), /mv -f/)
})

test('a cancelled copy is an AbortError and cleans up without the aborted signal', async () => {
  const controller = new AbortController()
  const copy = copyApi({
    sendChunks: async () => {
      controller.abort()
      throw Object.assign(new Error('tool call aborted'), { name: 'AbortError' })
    },
  })
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, { signal: controller.signal }, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
    (error: Error) => error.name === 'AbortError',
  )
  const cleanup = copy.execs.filter(exec => exec.command.startsWith('rm -f'))
  assert.equal(cleanup.length, 1)
  // The cleanup channel must outlive the aborted call.
  assert.equal(cleanup[0]?.signal, undefined)
})

test('a timed-out copy is a TimeoutError with the configured milliseconds', async () => {
  // A real SFTP write observes the signal and rejects, which is what lets the
  // cleanup path await the copy before removing the temp. The fake has to do
  // the same or the cleanup wait would be the test's own bug.
  const copy = copyApi({
    sendChunks: (_target, _remotePath, _source, limits) => new Promise((_resolve, reject) => {
      const signal = limits?.signal
      const fail = () => reject(Object.assign(new Error('tool call aborted'), { name: 'AbortError' }))
      if (signal?.aborted === true) fail()
      else signal?.addEventListener('abort', fail, { once: true })
    }),
  })
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, { maxBytes: 0, timeoutMs: 20 }),
    (error: Error) => error.name === 'TimeoutError' && /transfer timed out after 20 ms/.test(error.message),
  )
})

test('a never-settling copy send is bounded, closes only the SFTP channels, and removes the temp', async () => {
  const copy = copyApi({ sendChunks: () => new Promise(() => {}) })
  const started = Date.now()
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, { maxBytes: 0, timeoutMs: 20 }),
    (error: Error) => error.name === 'TimeoutError',
  )
  assert.ok(Date.now() - started < 2_000, 'a stuck copy must not wait out the full cleanup bound')
  // Both connections stay up: the source may be the session's own host, and
  // the target's terminals and commands are not part of this failure.
  assert.deepEqual(copy.invalidated, [], 'no shared connection may be dropped')
  assert.deepEqual(copy.sftpClosed.sort(), ['backup1', 'prod1'], 'both stuck SFTP channels must be closed')
  assert.match(copy.commands.join('\n'), /rm -f '\/backup\/\.dsh-permission-remote-[0-9a-f]+'/)
})

test('~/ on either end expands against that host\'s own home', async () => {
  const copy = copyApi({ source: { type: 'file', size: 5 } })
  const value = await runSshCopy(copy.api, backup(), {
    source_path: '~/release.tar.gz',
    source_host: 'prod1',
    target_path: '~/backups/release.tar.gz',
  }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS)
  assert.equal(value.sourcePath, '/home/ops/release.tar.gz')
  assert.equal(value.targetPath, '/home/ops/backups/release.tar.gz')
})

/* ─────────── the placeholder-path guard on the local transfers ─────────── */

test('upload and download refuse a placeholder local_path before the approval gate', async () => {
  const root = await tempDir()
  setRemoteRootOverride(root)
  try {
    const placeholder = mapRemoteToLocal('prod1', '/srv/app/release.tar.gz')!
    // A remote workspace placeholder tree is a real local directory skeleton, so
    // without the guard the failure would arrive after the user approved.
    await mkdirTree(placeholder)
    const upload = api()
    await assert.rejects(
      () => runSshUpload(upload.api, host(), { local_path: placeholder, remote_path: '/srv/x' }, {}, LIMITS),
      /remote workspace placeholder path .*use ssh_copy/s,
    )
    assert.deepEqual(upload.modes, [])
    assert.deepEqual(upload.reads, [])

    const download = api({ attrs: () => present })
    await assert.rejects(
      () => runSshDownload(download.api, host(), { remote_path: '/srv/a.bin', local_path: placeholder }, {}, LIMITS),
      /remote workspace placeholder path .*use ssh_copy/s,
    )
    assert.deepEqual(download.modes, [])
    assert.deepEqual(download.reads, [])
  } finally {
    setRemoteRootOverride(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('the guard does not fire for a delivery snapshot under the same root', async () => {
  const root = await tempDir()
  setRemoteRootOverride(root)
  try {
    // `.deliverables` is never a valid host id, so a snapshot is a real local
    // file and must keep uploading normally.
    const snapshot = join(root, '.deliverables', 'abc', 'file.bin')
    await mkdirTree(snapshot)
    await writeFile(snapshot, 'snapshot bytes')
    const upload = api()
    const value = await runSshUpload(upload.api, host({ opsPolicy: 'trust' }), { local_path: snapshot, remote_path: '/srv/x' }, {}, LIMITS)
    assert.equal(value.bytes, 14)
  } finally {
    setRemoteRootOverride(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('a native placeholder path is recognised on every platform', async () => {
  // On Windows a placeholder is a drive path, which `posix.isAbsolute` rejects: a
  // posix check in front of the placeholder branch dropped it through to "treat this
  // as a remote path" and asked for the wrong host. The predicate has to
  // decide absoluteness with the native rules only.
  const root = await tempDir()
  setRemoteRootOverride(root)
  try {
    // `mapRemoteToLocal` builds a native path, so this covers the Windows
    // spelling when the suite runs there.
    const placeholder = mapRemoteToLocal('prod1', '/srv/release.tar.gz')!
    assert.equal(placeholder.startsWith(root), true)
    const isRemotePlaceholderPath = (await import('../src/router.ts')).isRemotePlaceholderPath
    assert.equal(isRemotePlaceholderPath(placeholder), true)
    assert.equal(isRemotePlaceholderPath('/srv/release.tar.gz'), false)
  } finally {
    setRemoteRootOverride(null)
    await rm(root, { recursive: true, force: true })
  }
})

test('a Windows native absolute source is refused instead of joined under the remote cwd', async () => {
  const root = await tempDir()
  const previous = process.env.DSH_SSH_REMOTE_ROOT
  setRemoteRootOverride(root)
  try {
    const cwd = mapRemoteToLocal('prod1', '/srv/app')!
    const copy = copyApi()
    await assert.rejects(
      () => runSshCopy(copy.api, backup(), { source_path: 'C:\\data\\a.bin', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS, cwd),
      /Windows local paths are not remote paths/,
    )
    assert.deepEqual(copy.reads, [])
    assert.deepEqual(copy.modes, [])
  } finally {
    setRemoteRootOverride(null)
    if (previous === undefined) delete process.env.DSH_SSH_REMOTE_ROOT
    else process.env.DSH_SSH_REMOTE_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('a copy whose target connection fails never opens the source and still removes the temp', async () => {
  // `sftpSendChunks` can reject before `streamChunksToSftp` pulls a chunk, so
  // the source generator is never started and holds no handle. The invariant
  // worth pinning is that: nothing is left open, and the temp is cleaned up.
  let pulled = 0
  const copy = api({
    hosts: TWO_HOSTS,
    attrs: () => ({ type: 'file', size: 5 }),
    chunks: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next() { pulled += 1; return { done: true, value: undefined } },
          async return() { return { done: true, value: undefined } },
        }
      },
    }),
    sendChunks: async () => { throw new Error('target SFTP channel refused') },
  })
  await assert.rejects(
    () => runSshCopy(copy.api, backup(), { source_path: '/srv/release.tar.gz', source_host: 'prod1', target_path: '/backup/x' }, {}, selector => TWO_HOSTS.find(item => item.id === selector)!, LIMITS),
    /target SFTP channel refused/,
  )
  // The target channel must be open before the first source byte is read.
  assert.equal(pulled, 0)
  assert.match(copy.commands.join('\n'), /rm -f '\/backup\/\.dsh-permission-remote-[0-9a-f]+'/)
})


test('ssh_write resolves the target exactly once and uses it for the write', async () => {
  let realpaths = 0
  let execs = 0
  const pool = {
    async sftpRealpath(_h: unknown, _s: unknown, remotePath: string) { realpaths += 1; return remotePath },
    async sftpStat() { return { isDirectory: false, size: 3, mode: 0o644 } },
    async sftpRead() { return Buffer.from('old') },
    async exec(_h: unknown, _s: unknown, command: string) { execs += 1; return { code: 0, stdout: '', stderr: '' } },
  } as unknown as SshPool
  const api = { pool, secretOf: async () => ({}), resolveMode: async () => 'read-only' } as unknown as ToolHost
  await runSshWrite(api, host({ opsPolicy: 'trust' }), { file_path: '/srv/a.txt', content: 'new content' }, {})
  assert.equal(realpaths, 1, 'the target is resolved once, not once for the card and again for the write')
  assert.equal(execs, 1, 'the write goes through the resolved target')
})
