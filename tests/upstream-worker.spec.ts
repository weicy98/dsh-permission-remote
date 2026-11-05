import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  locateUpstreamWorker,
  manifestEntryFor,
  probeContract,
  ptcShimSource,
  clearWorkerCache,
  ensureWorker,
  readWorkerManifest,
  writeOverlayManifest,
} from '../src/upstream-worker.ts'

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-upstream-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-fixture' }))
  const runtime = join(root, 'node_modules', '@deepseek-ai', 'dsh-ptc-runtime-node')
  const subprocess = join(root, 'node_modules', '@deepseek-ai', 'dsh-subprocess')
  await mkdir(join(runtime, 'lib'), { recursive: true })
  await mkdir(join(subprocess, 'lib'), { recursive: true })
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-ptc-runtime-node', version: '0.0.0-fixture' }))
  await writeFile(join(subprocess, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-subprocess', version: '0.0.0-fixture' }))
  await writeFile(join(runtime, 'lib', 'process.js'), [
    'import { Socket } from "node:net";',
    'const SUBPROCESS_CONTROL_ENV = "DSH_SUBPROCESS_CONTROL";',
    'const channel = new Socket({ fd: 7, readable: true, writable: true });',
    'function openInheritedControlChannel() { return channel }',
    'async function runNodeMain(stream, max, processState) { processState.chdir("/tmp") }',
    'runNodeMain(openInheritedControlChannel(), Number(process.argv[2]), process);',
  ].join('\n'))
  await writeFile(join(runtime, 'lib', 'persistent-process.js'), [
    'import { Socket } from "node:net";',
    'function openInheritedControlChannel() { return new Socket({ fd: 7 }) }',
    'async function runPersistentMain(stream, max, processState) {}',
    'runPersistentMain(openInheritedControlChannel(), Number(process.argv[2]), process);',
  ].join('\n'))
  await writeFile(join(runtime, 'lib', 'index.js'), [
    'const result = fs.processPathFromHostPath(path);',
    'return [mapped(fileURLToPath(new URL("./process.js", import.meta.url))), String(maxMessageBytes)];',
    'const handle = this.ctx.subprocess.spawn({ stdio: { control: "pipe" } });',
  ].join('\n'))
  await writeFile(join(subprocess, 'lib', 'control.js'), [
    'const SUBPROCESS_CONTROL_FD = 7;',
    'const SUBPROCESS_CONTROL_ENV = "DSH_SUBPROCESS_CONTROL";',
  ].join('\n'))
  return root
}

test('the locator reads the installed runtime and its contract', async () => {
  const root = await fixture()
  try {
    clearWorkerCache()
    const worker = locateUpstreamWorker({ DSH_INSTALL_ROOT: root }, { allowUnverified: true })
    assert.equal(worker.dshVersion, '0.0.0-fixture')
    assert.equal(worker.runtimeVersion, '0.0.0-fixture')
    assert.equal(worker.dshSubprocessVersion, '0.0.0-fixture')
    assert.equal(worker.processPath.endsWith('lib/process.js'), true)
    const probes = probeContract(worker)
    assert.deepEqual(probes.failures, [])
    assert.equal(probes.controlFd, 7)
    assert.equal(probes.controlEnv, 'DSH_SUBPROCESS_CONTROL')
    const entry = manifestEntryFor(worker)
    assert.equal(entry.processSha256.length, 64)
    assert.equal(entry.probes.entry, true)
    assert.equal(entry.probes.persistentEntry, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing DSH root is an actionable error, not a fallback', () => {
  assert.throws(() => locateUpstreamWorker({ DSH_INSTALL_ROOT: '/definitely/not/a/dsh/root' }, { allowUnverified: true }), /cannot locate the installed @deepseek-ai\/dsh package/u)
})

test('the packaged shim source is available beside src or lib', () => {
  assert.match(ptcShimSource(), /__DSH_PTC_READY__/u)
})


test('ensureWorker uploads process.mjs and the shim once per digest', async () => {
  const root = await fixture()
  const previous = process.env.DSH_INSTALL_ROOT
  process.env.DSH_INSTALL_ROOT = root
  clearWorkerCache()
  const files = new Map<string, Buffer>()
  const writes: string[] = []
  const pool = {
    async exec(_host: unknown, _secret: unknown, command: string) {
      if (command.includes('sha256sum ')) {
        const match = /sha256sum '([^']+)'/u.exec(command)
        const body = match === null ? undefined : files.get(match[1]!)
        if (body === undefined) return { code: 1, stdout: '', stderr: '', timedOut: false, signal: null, stdoutTruncated: false, stderrTruncated: false }
        const { createHash } = await import('node:crypto')
        return { code: 0, stdout: `${createHash('sha256').update(body).digest('hex')}  ${match![1]}\n`, stderr: '', timedOut: false, signal: null, stdoutTruncated: false, stderrTruncated: false }
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false, signal: null, stdoutTruncated: false, stderrTruncated: false }
    },
    async sftpWrite(_host: unknown, _secret: unknown, path: string, body: Buffer | string) {
      writes.push(path)
      files.set(path, Buffer.from(body))
    },
    async sftpRename(_host: unknown, _secret: unknown, from: string, to: string) {
      const body = files.get(from)
      if (body === undefined) throw new Error('missing temp')
      files.delete(from)
      files.set(to, body)
    },
  } as never
  try {
    const first = await ensureWorker(pool, { id: 'h1' } as never, {}, '/home/dev', undefined, { allowUnverified: true })
    assert.equal(first.workerRemotePath.endsWith('/process.mjs'), true)
    assert.equal(first.shimRemotePath.endsWith('/ptc-shim.mjs'), true)
    const firstWrites = writes.length
    const second = await ensureWorker(pool, { id: 'h1' } as never, {}, '/home/dev', undefined, { allowUnverified: true })
    assert.equal(second.digest, first.digest)
    assert.equal(writes.length, firstWrites)
  } finally {
    clearWorkerCache()
    if (previous === undefined) delete process.env.DSH_INSTALL_ROOT
    else process.env.DSH_INSTALL_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})


test('a host-local overlay manifest extends the package baseline without rebuilding', async () => {
  const root = await fixture()
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-overlay-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const worker = locateUpstreamWorker({ DSH_INSTALL_ROOT: root }, { allowUnverified: true })
    const entry = manifestEntryFor(worker)
    const path = writeOverlayManifest({ contractVersion: 1, verified: [entry] })
    assert.equal(path, join(home, 'permission-remote', 'upstream-ptc.manifest.json'))
    const merged = readWorkerManifest()
    assert.equal(merged.verified.some(item => item.dshVersion === entry.dshVersion && item.processSha256 === entry.processSha256), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})


test('a manifest entry matches by worker bytes, not the DSH version label', async () => {
  const root = await fixture()
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-bytes-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const worker = locateUpstreamWorker({ DSH_INSTALL_ROOT: root }, { allowUnverified: true })
    const entry = { ...manifestEntryFor(worker), dshVersion: '9.9.9', ptcRuntimeNodeVersion: '9.9.9' }
    writeOverlayManifest({ contractVersion: 1, verified: [entry] })
    const accepted = locateUpstreamWorker({ DSH_INSTALL_ROOT: root })
    assert.equal(accepted.processHash, worker.processHash)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})


test('a DSH root without the runtime package does not fall back to the plugin dev dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ptc-empty-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-fixture' }))
  try {
    assert.throws(
      () => locateUpstreamWorker({ DSH_INSTALL_ROOT: root }, { allowUnverified: true }),
      /does not contain @deepseek-ai\/dsh-ptc-runtime-node/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
