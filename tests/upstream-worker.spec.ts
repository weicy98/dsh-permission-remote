import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  nodeSupportsWorker,
  readWorkerManifest,
  writeOverlayManifest,
} from '../src/upstream-worker.ts'
import { PTC_MIN_NODE_MODULE_HOOKS_MINOR } from '../src/probe.ts'

async function fixture(options: { moduleHooks?: boolean, vmModules?: boolean, vmModulesFlag?: boolean } = {}): Promise<string> {
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
    ...options.moduleHooks === true ? ['import { registerHooks, syncBuiltinESMExports } from "node:module";'] : [],
    ...options.vmModules === true ? ['const SourceModule = vm.SourceTextModule;'] : [],
    'const SUBPROCESS_CONTROL_ENV = "DSH_SUBPROCESS_CONTROL";',
    'const channel = new Socket({ fd: 7, readable: true, writable: true });',
    'function openInheritedControlChannel() { return channel }',
    'async function runNodeMain(stream, max, processState) { processState.chdir("/tmp") }',
    'runNodeMain(openInheritedControlChannel(), Number(process.argv[2]), process);',
  ].join('\n'))
  await writeFile(join(runtime, 'lib', 'index.js'), [
    'const result = fs.processPathFromHostPath(path);',
    ...options.vmModulesFlag === true
      ? ['function bootstrapArgs(kind) { switch (kind) { case "node-script": return ["--experimental-vm-modules", "x"]; default: return []; } }']
      : [],
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


test('unrecorded bytes name the installed-host command and never --update', async () => {
  const root = await fixture()
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-unrecorded-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // An empty overlay means nothing is recorded, so the strict path must throw.
    assert.throws(
      () => locateUpstreamWorker({ DSH_INSTALL_ROOT: root }),
      (error: Error) => {
        const message = error.message
        assert.match(message, /adapt:upstream/u, 'the installed-host command must be offered')
        assert.match(message, /upgrade:ptc/u, 'the source-checkout command must be offered')
        // `--update` writes inside the package, which is read-only when
        // installed; suggesting it would be a dead end.
        assert.doesNotMatch(message, /--update/u, 'the message must not suggest rewriting the package manifest')
        assert.doesNotMatch(message, /vendor\/upstream/u, 'the read-only package path must not be named')
        return true
      },
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(root, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
})


test('the rc.2 module-hooks worker raises the Node minor floor from its own bytes', async () => {
  const root = await fixture({ moduleHooks: true, vmModules: true, vmModulesFlag: true })
  try {
    const worker = locateUpstreamWorker({ DSH_INSTALL_ROOT: root }, { allowUnverified: true })
    const probes = probeContract(worker)
    assert.equal(probes.requiresModuleHooks, true)
    assert.equal(probes.nodeScriptVmModules, true)
    assert.equal(probes.minimumNodeMinor, PTC_MIN_NODE_MODULE_HOOKS_MINOR)
    assert.equal(worker.minimumNodeMinor, PTC_MIN_NODE_MODULE_HOOKS_MINOR)
    assert.equal(manifestEntryFor(worker).minimumNodeMinor, PTC_MIN_NODE_MODULE_HOOKS_MINOR)
    assert.deepEqual(probes.failures, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a module-hooks worker without the vm-modules bootstrap flag fails the probe', async () => {
  const root = await fixture({ moduleHooks: true, vmModules: true })
  try {
    assert.throws(
      () => locateUpstreamWorker({ DSH_INSTALL_ROOT: root }, { allowUnverified: true }),
      /--experimental-vm-modules/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a NODE_OPTIONS mention alone does not satisfy the vm-modules bootstrap probe', async () => {
  // The shim resets the environment to PATH/TEMP/TMP, so the flag must be in
  // the bootstrap argv; a stray NODE_OPTIONS assignment elsewhere is not enough.
  const root = await fixture({ moduleHooks: true, vmModules: true })
  try {
    const indexPath = join(root, 'node_modules', '@deepseek-ai', 'dsh-ptc-runtime-node', 'lib', 'index.js')
    await writeFile(indexPath, `${await readFile(indexPath, 'utf8')}\nconst env = { NODE_OPTIONS: "--experimental-vm-modules" };\n`)
    assert.throws(
      () => locateUpstreamWorker({ DSH_INSTALL_ROOT: root }, { allowUnverified: true }),
      /--experimental-vm-modules/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an rc.1-style worker keeps the Node 22 floor', async () => {
  const root = await fixture()
  try {
    const worker = locateUpstreamWorker({ DSH_INSTALL_ROOT: root }, { allowUnverified: true })
    assert.equal(probeContract(worker).requiresModuleHooks, false)
    assert.equal(probeContract(worker).minimumNodeMinor, 0)
    assert.equal(manifestEntryFor(worker).minimumNodeMinor, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('nodeSupportsWorker accepts 22.15+ and newer majors, refuses 22.14 and 21', () => {
  const floor = PTC_MIN_NODE_MODULE_HOOKS_MINOR
  assert.equal(nodeSupportsWorker({ version: '22.15.0', major: 22, minor: 15 }, floor), true)
  assert.equal(nodeSupportsWorker({ version: '22.20.0', major: 22, minor: 20 }, floor), true)
  assert.equal(nodeSupportsWorker({ version: '23.5.0', major: 23, minor: 5 }, floor), true)
  assert.equal(nodeSupportsWorker({ version: '23.4.0', major: 23, minor: 4 }, floor), false)
  assert.equal(nodeSupportsWorker({ version: '24.1.0', major: 24, minor: 1 }, floor), true)
  assert.equal(nodeSupportsWorker({ version: '22.14.0', major: 22, minor: 14 }, floor), false)
  assert.equal(nodeSupportsWorker({ version: '21.7.0', major: 21, minor: 7 }, floor), false)
  // A probe that only reported the major cannot prove the rc.2 API exists.
  assert.equal(nodeSupportsWorker({ version: '22', major: 22 }, floor), false)
  assert.equal(nodeSupportsWorker({ version: '23', major: 23 }, floor), false)
  assert.equal(nodeSupportsWorker({ version: '22.0.0', major: 22, minor: 0 }, 0), true)
  assert.equal(nodeSupportsWorker({ version: '23.0.0', major: 23, minor: 0 }, 0), true)
})

test('ensureWorker refuses a remote Node older than the uploaded worker needs', async () => {
  const root = await fixture({ moduleHooks: true, vmModules: true, vmModulesFlag: true })
  const previous = process.env.DSH_INSTALL_ROOT
  process.env.DSH_INSTALL_ROOT = root
  clearWorkerCache()
  try {
    await assert.rejects(
      () => ensureWorker({} as never, { id: 'h1', host: '10.0.0.1' } as never, {}, '/home/dev', undefined, {
        allowUnverified: true,
        remoteNode: { version: '22.14.0', major: 22, minor: 14 },
      }),
      /requires Node\.js 22\.15 or newer/u,
    )
  } finally {
    clearWorkerCache()
    if (previous === undefined) delete process.env.DSH_INSTALL_ROOT
    else process.env.DSH_INSTALL_ROOT = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('an rc.2 overlay written before minimumNodeMinor existed still matches', async () => {
  const root = await fixture({ moduleHooks: true, vmModules: true, vmModulesFlag: true })
  const home = await mkdtemp(join(tmpdir(), 'dsh-ptc-legacy-overlay-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const worker = locateUpstreamWorker({ DSH_INSTALL_ROOT: root }, { allowUnverified: true })
    const entry = { ...manifestEntryFor(worker) } as Record<string, unknown>
    delete entry.minimumNodeMinor
    writeOverlayManifest({ contractVersion: 1, verified: [entry as never] })
    // Without allowUnverified the manifest must accept the legacy entry by
    // worker bytes; its missing floor is unrecorded, not proof of rc.1.
    const located = locateUpstreamWorker({ DSH_INSTALL_ROOT: root })
    assert.equal(located.dshVersion, '0.0.0-fixture')
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
