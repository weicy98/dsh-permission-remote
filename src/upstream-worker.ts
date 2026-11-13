/**
 * Locate, verify and upload the host's official Node PTC worker.
 *
 * The plugin never vendors `process.js`: it reads the package that the running
 * DSH installation actually uses, hashes it, and places the exact bytes under
 * the remote user's home. A manifest pins the contract that was verified by the
 * test suite; an unknown version or hash is a hard error with a runbook hint.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PTC_MIN_NODE_MAJOR, PTC_MIN_NODE_MODULE_HOOKS_MINOR, PTC_MIN_NODE_MODULE_HOOKS_MINOR_NEXT } from './probe.ts'
import { shJoin } from './shell-quote.ts'
import type { HostConfig } from './config.ts'
import type { SecretMaterial, SshPool } from './ssh-pool.ts'

/**
 * Bump whenever the remote adapter contract (shim argv/handshake/control
 * framing) changes. The upload digest already includes the shim bytes, so this
 * is not what makes a new shim distinguishable; it is the human-readable marker
 * for "the adapter moved, not the worker", and it partitions the upload cache.
 */
export const PTC_ADAPTER_VERSION = '2'
export const PTC_MIN_REMOTE_NODE_MAJOR = PTC_MIN_NODE_MAJOR
const PTC_CONTROL_ENV = 'DSH_SUBPROCESS_CONTROL'
const WORKER_FILE = 'process.mjs'
const SHIM_FILE = 'ptc-shim.mjs'

export interface UpstreamWorker {
  readonly dshVersion: string
  readonly runtimeVersion: string
  readonly dshSubprocessVersion: string
  readonly packageRoot: string
  readonly processPath: string
  readonly processSource: Buffer
  readonly indexSource: Buffer
  readonly controlSource: Buffer
  readonly processHash: string
  readonly indexHash: string
  readonly controlHash: string
  /** Minor version floor within Node 22, derived from the worker's own imports. */
  readonly minimumNodeMinor: number
}

export interface ContractProbe {
  readonly entry: boolean
  readonly importsOnlyNode: boolean
  readonly controlFd: number | undefined
  readonly controlEnv: string | undefined
  readonly bootstrapArgsMapsHostPath: boolean
  readonly spawnControlPipe: boolean
  /** The worker imports node:module registerHooks, so it needs Node >= 22.15. */
  readonly requiresModuleHooks: boolean
  /** The worker uses vm.SourceTextModule/SyntheticModule, so the runner needs the vm-modules flag. */
  readonly requiresVmModules: boolean
  /** node-script bootstrapArgs still passes --experimental-vm-modules. */
  readonly nodeScriptVmModules: boolean
  /** Minor version floor within the supported Node major, derived from imports. */
  readonly minimumNodeMinor: number
  readonly failures: readonly string[]
}

export interface ManifestEntry {
  readonly dshVersion: string
  readonly ptcRuntimeNodeVersion: string
  readonly dshSubprocessVersion: string
  readonly processSha256: string
  readonly indexSha256: string
  readonly controlSha256: string
  readonly controlFd: number | undefined
  readonly controlEnv: string | undefined
  readonly minimumNodeMajor: number
  /** Node 22 minor required by this worker's ESM import hooks; 0 for rc.1; undefined = unrecorded legacy overlay. */
  readonly minimumNodeMinor?: number
  readonly probes: {
    readonly entry: boolean
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

function normalizeEntry(value: unknown): ManifestEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Partial<ManifestEntry>
  if (typeof entry.dshVersion !== 'string'
    || typeof entry.ptcRuntimeNodeVersion !== 'string'
    || typeof entry.dshSubprocessVersion !== 'string'
    || typeof entry.processSha256 !== 'string'
    || typeof entry.indexSha256 !== 'string'
    || typeof entry.controlSha256 !== 'string'
    || typeof entry.minimumNodeMajor !== 'number'
    || typeof entry.probes !== 'object'
    || entry.probes === null) return undefined
  const probes = entry.probes as ManifestEntry['probes']
  if (typeof probes.entry !== 'boolean'
    || typeof probes.importsOnlyNode !== 'boolean'
    || typeof probes.bootstrapArgsMapsHostPath !== 'boolean'
    || typeof probes.spawnControlPipe !== 'boolean') return undefined
  return {
    dshVersion: entry.dshVersion,
    ptcRuntimeNodeVersion: entry.ptcRuntimeNodeVersion,
    dshSubprocessVersion: entry.dshSubprocessVersion,
    processSha256: entry.processSha256,
    indexSha256: entry.indexSha256,
    controlSha256: entry.controlSha256,
    controlFd: typeof entry.controlFd === 'number' ? entry.controlFd : undefined,
    controlEnv: typeof entry.controlEnv === 'string' ? entry.controlEnv : undefined,
    minimumNodeMajor: entry.minimumNodeMajor,
    // A missing floor is an unrecorded legacy entry, not proof of rc.1: an
    // rc.2 overlay written before this field existed must keep working. The
    // upload-time check derives the real floor from the worker bytes.
    minimumNodeMinor: typeof entry.minimumNodeMinor === 'number' ? entry.minimumNodeMinor : undefined,
    probes: {
      entry: probes.entry,
      importsOnlyNode: probes.importsOnlyNode,
      bootstrapArgsMapsHostPath: probes.bootstrapArgsMapsHostPath,
      spawnControlPipe: probes.spawnControlPipe,
    },
  }
}

function readEntries(path: string): ManifestEntry[] {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<WorkerManifest>
    if (!Array.isArray(raw.verified)) return []
    return raw.verified.map(normalizeEntry).filter((entry): entry is ManifestEntry => entry !== undefined)
  } catch {
    return []
  }
}

export function manifestKey(entry: ManifestEntry): string {
  return `${entry.processSha256}\0${entry.indexSha256}\0${entry.controlSha256}\0${String(entry.controlFd)}\0${entry.controlEnv ?? ''}\0${entry.minimumNodeMajor}\0${entry.minimumNodeMinor ?? '*'}`
}

/** Byte/control identity of an entry, ignoring the metadata-only Node floor. */
export function sameWorkerContract(left: ManifestEntry, right: ManifestEntry): boolean {
  return left.processSha256 === right.processSha256
    && left.indexSha256 === right.indexSha256
    && left.controlSha256 === right.controlSha256
    && left.controlFd === right.controlFd
    && left.controlEnv === right.controlEnv
}

/** The package release baseline only; used by `check:upstream --update`. */
export function readPackageManifest(): WorkerManifest {
  return { contractVersion: 1, verified: readEntries(packageManifestPath()) }
}

/** Only this installation's writable overlay; used by `check:upstream --adapt`. */
export function readOverlayManifest(env: NodeJS.ProcessEnv = process.env): WorkerManifest {
  return { contractVersion: 1, verified: readEntries(overlayManifestPath(env)) }
}

export function readWorkerManifest(): WorkerManifest {
  // The package manifest is the release baseline; a host-local overlay records
  // versions adapted on an already-installed host without rewriting the package.
  // Read both on every lookup so `adapt:upstream` takes effect without a restart.
  const merged = new Map<string, ManifestEntry>()
  for (const entry of [...readEntries(packageManifestPath()), ...readEntries(overlayManifestPath())]) {
    merged.set(manifestKey(entry), entry)
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

/**
 * Delete this installation's writable overlay; a missing file is not an error.
 *
 * Removing the file rather than writing an empty `verified` array keeps "no
 * adaptation" indistinguishable from "never adapted", which is what every
 * reader already assumes: `readEntries` returns `[]` for both.
 */
export function clearOverlayManifest(env: NodeJS.ProcessEnv = process.env): string {
  const path = overlayManifestPath(env)
  rmSync(path, { force: true })
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

function resolvePackageJson(specifier: string, fromDir: string, allowedRoot: string): string | undefined {
  try {
    const require = createRequire(join(fromDir, '__dsh_resolve__.js'))
    const resolved = require.resolve(specifier, { paths: [fromDir] })
    const rel = relative(resolve(allowedRoot), resolve(resolved))
    if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) return undefined
    return resolved
  } catch {
    return undefined
  }
}

/**
 * Locate the installed @deepseek-ai/dsh package.
 *
 * Exported for tests and diagnostics: resolving a peer package from the same
 * installation the plugin uses keeps specs off a hard-coded machine path.
 */
export function locateDshRoot(env: NodeJS.ProcessEnv = process.env): { root: string, version: string } {
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
  throw new Error(
    `cannot locate the installed @deepseek-ai/dsh package; set DSH_INSTALL_ROOT to the DSH package root. Tried: ${candidateDshRoots(env).join(', ') || '(none)'}`,
  )
}

function locateRuntimePackage(dshRoot: string): string {
  const direct = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-ptc-runtime-node', 'package.json')
  if (existsSync(direct)) return direct
  const resolved = resolvePackageJson('@deepseek-ai/dsh-ptc-runtime-node/package.json', dshRoot, dirname(dshRoot))
  if (resolved !== undefined) return resolved
  throw new Error(
    `the installed DSH at ${dshRoot} does not contain @deepseek-ai/dsh-ptc-runtime-node; remote run_code requires that package. Install a DSH build with Node PTC support.`,
  )
}

function locateSubprocessPackage(dshRoot: string): string {
  const direct = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-subprocess', 'package.json')
  if (existsSync(direct)) return direct
  const resolved = resolvePackageJson('@deepseek-ai/dsh-subprocess/package.json', dshRoot, dirname(dshRoot))
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
    indexSha256: worker.indexHash,
    controlSha256: worker.controlHash,
    controlFd: probes.controlFd,
    controlEnv: probes.controlEnv,
    minimumNodeMajor: PTC_MIN_REMOTE_NODE_MAJOR,
    minimumNodeMinor: probes.minimumNodeMinor,
    probes: {
      entry: probes.entry,
      importsOnlyNode: probes.importsOnlyNode,
      bootstrapArgsMapsHostPath: probes.bootstrapArgsMapsHostPath,
      spawnControlPipe: probes.spawnControlPipe,
    },
  }
}

export function locateUpstreamWorker(env: NodeJS.ProcessEnv = process.env, options: LocateOptions = {}): UpstreamWorker {
  const { root: dshRoot, version: dshVersion } = locateDshRoot(env)
  const runtimePackageJson = locateRuntimePackage(dshRoot)
  const subprocessPackageJson = locateSubprocessPackage(dshRoot)
  const packageRoot = dirname(runtimePackageJson)
  const read = (name: string): Buffer => readFileSync(join(packageRoot, name))
  const processSource = read('lib/process.js')
  const indexSource = read('lib/index.js')
  const controlSource = readFileSync(join(dirname(subprocessPackageJson), 'lib', 'control.js'))
  const worker: UpstreamWorker = {
    dshVersion,
    runtimeVersion: versionOf(runtimePackageJson),
    dshSubprocessVersion: versionOf(subprocessPackageJson),
    packageRoot,
    processPath: join(packageRoot, 'lib', 'process.js'),
    processSource,
    indexSource,
    controlSource,
    processHash: hash(processSource),
    indexHash: hash(indexSource),
    controlHash: hash(controlSource),
    minimumNodeMinor: moduleHooksRequired(processSource.toString('utf8')) ? PTC_MIN_NODE_MODULE_HOOKS_MINOR : 0,
  }
  const probes = probeContract(worker)
  if (probes.failures.length > 0) {
    throw new Error(`the installed PTC worker does not match the expected contract: ${probes.failures.join('; ')}. See docs/upstream-ptc-worker.md`)
  }
  if (options.allowUnverified !== true) {
    const manifest = readWorkerManifest()
    // Versions are labels, not the contract. Match the actual bytes that
    // determine the protocol; a DSH version bump with identical process.js /
    // index.js / control.js must not break every remote PTC run.
    const expected = manifest.verified.find(entry => entry.processSha256 === worker.processHash
      && entry.indexSha256 === worker.indexHash
      && entry.controlSha256 === worker.controlHash
      && entry.controlFd === probes.controlFd
      && entry.controlEnv === probes.controlEnv
      && entry.minimumNodeMajor === PTC_MIN_REMOTE_NODE_MAJOR
      && (entry.minimumNodeMinor === undefined || entry.minimumNodeMinor === worker.minimumNodeMinor))
    if (expected === undefined) {
      // The package manifest lives inside the installed plugin, which is
      // read-only for a normal npm install, so the installed-host command comes
      // first and the source-checkout command second.
      throw new Error(
        `the installed PTC worker (DSH ${worker.dshVersion}, runtime ${worker.runtimeVersion}) is not in the PTC worker manifest. `
        + 'On an installed host run `npm run adapt:upstream` (writes $DSH_HOME/permission-remote/upstream-ptc.manifest.json and applies to the next remote call). '
        + 'In a source checkout run `npm run upgrade:ptc -- --write` after the offline and live suites pass.',
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
  const importLines = processText.split(/\r?\n/u).filter(line => /^\s*import\s/u.test(line))
  const importsOnlyNode = importLines.length > 0 && importLines.every(line => /from\s+['"]node:/u.test(line))
  const requiresModuleHooks = moduleHooksRequired(processText)
  const requiresVmModules = /vm\.(?:SourceTextModule|SyntheticModule)\b/u.test(processText)
  const controlFdMatch = /fd\s*:\s*7/u.exec(processText) ?? /SUBPROCESS_CONTROL_FD\s*=\s*7/u.exec(controlText)
  const controlEnvMatch = /SUBPROCESS_CONTROL_ENV\s*=\s*['"]([^'"]+)['"]/u.exec(processText) ?? /SUBPROCESS_CONTROL_ENV\s*=\s*['"]([^'"]+)['"]/u.exec(controlText)
  const controlEnv = controlEnvMatch?.[1]
  const bootstrapArgsMapsHostPath = /processPathFromHostPath\s*\(/u.test(indexText) && /process\.js/u.test(indexText)
  const spawnControlPipe = /control\s*:\s*['"]pipe['"]/u.test(indexText)
  // DSH 0.2.2-rc.2's worker uses node:module registerHooks for ESM imports.
  // That named export only exists on Node >= 22.15 / 23.5, so the minimum
  // remote Node minor is derived from the very bytes that are uploaded.
  // Must be in the node-script bootstrap argv itself, not merely in a
  // NODE_OPTIONS assignment elsewhere: the shim builds the child argv from
  // bootstrapArgs and resets the environment to PATH/TEMP/TMP. Read the whole
  // bootstrapArgs block so a reformatted `case` still passes.
  const bootstrapBlock = functionBlock(indexText, 'bootstrapArgs')
  const nodeScriptVmModules = bootstrapBlock !== undefined && bootstrapBlock.includes('--experimental-vm-modules')
  const minimumNodeMinor = requiresModuleHooks ? PTC_MIN_NODE_MODULE_HOOKS_MINOR : 0
  const failures: string[] = []
  if (!entry) failures.push('process.js entry line changed')
  if (!importsOnlyNode) failures.push('process.js imports a non-Node module')
  if (controlFdMatch === null) failures.push('fd 7 control descriptor not found')
  if (controlEnv === undefined) failures.push('DSH_SUBPROCESS_CONTROL marker not found')
  else if (controlEnv !== PTC_CONTROL_ENV) failures.push(`control environment marker changed to ${controlEnv}; the shim expects ${PTC_CONTROL_ENV}`)
  if (!bootstrapArgsMapsHostPath) failures.push('bootstrapArgs no longer maps process.js through fs.processPathFromHostPath')
  if (!spawnControlPipe) failures.push('subprocess.spawn no longer requests a control pipe')
  if (requiresVmModules && !nodeScriptVmModules) failures.push('bootstrapArgs no longer passes --experimental-vm-modules for the vm-modules worker')
  return {
    entry,
    importsOnlyNode,
    controlFd: controlFdMatch === null ? undefined : 7,
    controlEnv,
    bootstrapArgsMapsHostPath,
    spawnControlPipe,
    requiresModuleHooks,
    requiresVmModules,
    nodeScriptVmModules,
    minimumNodeMinor,
    failures,
  }
}

/** Approximate one `function name(...) { ... }` block; enough to scope a source-shape check. */
function functionBlock(source: string, name: string): string | undefined {
  const start = new RegExp(`function\\s+${name}\\s*\\(`, 'u').exec(source)
  if (start === null) return undefined
  const bodyStart = source.indexOf('{', start.index)
  if (bodyStart < 0) return undefined
  let depth = 0
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start.index, index + 1)
    }
  }
  return undefined
}

/**
 * Whether the uploaded worker imports `registerHooks` from `node:module`.
 *
 * DSH 0.2.2-rc.2 added synchronous ESM import hooks to `process.js`; that
 * named export only exists from Node 22.15 / 23.5, and an ESM link error would
 * kill the worker before the control handshake.
 */
function moduleHooksRequired(processText: string): boolean {
  const imported = processText.split(/\r?\n/u)
    .filter(line => /^\s*import\s/u.test(line))
    .some(line => /\bregisterHooks\b/u.test(line) && /from\s+['"]node:module['"]/u.test(line))
  // `import * as module` + `module.registerHooks(...)` is the namespace form.
  return imported || /module\.registerHooks\s*\(/u.test(processText)
}

/** Node minor floor implied by a worker's own imports; used by the upload gate. */
export function minimumNodeMinorFor(worker: UpstreamWorker): number {
  return worker.minimumNodeMinor
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

/** The remote Node cannot run the bytes that would be uploaded. */
export class WorkerNodeFloorError extends Error {
  readonly code = 'WORKER_NODE_FLOOR'

  constructor(message: string) {
    super(message)
    this.name = 'WorkerNodeFloorError'
  }
}

export interface EnsureWorkerOptions {
  readonly allowUnverified?: boolean
  /** Remote Node probe; checked against the floor implied by the worker bytes. */
  readonly remoteNode?: { readonly version: string, readonly major: number, readonly minor?: number }
}

/**
 * The rc.2 worker imports `registerHooks` from `node:module`, which only exists
 * on Node >= 22.15 / 23.5. Version labels are metadata; this check is driven by
 * the exact bytes about to be uploaded, so a host overlay cannot lower it.
 */
export function nodeSupportsWorker(node: { readonly version: string, readonly major: number, readonly minor?: number }, minimumNodeMinor: number): boolean {
  if (node.major < PTC_MIN_NODE_MAJOR) return false
  // No minor floor (rc.1 worker): every Node 22+ line is enough.
  if (minimumNodeMinor === 0) return true
  // A probe that only reported the major cannot prove the required API exists.
  const minor = node.minor ?? 0
  // registerHooks landed in Node 22.15 and 23.5, and is present in 24+.
  if (node.major === PTC_MIN_NODE_MAJOR) return minor >= minimumNodeMinor
  if (node.major === 23) return minor >= PTC_MIN_NODE_MODULE_HOOKS_MINOR_NEXT
  return true
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
  if (options.remoteNode !== undefined && !nodeSupportsWorker(options.remoteNode, worker.minimumNodeMinor)) {
    const required = worker.minimumNodeMinor > 0
      ? `22.${worker.minimumNodeMinor} or newer (or Node.js 23.5 or newer)`
      : `${PTC_MIN_NODE_MAJOR} or newer`
    throw new WorkerNodeFloorError(`the installed DSH PTC worker requires Node.js ${required} on ${host.host}; found ${options.remoteNode.version}. Upgrade Node on the remote host and re-probe with Test connection in Settings → SSH hosts`)
  }
  const shimSource = ptcShimSource()
  const digest = createHash('sha256')
    .update(worker.processSource)
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
    const shimRemotePath = `${directory}/${SHIM_FILE}`
    await uploadFile(pool, host, secret, workerRemotePath, worker.processSource, worker.processHash, signal)
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


/**
 * The delivery contract `present` staging depends on.
 *
 * The plugin cannot replace `present`: the tool validates each path through
 * `ctx.fs` and records what `processPath` returns, and the card that opens the
 * result reads this computer's filesystem. So the plugin stages a local copy and
 * hands the official tool that path. Two details of the upstream implementation
 * make that work, and both are invisible to a mock:
 *
 * - `lstat` and `resolve` are called with the Session cwd. Without it a remote
 *   session's snapshot path is classified as a local path by accident; with it,
 *   the remote filesystem patch has to carve the snapshot out explicitly
 *   (`lexicalPath` in `remote-fs.ts`). Drop the cwd and that carve-out becomes
 *   dead code that silently stops being exercised.
 * - the recorded path is `processPath(target)`, not the string the model passed.
 *   The plugin records the same realpath for the card to verify.
 *
 * A probe failure here does not break every remote tool the way the PTC contract
 * does, so it is a separate check with its own message instead of a sixth
 * `probeContract` entry — that list is paired one-to-one with runbook rows.
 */
export interface PresentContractProbe {
  /** False when the installed DSH does not ship the package at all. */
  readonly installed: boolean
  readonly lstatWithCwd: boolean
  readonly resolveWithCwd: boolean
  readonly statsResolved: boolean
  readonly recordsProcessPath: boolean
  readonly failures: readonly string[]
}

/**
 * Read the installed `present` implementation and check the four calls above.
 *
 * `lib/index.js` is the shipped build; the TypeScript source is not part of the
 * published package.
 *
 * An absent package is NOT drift: a slimmed composition may not mount `present`
 * at all, and `runPresent` is never reached then. It is reported as
 * `installed: false` with no failures so the caller can say "skipped". Only a
 * package that exists with a different call shape means the seam moved.
 */
export function probePresentContract(dshRoot: string): PresentContractProbe {
  let source = ''
  try {
    source = readFileSync(join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-tool-present', 'lib', 'index.js'), 'utf8')
  } catch {
    // No package is not drift: a slimmed composition may not mount `present` at
    // all, and `runPresent` is never reached then. Reported as `installed:
    // false` so a caller can tell "absent" from "present and different" without
    // treating absence as a failure.
    return { installed: false, lstatWithCwd: false, resolveWithCwd: false, statsResolved: false, recordsProcessPath: false, failures: [] }
  }
  // The call and its options are matched together: `lstat(path, { cwd })` is the
  // contract, not `lstat(` on its own. `resolve` takes an options object built
  // one line earlier, so the name of that binding is read from the source
  // instead of assumed — `{ cwd, signal }` compiled to `options` today, and a
  // literal argument tomorrow, must both pass.
  const lstatWithCwd = /ctx\.fs\.lstat\([^)]*\{\s*cwd\s*\}/u.test(source)
  const cwdOptions = /const\s+(\w+)\s*=\s*\{[^}]*\bcwd\b[^}]*\}/u.exec(source)
  const optionsName = cwdOptions?.[1]
  const resolveWithCwd = optionsName !== undefined
    ? new RegExp(`ctx\\.fs\\.resolve\\([^)]*,\\s*${optionsName}\\s*[,)]`, 'u').test(source)
    : /ctx\.fs\.resolve\([^)]*\{\s*cwd\s*[^}]*\}/u.test(source)
  const statsResolved = /const\s+target\s*=\s*await\s+ctx\.fs\.resolve\([^)]*\)[\s\S]{0,200}?ctx\.fs\.stat\(\s*target\s*,/u.test(source)
  const recordsProcessPath = /ctx\.fs\.processPath\(\s*target\s*\)/u.test(source)
  // Built as a list literal rather than `push` calls on purpose: the PTC worker
  // runbook scanner treats every `failures.push(...)` in this file as a PTC
  // contract row and requires a matching entry in scripts/upstream-map.mjs.
  // These four are a different contract with a different fix, and they carry
  // their own advice in check-upstream.mjs.
  const failures = [
    ...lstatWithCwd ? [] : ['present no longer calls ctx.fs.lstat with the Session cwd'],
    ...resolveWithCwd ? [] : ['present no longer calls ctx.fs.resolve with the Session cwd'],
    ...statsResolved ? [] : ['present no longer stats the resolved target'],
    ...recordsProcessPath ? [] : ['present no longer records ctx.fs.processPath(target)'],
  ]
  return { installed: true, lstatWithCwd, resolveWithCwd, statsResolved, recordsProcessPath, failures }
}
