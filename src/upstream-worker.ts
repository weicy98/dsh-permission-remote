/**
 * Locate, verify and upload the host's official Node PTC worker.
 *
 * The plugin never vendors `process.js`: it reads the package that the running
 * DSH installation actually uses, hashes it, and places the exact bytes under
 * the remote user's home. A manifest pins the contract that was verified by the
 * test suite; an unknown version or hash is a hard error with a runbook hint.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shJoin } from './shell-quote.ts'
import type { HostConfig } from './config.ts'
import type { SecretMaterial, SshPool } from './ssh-pool.ts'

export const PTC_ADAPTER_VERSION = '1'
export const PTC_MIN_REMOTE_NODE_MAJOR = 22
const WORKER_FILE = 'process.mjs'
const PERSISTENT_WORKER_FILE = 'persistent-process.mjs'
const SHIM_FILE = 'ptc-shim.mjs'

export interface UpstreamWorker {
  readonly dshVersion: string
  readonly runtimeVersion: string
  readonly dshSubprocessVersion: string
  readonly packageRoot: string
  readonly processPath: string
  readonly processSource: Buffer
  readonly persistentProcessPath: string
  readonly persistentProcessSource: Buffer
  readonly indexSource: Buffer
  readonly controlSource: Buffer
  readonly processHash: string
  readonly persistentProcessHash: string
  readonly indexHash: string
  readonly controlHash: string
}

export interface ContractProbe {
  readonly entry: boolean
  readonly persistentEntry: boolean
  readonly importsOnlyNode: boolean
  readonly controlFd: number | undefined
  readonly controlEnv: string | undefined
  readonly bootstrapArgsMapsHostPath: boolean
  readonly spawnControlPipe: boolean
  readonly failures: readonly string[]
}

export interface ManifestEntry {
  readonly dshVersion: string
  readonly ptcRuntimeNodeVersion: string
  readonly dshSubprocessVersion: string
  readonly processSha256: string
  readonly persistentProcessSha256: string
  readonly indexSha256: string
  readonly controlSha256: string
  readonly controlFd: number | undefined
  readonly controlEnv: string | undefined
  readonly minimumNodeMajor: number
  readonly probes: {
    readonly entry: boolean
    readonly persistentEntry: boolean
    readonly importsOnlyNode: boolean
    readonly bootstrapArgsMapsHostPath: boolean
    readonly spawnControlPipe: boolean
  }
}

export interface WorkerManifest {
  readonly contractVersion: 1
  readonly verified: readonly ManifestEntry[]
}

export interface UploadedWorker {
  readonly workerLocalPaths: readonly string[]
  readonly workerRemotePath: string
  readonly persistentWorkerRemotePath: string
  readonly shimRemotePath: string
  readonly digest: string
}

interface LocateOptions {
  /** Used by `check:upstream` so it can report drift instead of throwing first. */
  readonly allowUnverified?: boolean
}

export function packageManifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'vendor', 'upstream', 'ptc-worker.manifest.json'),
    join(here, 'vendor', 'upstream', 'ptc-worker.manifest.json'),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!
}

/** Writable per-install overlays; `adapt:upstream` uses this instead of the package manifest. */
export function overlayManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'permission-remote', 'upstream-ptc.manifest.json')
}

function readEntries(path: string): ManifestEntry[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkerManifest>
    return Array.isArray(raw.verified) ? raw.verified as ManifestEntry[] : []
  } catch {
    return []
  }
}

export function readWorkerManifest(): WorkerManifest {
  // The package manifest is the release baseline; a host-local overlay records
  // versions adapted on an already-installed host without rewriting the package.
  // Read both on every lookup so `adapt:upstream` takes effect without a restart.
  const merged = new Map<string, ManifestEntry>()
  for (const entry of [...readEntries(packageManifestPath()), ...readEntries(overlayManifestPath())]) {
    merged.set(`${entry.dshVersion}\0${entry.ptcRuntimeNodeVersion}\0${entry.processSha256}`, entry)
  }
  return { contractVersion: 1, verified: [...merged.values()] }
}

export function writeWorkerManifest(manifest: WorkerManifest, path: string = packageManifestPath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

export function writeOverlayManifest(manifest: WorkerManifest, env: NodeJS.ProcessEnv = process.env): string {
  const path = overlayManifestPath(env)
  writeWorkerManifest(manifest, path)
  return path
}

function isPackageRoot(path: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as { name?: unknown }
    return value.name === '@deepseek-ai/dsh'
  } catch {
    return false
  }
}

function candidateDshRoots(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = []
  const explicit = env.DSH_INSTALL_ROOT?.trim()
  if (explicit !== undefined && explicit.length > 0) {
    roots.push(resolve(explicit), resolve(explicit, 'node_modules', '@deepseek-ai', 'dsh'))
  }
  const starts = new Set<string>()
  const argv1 = process.argv[1]
  if (argv1 !== undefined) {
    try {
      starts.add(dirname(realpathSync(argv1)))
    } catch {
      starts.add(dirname(resolve(argv1)))
    }
  }
  // Global npm installs put DSH at <node>/../lib/node_modules/@deepseek-ai/dsh.
  starts.add(dirname(process.execPath))
  for (const start of starts) {
    let cursor = start
    for (let index = 0; index < 8; index += 1) {
      roots.push(join(cursor, 'node_modules', '@deepseek-ai', 'dsh'))
      roots.push(join(cursor, '@deepseek-ai', 'dsh'))
      roots.push(join(cursor, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
      roots.push(cursor)
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }
  return [...new Set(roots)]
}

function resolvePackageJson(specifier: string, fromDir: string): string | undefined {
  try {
    const require = createRequire(join(fromDir, '__dsh_resolve__.js'))
    return require.resolve(specifier, { paths: [fromDir] })
  } catch {
    return undefined
  }
}

function findDshRoot(env: NodeJS.ProcessEnv): { root: string, version: string } {
  const explicit = env.DSH_INSTALL_ROOT?.trim()
  const candidates = explicit !== undefined && explicit.length > 0
    ? [resolve(explicit), resolve(explicit, 'node_modules', '@deepseek-ai', 'dsh')]
    : candidateDshRoots(env)
  for (const candidate of candidates) {
    if (!isPackageRoot(candidate)) continue
    try {
      const version = (JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as { version?: unknown }).version
      return { root: candidate, version: typeof version === 'string' ? version : 'unknown' }
    } catch {
      // Try the next candidate.
    }
  }
  // Development fallback: the plugin's own install tree may contain the
  // runtime package as a dev dependency. This is never used for the worker
  // bytes when a real DSH root was found above.
  const dev = resolvePackageJson('@deepseek-ai/dsh/package.json', dirname(fileURLToPath(import.meta.url)))
  if (dev !== undefined) {
    const root = dirname(dev)
    try {
      const version = (JSON.parse(readFileSync(dev, 'utf8')) as { version?: unknown }).version
      return { root, version: typeof version === 'string' ? version : 'unknown' }
    } catch {
      // Fall through to the diagnostic below.
    }
  }
  throw new Error(
    `cannot locate the installed @deepseek-ai/dsh package; set DSH_INSTALL_ROOT to the DSH package root. Tried: ${candidateDshRoots(env).join(', ') || '(none)'}`,
  )
}

function locateRuntimePackage(dshRoot: string): string {
  const direct = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-ptc-runtime-node', 'package.json')
  if (existsSync(direct)) return direct
  const resolved = resolvePackageJson('@deepseek-ai/dsh-ptc-runtime-node/package.json', dshRoot)
  if (resolved !== undefined) return resolved
  const dev = resolvePackageJson('@deepseek-ai/dsh-ptc-runtime-node/package.json', dirname(fileURLToPath(import.meta.url)))
  if (dev !== undefined) return dev
  throw new Error(
    `the installed DSH at ${dshRoot} does not contain @deepseek-ai/dsh-ptc-runtime-node; remote run_code requires that package. Install a DSH build with Node PTC support.`,
  )
}

function locateSubprocessPackage(dshRoot: string): string {
  const direct = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-subprocess', 'package.json')
  if (existsSync(direct)) return direct
  const resolved = resolvePackageJson('@deepseek-ai/dsh-subprocess/package.json', dshRoot)
  if (resolved !== undefined) return resolved
  throw new Error(`cannot locate @deepseek-ai/dsh-subprocess under ${dshRoot}; the PTC control-channel contract cannot be verified`)
}

function versionOf(packageJsonPath: string): string {
  try {
    const value = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown }
    return typeof value.version === 'string' ? value.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function hashesFor(worker: UpstreamWorker): ManifestEntry {
  const probes = probeContract(worker)
  return {
    dshVersion: worker.dshVersion,
    ptcRuntimeNodeVersion: worker.runtimeVersion,
    dshSubprocessVersion: worker.dshSubprocessVersion,
    processSha256: worker.processHash,
    persistentProcessSha256: worker.persistentProcessHash,
    indexSha256: worker.indexHash,
    controlSha256: worker.controlHash,
    controlFd: probes.controlFd,
    controlEnv: probes.controlEnv,
    minimumNodeMajor: PTC_MIN_REMOTE_NODE_MAJOR,
    probes: {
      entry: probes.entry,
      persistentEntry: probes.persistentEntry,
      importsOnlyNode: probes.importsOnlyNode,
      bootstrapArgsMapsHostPath: probes.bootstrapArgsMapsHostPath,
      spawnControlPipe: probes.spawnControlPipe,
    },
  }
}

export function locateUpstreamWorker(env: NodeJS.ProcessEnv = process.env, options: LocateOptions = {}): UpstreamWorker {
  const { root: dshRoot, version: dshVersion } = findDshRoot(env)
  const runtimePackageJson = locateRuntimePackage(dshRoot)
  const subprocessPackageJson = locateSubprocessPackage(dshRoot)
  const packageRoot = dirname(runtimePackageJson)
  const read = (name: string): Buffer => readFileSync(join(packageRoot, name))
  const processSource = read('lib/process.js')
  const persistentProcessSource = read('lib/persistent-process.js')
  const indexSource = read('lib/index.js')
  const controlSource = readFileSync(join(dirname(subprocessPackageJson), 'lib', 'control.js'))
  const worker: UpstreamWorker = {
    dshVersion,
    runtimeVersion: versionOf(runtimePackageJson),
    dshSubprocessVersion: versionOf(subprocessPackageJson),
    packageRoot,
    processPath: join(packageRoot, 'lib', 'process.js'),
    processSource,
    persistentProcessPath: join(packageRoot, 'lib', 'persistent-process.js'),
    persistentProcessSource,
    indexSource,
    controlSource,
    processHash: hash(processSource),
    persistentProcessHash: hash(persistentProcessSource),
    indexHash: hash(indexSource),
    controlHash: hash(controlSource),
  }
  const probes = probeContract(worker)
  if (probes.failures.length > 0) {
    throw new Error(`the installed PTC worker does not match the expected contract: ${probes.failures.join('; ')}. See docs/upstream-ptc-worker.md`)
  }
  if (options.allowUnverified !== true) {
    const manifest = readWorkerManifest()
    const expected = manifest.verified.find(entry => entry.dshVersion === worker.dshVersion
      && entry.ptcRuntimeNodeVersion === worker.runtimeVersion
      && entry.processSha256 === worker.processHash
      && entry.persistentProcessSha256 === worker.persistentProcessHash
      && entry.indexSha256 === worker.indexHash
      && entry.controlSha256 === worker.controlHash)
    if (expected === undefined) {
      throw new Error(
        `the installed PTC worker (DSH ${worker.dshVersion}, runtime ${worker.runtimeVersion}) is not in vendor/upstream/ptc-worker.manifest.json. Run \`npm run check:upstream -- --update\` after the offline and live e2e suites pass.`,
      )
    }
  }
  return worker
}

export function probeContract(worker: UpstreamWorker): ContractProbe {
  const processText = worker.processSource.toString('utf8')
  const indexText = worker.indexSource.toString('utf8')
  const controlText = worker.controlSource.toString('utf8')
  const entry = /runNodeMain\s*\(\s*openInheritedControlChannel\s*\(\s*\)\s*,\s*Number\s*\(\s*process\.argv\[2\]\s*\)\s*,\s*process\s*\)/u.test(processText)
  const persistentEntry = /runPersistentMain\s*\(\s*openInheritedControlChannel\s*\(\s*\)\s*,\s*Number\s*\(\s*process\.argv\[2\]\s*\)\s*,\s*process\s*\)/u.test(worker.persistentProcessSource.toString('utf8'))
  const importLines = processText.split(/\r?\n/u).filter(line => /^\s*import\s/u.test(line))
  const importsOnlyNode = importLines.length > 0 && importLines.every(line => /from\s+['"]node:/u.test(line))
  const controlFdMatch = /fd\s*:\s*7/u.exec(processText) ?? /SUBPROCESS_CONTROL_FD\s*=\s*7/u.exec(controlText)
  const controlEnvMatch = /SUBPROCESS_CONTROL_ENV\s*=\s*['"]([^'"]+)['"]/u.exec(processText) ?? /SUBPROCESS_CONTROL_ENV\s*=\s*['"]([^'"]+)['"]/u.exec(controlText)
  const bootstrapArgsMapsHostPath = /processPathFromHostPath\s*\(/u.test(indexText) && /process\.js/u.test(indexText)
  const spawnControlPipe = /control\s*:\s*['"]pipe['"]/u.test(indexText)
  const failures: string[] = []
  if (!entry) failures.push('process.js entry line changed')
  if (!persistentEntry) failures.push('persistent-process.js entry line changed')
  if (!importsOnlyNode) failures.push('process.js imports a non-Node module')
  if (controlFdMatch === null) failures.push('fd 7 control descriptor not found')
  if (controlEnvMatch === null) failures.push('DSH_SUBPROCESS_CONTROL marker not found')
  if (!bootstrapArgsMapsHostPath) failures.push('bootstrapArgs no longer maps process.js through fs.processPathFromHostPath')
  if (!spawnControlPipe) failures.push('subprocess.spawn no longer requests a control pipe')
  return {
    entry,
    persistentEntry,
    importsOnlyNode,
    controlFd: controlFdMatch === null ? undefined : 7,
    controlEnv: controlEnvMatch?.[1],
    bootstrapArgsMapsHostPath,
    spawnControlPipe,
    failures,
  }
}

export function manifestEntryFor(worker: UpstreamWorker): ManifestEntry {
  return hashesFor(worker)
}

export function ptcShimSource(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, SHIM_FILE), join(here, '..', 'src', SHIM_FILE), join(here, 'src', SHIM_FILE)]) {
    try {
      return readFileSync(candidate, 'utf8')
    } catch {
      // Try the next packaging layout.
    }
  }
  throw new Error('src/ptc-shim.mjs is missing from the plugin package')
}

const uploadCache = new Map<string, Promise<UploadedWorker>>()

export function clearWorkerCache(): void {
  uploadCache.clear()
}

function abortError(signal?: AbortSignal): Error {
  const error = new Error('PTC worker upload aborted')
  error.name = 'AbortError'
  if (signal?.reason !== undefined) error.cause = signal.reason
  return error
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError(signal)
}

async function remoteSha256(pool: SshPool, host: HostConfig, secret: SecretMaterial, remotePath: string): Promise<string> {
  const result = await pool.exec(host, secret, `(sha256sum ${shJoin([remotePath])} || shasum -a 256 ${shJoin([remotePath])}) 2>/dev/null || true`, 10_000)
  return result.stdout.trim().split(/\s+/u)[0] ?? ''
}

async function uploadFile(
  pool: SshPool,
  host: HostConfig,
  secret: SecretMaterial,
  remotePath: string,
  body: Buffer,
  expectedHash: string,
  signal?: AbortSignal,
): Promise<void> {
  assertNotAborted(signal)
  if (await remoteSha256(pool, host, secret, remotePath) === expectedHash) return
  const temporary = `${remotePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await pool.sftpWrite(host, secret, temporary, body)
    if (await remoteSha256(pool, host, secret, temporary) !== expectedHash) {
      throw new Error(`uploaded ${remotePath} did not match its local hash`)
    }
    await pool.exec(host, secret, `chmod 600 ${shJoin([temporary])}`, 15_000)
    await pool.sftpRename(host, secret, temporary, remotePath)
  } catch (error) {
    await pool.exec(host, secret, `rm -f ${shJoin([temporary])}`, 10_000).catch(() => undefined)
    throw error
  }
}

export interface EnsureWorkerOptions {
  readonly allowUnverified?: boolean
}

export async function ensureWorker(
  pool: SshPool,
  host: HostConfig,
  secret: SecretMaterial,
  home: string,
  signal?: AbortSignal,
  options: EnsureWorkerOptions = {},
): Promise<UploadedWorker> {
  if (!home.startsWith('/')) throw new Error('the remote did not report an absolute home, so the PTC worker cannot be placed there')
  const worker = locateUpstreamWorker(process.env, options)
  const shimSource = ptcShimSource()
  const digest = createHash('sha256')
    .update(worker.processSource)
    .update(worker.persistentProcessSource)
    .update(shimSource)
    .update(PTC_ADAPTER_VERSION)
    .digest('hex')
  const cacheKey = `${host.id}\0${host.host}\0${String(host.port)}\0${home}\0${digest}`
  const cached = uploadCache.get(cacheKey)
  if (cached !== undefined) return cached
  const pending = (async () => {
    const directory = `${home.replace(/\/+$/u, '')}/.dsh-permission-remote/ptc/${digest}`
    await pool.exec(host, secret, `mkdir -p ${shJoin([directory])} && chmod 700 ${shJoin([directory])}`, 20_000)
    const workerRemotePath = `${directory}/${WORKER_FILE}`
    const persistentWorkerRemotePath = `${directory}/${PERSISTENT_WORKER_FILE}`
    const shimRemotePath = `${directory}/${SHIM_FILE}`
    await uploadFile(pool, host, secret, workerRemotePath, worker.processSource, worker.processHash, signal)
    await uploadFile(pool, host, secret, persistentWorkerRemotePath, worker.persistentProcessSource, worker.persistentProcessHash, signal)
    await uploadFile(pool, host, secret, shimRemotePath, Buffer.from(shimSource, 'utf8'), hash(Buffer.from(shimSource, 'utf8')), signal)
    const localPaths = new Set<string>([resolve(worker.processPath)])
    try {
      localPaths.add(resolve(realpathSync(worker.processPath)))
    } catch {
      // The package may be inside a virtual filesystem; the lexical path is enough.
    }
    return {
      workerLocalPaths: [...localPaths],
      workerRemotePath,
      persistentWorkerRemotePath,
      shimRemotePath,
      digest,
    }
  })()
  uploadCache.set(cacheKey, pending)
  pending.catch(() => {
    if (uploadCache.get(cacheKey) === pending) uploadCache.delete(cacheKey)
  })
  return pending
}

