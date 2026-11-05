import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { HostConfig } from '../src/config.ts'
import type { ApprovalDetail, RunnerStatus, ToolHost } from '../src/execute.ts'
import {
  forgetOpsHost,
  NO_TRANSFER_LIMITS,
  renderOpsDownload,
  renderOpsUpload,
  runSshDownload,
  runSshUpload,
  type OpsTransferLimits,
} from '../src/ops.ts'
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
  execs: Array<{ command: string, timeoutMs: number | undefined }>
  reads: string[]
  attrs: Array<{ path: string, follow: boolean }>
  writes: Array<{ path: string, bytes: number }>
  modes: Array<[string | undefined, string | undefined, ApprovalDetail | undefined]>
}

/** A pool double for the two transfers. Everything else is a hard failure. */
function api(options: {
  mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  exec?: (command: string, stdin?: string | Buffer) => ExecResult
  remoteBytes?: Buffer
  attrs?: (path: string, follow: boolean) => Attrs | undefined
} = {}): TransferApi {
  // The home probe is cached per host id across tests; every fixture starts
  // from an unknown `$HOME`, so a hang override is actually exercised.
  forgetOpsHost('prod1')
  const commands: string[] = []
  const bodies: Array<string | Buffer | undefined> = []
  const execs: Array<{ command: string, timeoutMs: number | undefined }> = []
  const reads: string[] = []
  const attrs: Array<{ path: string, follow: boolean }> = []
  const writes: Array<{ path: string, bytes: number }> = []
  const modes: Array<[string | undefined, string | undefined, ApprovalDetail | undefined]> = []

  const pool = {
    exec: async (
      _host: HostConfig,
      _secret: unknown,
      command: string,
      timeoutMs?: number,
      _signal?: AbortSignal,
      stdin?: string | Buffer,
    ) => {
      // The override must be able to hang the home probe, so it comes before
      // the marked-home default.
      if (command.includes('"$HOME"')) return options.exec?.(command, stdin) ?? result({ stdout: markedHome })
      commands.push(command)
      bodies.push(stdin)
      execs.push({ command, timeoutMs })
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
  } as unknown as SshPool

  return {
    api: {
      pool,
      hostOf: id => id === 'prod1' ? host() : undefined,
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
  }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-transfer-'))
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
    assert.equal(upload.commands.length, 1)
    const script = upload.commands[0] ?? ''
    assert.match(script, /^mkdir -p .* && /)
    assert.match(script, /cat > '\/srv\/\.dsh-permission-remote-/)
    assert.match(script, /mv -f '\/srv\/\.dsh-permission-remote-[0-9a-f]+' '\/srv\/blob\.bin'/)
    const forwarded = upload.bodies[0]
    assert.ok(Buffer.isBuffer(forwarded))
    assert.deepEqual([...forwarded], [...body])
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
    assert.match(upload.commands[0] ?? '', /chmod 640 '\/srv\/a\.bin'/)
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
    const download = api({ attrs: () => ({ type: 'file', size: 1 }), remoteBytes: Buffer.alloc(10, 0x63) })
    await assert.rejects(
      () => runSshDownload(download.api, host({ opsPolicy: 'trust' }), { remote_path: '/srv/a.bin', local_path: join(local, 'b.bin') }, {}, { maxBytes: 4, timeoutMs: 0 }),
      (error: Error) => /over the 4 byte limit/.test(error.message) && !/no file at remote path/.test(error.message),
    )
  } finally {
    await rm(local, { recursive: true, force: true })
  }
})
