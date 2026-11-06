import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { RunnerStatus } from '../src/execute.ts'
import { installRemoteWorld } from '../src/remote-world.ts'
import { LocalTransport } from './helpers/local-ptc.ts'
import { mapRemoteToLocal } from '../src/router.ts'

function statusFor(root: string): RunnerStatus {
  return {
    os: 'linux',
    sandbox: { available: true, reason: 'ok' },
    sandboxTool: 'bwrap',
    ripgrep: 'system',
    ripgrepPath: '/usr/bin/rg',
    roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
    home: root,
    node: { available: true, path: '/usr/bin/node', version: '22.20.0', major: 22 },
    install: null,
  }
}

async function harness(): Promise<{
  root: string
  placeholder: string
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  close: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-exec-'))
  const placeholder = mapRemoteToLocal('h1', root)!
  const status = statusFor(root)
  const subprocess = {
    spawn: (..._args: unknown[]) => ({ marker: 'original-spawn' }),
    resolveExecutable: async (..._args: unknown[]) => process.execPath,
  }
  const sandbox = {
    confine: async (...args: unknown[]) => ({ argv: args[0] as readonly string[], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  }
  const ctx = { get: (name: string) => name === 'subprocess' ? subprocess : name === 'sandbox' ? sandbox : undefined }
  const restore = installRemoteWorld(ctx, {
    transport: new LocalTransport(),
    hostOf: () => ({
      id: 'h1', name: '', host: '127.0.0.1', port: 22, username: 'u', auth: 'key',
      privateKeyPath: '', fingerprint: '', opsPolicy: 'ask',
    }),
    secretOf: async () => ({}),
    statusOf: async () => status,
    routeByCwd: cwd => cwd === placeholder ? { kind: 'remote', hostId: 'h1', remoteCwd: root, placeholderCwd: placeholder } : { kind: 'local' },
  })
  assert.ok(restore !== undefined)
  return {
    root,
    placeholder,
    spawn: spec => subprocess.spawn(spec) as unknown as SubprocessHandle,
    close: async () => {
      restore!()
      await rm(root, { recursive: true, force: true })
    },
  }
}

function spec(cwd: string, overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['bash', '-c', 'printf out; printf err >&2'],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 },
      stderr: { maxBytes: 1024 },
    },
    graceMs: 1000,
    ...overrides,
  }
}

test('generic remote spawn collects stdout/stderr and maps the remote cwd', async () => {
  const h = await harness()
  try {
    const handle = h.spawn(spec(h.placeholder))
    const result = await handle.done
    assert.deepEqual(result, { exitCode: 0, signal: null })
    assert.equal(handle.collected.stdout?.readFrom(0).text, 'out')
    assert.equal(handle.collected.stderr?.readFrom(0).text, 'err')
    await handle.waitForExit()
  } finally {
    await h.close()
  }
})

test('small collected output does not create a local spill directory', async () => {
  const before = new Set(await readdir(tmpdir()))
  const h = await harness()
  try {
    const handle = h.spawn(spec(h.placeholder, {
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1024, spill: { maxBytes: 1024 } },
        stderr: { maxBytes: 1024, spill: { maxBytes: 1024 } },
      },
    }))
    await handle.done
    const after = await readdir(tmpdir())
    const created = after.filter(name => name.startsWith('dsh-remote-spill-') && !before.has(name))
    assert.deepEqual(created, [])
  } finally {
    await h.close()
  }
})

test('an overflowing spill holds the complete stream, and dropping it never reopens a partial one', async () => {
  const h = await harness()
  try {
    // 300 bytes with a 50-byte inline cap and a 150-byte spill cap. The spill
    // exceeds its cap on the third chunk, so it must be dropped — not rebuilt
    // from the already-truncated tail and advertised as the complete stream.
    const handle = h.spawn(spec(h.placeholder, {
      argv: ['bash', '-c', 'printf "%0100d" 1; printf "%0100d" 2; printf "%0100d" 3'],
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 50, spill: { maxBytes: 150 } },
        stderr: { maxBytes: 50 },
      },
    }))
    await handle.done
    const read = handle.collected.stdout!.readFrom(0)
    assert.equal(read.nextOffset, 300)
    assert.equal(read.lossy, true)
    assert.equal(read.spillPath, undefined, 'a discarded spill must not be advertised')
    assert.equal(Buffer.byteLength(read.text), 50)
  } finally {
    await h.close()
  }
})

test('a spill within its cap is advertised and holds every byte of the stream', async () => {
  const h = await harness()
  try {
    const handle = h.spawn(spec(h.placeholder, {
      argv: ['bash', '-c', 'printf AAAA; printf BBBB; printf CCCC; printf DDDD'],
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4, spill: { maxBytes: 1_000 } },
        stderr: { maxBytes: 4 },
      },
    }))
    await handle.done
    const read = handle.collected.stdout!.readFrom(0)
    assert.equal(read.nextOffset, 16)
    assert.equal(read.lossy, true)
    assert.ok(read.spillPath !== undefined, 'a complete spill must be advertised')
    assert.equal(await readFile(read.spillPath!, 'utf8'), 'AAAABBBBCCCCDDDD')
  } finally {
    await h.close()
  }
})

test('collected offsets count stream bytes even when the output is not valid UTF-8', async () => {
  const h = await harness()
  try {
    // printf emits the raw bytes 0x61 0xff 0x62; 0xff is not valid UTF-8 and
    // decodes to U+FFFD (three bytes), so a re-encoded offset would over-count.
    const handle = h.spawn(spec(h.placeholder, {
      argv: ['bash', '-c', String.raw`printf 'a\xffb'`],
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    }))
    await handle.done
    const read = handle.collected.stdout!.readFrom(0)
    assert.equal(read.nextOffset, 3, 'the cursor must match the bytes that arrived')
    assert.equal(read.lossy, false)
  } finally {
    await h.close()
  }
})

test('the retained tail is capped in bytes for multi-byte text', async () => {
  const h = await harness()
  try {
    // 30 four-byte emoji plus three ASCII bytes: a UTF-16-unit estimate keeps
    // far more than the cap and can split a surrogate pair.
    const handle = h.spawn(spec(h.placeholder, {
      argv: ['bash', '-c', 'printf "😀%.0s" $(seq 1 30); printf xyz'],
      stdio: { stdin: 'ignore', stdout: { maxBytes: 20 }, stderr: { maxBytes: 20 } },
    }))
    await handle.done
    const read = handle.collected.stdout!.readFrom(0)
    assert.equal(read.nextOffset, 123)
    assert.ok(Buffer.byteLength(read.text) <= 20, `tail must respect the byte cap, got ${Buffer.byteLength(read.text)}`)
    assert.equal(read.text.endsWith('xyz'), true)
  } finally {
    await h.close()
  }
})

test('overflowing streams share one spill directory instead of one per spawn', async () => {
  const h = await harness()
  try {
    // A spilled stream is retained as a recovery artifact, but the directory
    // itself must not be recreated per call: an unbounded per-spawn temp tree
    // is what turns a long session into disk residue.
    const paths: string[] = []
    for (let round = 0; round < 3; round += 1) {
      const handle = h.spawn(spec(h.placeholder, {
        argv: ['bash', '-c', `printf "%0100d" ${round}; printf "%0100d" ${round}`],
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 4, spill: { maxBytes: 1_000 } },
          stderr: { maxBytes: 4 },
        },
      }))
      await handle.done
      const spillPath = handle.collected.stdout!.readFrom(0).spillPath
      assert.ok(spillPath !== undefined)
      paths.push(spillPath)
    }
    const directories = new Set(paths.map(path => dirname(path)))
    assert.equal(directories.size, 1, `expected one shared spill directory, got ${[...directories].join(', ')}`)
    assert.equal(new Set(paths).size, 3, 'each stream keeps its own file')
    for (const path of paths) await rm(path, { force: true })
  } finally {
    await h.close()
  }
})

test('generic remote spawn forwards stdin data', async () => {
  const h = await harness()
  try {
    const handle = h.spawn(spec(h.placeholder, {
      argv: ['cat'],
      stdio: { stdin: { data: 'hello from stdin' }, stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    }))
    const result = await handle.done
    assert.deepEqual(result, { exitCode: 0, signal: null })
    assert.equal(handle.collected.stdout?.readFrom(0).text, 'hello from stdin')
  } finally {
    await h.close()
  }
})

test('generic remote spawn terminates on abort', async () => {
  const h = await harness()
  try {
    const controller = new AbortController()
    const handle = h.spawn(spec(h.placeholder, {
      argv: ['bash', '-c', 'printf before; sleep 2; printf after'],
      signal: controller.signal,
    }))
    setTimeout(() => controller.abort(), 500)
    const result = await handle.done
    assert.equal(result.signal === null || result.signal === 'SIGKILL' || result.signal === 'SIGTERM', true)
    assert.equal(handle.collected.stdout?.readFrom(0).text.includes('before'), true)
  } finally {
    await h.close()
  }
})

test('terminating before the SSH channel opens settles the handle instead of hanging', async () => {
  const h = await harness()
  try {
    const pending = h.spawn(spec(h.placeholder))
    pending.terminate()
    const result = await pending.done
    assert.equal(result.exitCode === null || result.signal !== null, true)
  } finally {
    await h.close()
  }
})
