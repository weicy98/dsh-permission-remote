/**
 * Call the host's official bwrap and seatbelt profile constructors.
 *
 * `@deepseek-ai/dsh-sandbox-local` does not export them. The installed
 * `lib/index.js` is what runs: extract the profile region, check the shape
 * literals, then call the constructors and require the accepted argv. A
 * literal those probes name, or an argv the call returns, refuses the command.
 * Root helpers keep remote paths as spelled, because the official helpers
 * realpath on this computer.
 *
 * A failed probe throws. There is no copied argv and no local fallback.
 * The file-write profile still adds its own temp binds in `profile.ts`; only
 * the shared read-only bwrap base comes from here. Constructors are read from
 * disk on every load, so an in-place package upgrade cannot keep an old argv.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { locateDshRoot } from './upstream-worker.ts'

const PROFILE_REGION_START = '//#region lib/types/profiles.js'
const PROFILE_REGION_END = '//#endregion'

export interface SandboxProfileProbe {
  readonly failures: readonly string[]
  readonly profileSha256: string
  readonly rootsSha256: string
}

export interface OfficialSandboxPolicy {
  readonly mode: 'read-only' | 'workspace-write'
  readonly workspaceRoot: string
  /** Remote workspace roots. Empty under read-only. Not realpath'd locally. */
  readonly additionalWritableRoots?: readonly string[]
  /**
   * Remote seatbelt grant list. The official constructor asks `writableRoots`
   * for this, which on a local host would be the controller's `/tmp`. The
   * injected helper returns this list instead.
   */
  readonly remoteWritableRoots?: readonly string[]
}

export interface OfficialSandboxProfiles {
  bwrap(policy: OfficialSandboxPolicy): string[]
  seatbelt(policy: OfficialSandboxPolicy): string[]
}

interface LocatedSources {
  readonly sandboxLocalPath: string
  readonly sandboxPath: string
  readonly sandboxLocalSource: string
  readonly sandboxSource: string
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function locateSources(env: NodeJS.ProcessEnv): LocatedSources {
  const { root } = locateDshRoot(env)
  const require = createRequire(join(root, '__dsh_profile__.js'))
  let sandboxLocalPath: string
  let sandboxPath: string
  try {
    // The public export is the package entry. `lib/index.js` is not a subpath.
    sandboxLocalPath = require.resolve('@deepseek-ai/dsh-sandbox-local', { paths: [root] })
    sandboxPath = require.resolve('@deepseek-ai/dsh-sandbox', { paths: [root] })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`the installed DSH at ${root} does not provide @deepseek-ai/dsh-sandbox-local (${detail})`)
  }
  return {
    sandboxLocalPath,
    sandboxPath,
    sandboxLocalSource: readFileSync(sandboxLocalPath, 'utf8'),
    sandboxSource: readFileSync(sandboxPath, 'utf8'),
  }
}

/** The bundled profile region, including its end marker. Undefined when the markers moved. */
export function extractProfileRegion(source: string): string | undefined {
  const start = source.indexOf(PROFILE_REGION_START)
  if (start < 0) return undefined
  const end = source.indexOf(PROFILE_REGION_END, start + PROFILE_REGION_START.length)
  if (end < 0) return undefined
  return source.slice(start, end + PROFILE_REGION_END.length)
}

/**
 * Slice one `function name(...) { ... }` out of a bundle.
 *
 * Brace matching skips strings, comments, and template literals, including
 * `${ ... }` expressions, so the seatbelt profile's templates stay intact.
 */
export function extractFunction(source: string, name: string): string | undefined {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source)
  if (match === null) return undefined
  const open = source.indexOf('{', match.index + match[0].length)
  if (open < 0) return undefined
  const end = scanBlockEnd(source, open)
  if (end === undefined) return undefined
  return source.slice(match.index, end + 1)
}

function scanBlockEnd(source: string, open: number): number | undefined {
  let index = open
  let depth = 0
  let state: 'code' | 'single' | 'double' | 'line' | 'block' | 'template' = 'code'
  const templateDepth: number[] = []
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (state === 'line') {
      if (char === '\n') state = 'code'
      index += 1
      continue
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code'
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (state === 'single' || state === 'double') {
      if (char === '\\') {
        index += 2
        continue
      }
      if ((state === 'single' && char === '\'') || (state === 'double' && char === '"')) state = 'code'
      index += 1
      continue
    }
    if (state === 'template') {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '`') {
        state = 'code'
        index += 1
        continue
      }
      if (char === '$' && next === '{') {
        templateDepth.push(depth)
        state = 'code'
        depth += 1
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      state = 'line'
      index += 2
      continue
    }
    if (char === '/' && next === '*') {
      state = 'block'
      index += 2
      continue
    }
    if (char === '\'') {
      state = 'single'
      index += 1
      continue
    }
    if (char === '"') {
      state = 'double'
      index += 1
      continue
    }
    if (char === '`') {
      state = 'template'
      index += 1
      continue
    }
    if (char === '{') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
      const pending = templateDepth[templateDepth.length - 1]
      if (pending !== undefined && depth === pending) {
        templateDepth.pop()
        state = 'template'
      }
      index += 1
      continue
    }
    index += 1
  }
  return undefined
}

function quotedAt(source: string, value: string, from = 0): number {
  const double = source.indexOf(`"${value}"`, from)
  const single = source.indexOf(`'${value}'`, from)
  if (double < 0) return single
  if (single < 0) return double
  return Math.min(double, single)
}

function bwrapBaseIntact(source: string): boolean {
  const flags = ['--ro-bind', '--dev', '--unshare-pid', '--proc', '--die-with-parent']
  let cursor = 0
  for (const flag of flags) {
    const at = quotedAt(source, flag, cursor)
    if (at < 0) return false
    cursor = at + flag.length
  }
  return true
}

function bwrapPrivateTmp(source: string): boolean {
  const mode = source.indexOf('workspace-write')
  const tmpfs = quotedAt(source, '--tmpfs')
  const tmp = tmpfs < 0 ? -1 : quotedAt(source, '/tmp', tmpfs)
  if (mode < 0 || tmpfs < mode || tmp < tmpfs) return false
  return quotedAt(source.slice(0, mode), '--tmpfs') < 0
}

function callsHelper(source: string, name: string): boolean {
  // `workspaceWritableRoots` contains the letters of `writableRoots`. A word
  // boundary keeps the two helpers from counting as each other.
  return new RegExp(`(?<![\\w$])${name}\\s*\\(`, 'u').test(source)
}

function bwrapUsesWorkspaceRoots(source: string): boolean {
  return callsHelper(source, 'workspaceWritableRoots') && !callsHelper(source, 'writableRoots')
}

function seatbeltSkeleton(seatbelt: string, sbpl: string): boolean {
  return quotedAt(seatbelt, '(version 1)') >= 0
    && quotedAt(seatbelt, '(allow default)') >= 0
    && quotedAt(seatbelt, '(deny file-write*)') >= 0
    && seatbelt.includes('sbplString(')
    && seatbelt.includes('/dev/null')
    && seatbelt.includes('(subpath')
    && sbpl.includes('replaceAll')
}

function seatbeltUsesWritableRoots(source: string): boolean {
  return callsHelper(source, 'writableRoots') && !callsHelper(source, 'workspaceWritableRoots')
}

function workspaceRootsMeanWorkspace(source: string): boolean {
  return source.includes('policy.mode !== "workspace-write"')
    && source.includes('canonicalPath(policy.workspaceRoot)')
    && source.includes('additionalWritableRoots')
    && !source.includes('tmpdir')
    && quotedAt(source, '/tmp') < 0
}

function writableRootsMeanTemp(source: string): boolean {
  return source.includes('workspaceWritableRoots(policy)')
    && source.includes('canonicalPath("/tmp")')
    && /canonicalPath\(\s*tmpdir\(\)\s*\)/u.test(source)
}

/** Sentinel roots. They never exist on this computer; the injected helpers return them as spelled. */
const CONTRACT_WORKSPACE = '/srv/contract-workspace'
const CONTRACT_EXTRA = '/srv/contract-extra'
/** A quote and a backslash pin both `sbplString` replacements. A plain path pins neither. */
const CONTRACT_TEMP = '/private/contract"\\tmp'
const SENTINEL_USER_TMP = '/sentinel/user-tmp'

/**
 * Argv the remote bash and PTC profiles accept from the installed constructors.
 * This is the comparison pin, not a runtime fallback.
 */
const ACCEPTED_BWRAP_READ_ONLY = [
  '--ro-bind', '/', '/',
  '--dev', '/dev',
  '--unshare-pid',
  '--proc', '/proc',
  '--die-with-parent',
] as const

const ACCEPTED_BWRAP_WORKSPACE_WRITE = [
  ...ACCEPTED_BWRAP_READ_ONLY,
  '--tmpfs', '/tmp',
  '--bind', CONTRACT_WORKSPACE, CONTRACT_WORKSPACE,
  '--bind', CONTRACT_EXTRA, CONTRACT_EXTRA,
] as const

const ACCEPTED_SEATBELT_READ_ONLY = [
  '-p',
  '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))',
] as const

const ACCEPTED_SEATBELT_WORKSPACE_WRITE = [
  '-p',
  '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null")) (allow file-write* (subpath "/srv/contract-workspace") (subpath "/private/contract\\"\\\\tmp"))',
] as const

function sameArgv(got: readonly string[], expected: readonly string[]): boolean {
  return got.length === expected.length && got.every((item, index) => item === expected[index])
}

/**
 * Call the official root helpers. The plugin does not use them on a remote
 * path, because they realpath on this computer; it still has to know what they
 * return. Comments and dead flags satisfy the string probes, so the return
 * value is the check. `canonicalPath` and `additionalRoot` stay inert.
 */
function acceptedRootHelpers(sandboxSource: string): string[] {
  const workspaceRoots = extractFunction(sandboxSource, 'workspaceWritableRoots')
  const writable = extractFunction(sandboxSource, 'writableRoots')
  if (workspaceRoots === undefined || writable === undefined) {
    throw new Error('root helpers disappeared after a green shape probe')
  }
  const factory = new Function(
    'canonicalPath',
    'additionalRoot',
    'tmpdir',
    `${workspaceRoots}\n${writable}\nreturn { workspaceWritableRoots, writableRoots };`,
  ) as (
    canonicalPath: (path: string) => string,
    additionalRoot: (path: string) => string,
    tmpdir: () => string,
  ) => {
    workspaceWritableRoots?: (policy: OfficialSandboxPolicy) => unknown
    writableRoots?: (policy: OfficialSandboxPolicy) => unknown
  }
  const api = factory(
    path => `canon:${path}`,
    path => `extra:${path}`,
    () => SENTINEL_USER_TMP,
  )
  if (typeof api.workspaceWritableRoots !== 'function' || typeof api.writableRoots !== 'function') {
    throw new Error('the sandbox bundle did not define workspaceWritableRoots and writableRoots')
  }
  const readOnly: OfficialSandboxPolicy = {
    mode: 'read-only',
    workspaceRoot: CONTRACT_WORKSPACE,
    additionalWritableRoots: [CONTRACT_EXTRA],
  }
  const workspace: OfficialSandboxPolicy = {
    mode: 'workspace-write',
    workspaceRoot: CONTRACT_WORKSPACE,
    additionalWritableRoots: [CONTRACT_EXTRA],
  }
  const workspaceWrite = [`canon:${CONTRACT_WORKSPACE}`, `extra:${CONTRACT_EXTRA}`]
  const writableWrite = [...workspaceWrite, 'canon:/tmp', `canon:${SENTINEL_USER_TMP}`]
  const checks: Array<[string, readonly string[], readonly string[]]> = [
    ['workspaceWritableRoots read-only', stringArray(api.workspaceWritableRoots(readOnly), 'workspaceWritableRoots'), []],
    ['workspaceWritableRoots workspace-write', stringArray(api.workspaceWritableRoots(workspace), 'workspaceWritableRoots'), workspaceWrite],
    ['writableRoots read-only', stringArray(api.writableRoots(readOnly), 'writableRoots'), []],
    ['writableRoots workspace-write', stringArray(api.writableRoots(workspace), 'writableRoots'), writableWrite],
  ]
  const mismatches = checks.flatMap(([label, got, expected]) => (
    sameArgv(got, expected) ? [] : [`${label} returned ${JSON.stringify(got)}`]
  ))
  if (mismatches.length === 0) return []
  const failures: string[] = []
  failures.push(`sandbox root helpers did not return the accepted directories: ${mismatches.join('; ')}`)
  return failures
}

/**
 * Call the constructors. A flag that is merely spelled in the source can still
 * be skipped, narrowed, or joined by extra flags. A function declaration in
 * the region shares the factory scope and shadows the injected root helper;
 * the bind target is what shows that.
 */
function acceptedProfileArgv(profiles: OfficialSandboxProfiles): string[] {
  const readOnly: OfficialSandboxPolicy = {
    mode: 'read-only',
    workspaceRoot: CONTRACT_WORKSPACE,
    remoteWritableRoots: [CONTRACT_WORKSPACE, CONTRACT_TEMP],
  }
  const workspace: OfficialSandboxPolicy = {
    mode: 'workspace-write',
    workspaceRoot: CONTRACT_WORKSPACE,
    additionalWritableRoots: [CONTRACT_EXTRA],
    remoteWritableRoots: [CONTRACT_WORKSPACE, CONTRACT_TEMP],
  }
  const checks: Array<[string, readonly string[], readonly string[]]> = [
    ['bwrap read-only', profiles.bwrap(readOnly), ACCEPTED_BWRAP_READ_ONLY],
    ['bwrap workspace-write', profiles.bwrap(workspace), ACCEPTED_BWRAP_WORKSPACE_WRITE],
    ['seatbelt read-only', profiles.seatbelt(readOnly), ACCEPTED_SEATBELT_READ_ONLY],
    ['seatbelt workspace-write', profiles.seatbelt(workspace), ACCEPTED_SEATBELT_WORKSPACE_WRITE],
  ]
  const mismatches = checks.flatMap(([label, got, expected]) => (
    sameArgv(got, expected) ? [] : [`${label} returned ${JSON.stringify(got)}`]
  ))
  if (mismatches.length === 0) return []
  const failures: string[] = []
  failures.push(`sandbox profile argv does not match the accepted contract: ${mismatches.join('; ')}`)
  return failures
}

/**
 * Shape probe, then the constructor call.
 *
 * String checks still run first. The helper call is what accepts their meaning:
 * the constructors below replace those helpers, so constructor argv cannot see
 * a comment that only spells `canonicalPath("/tmp")`.
 */
export function probeSandboxProfileSources(sandboxLocalSource: string, sandboxSource: string): SandboxProfileProbe {
  const failures: string[] = []
  const region = extractProfileRegion(sandboxLocalSource)
  if (region === undefined) {
    failures.push('sandbox profile region markers changed')
  } else {
    const bwrap = extractFunction(region, 'bwrapProfileArgs')
    const seatbelt = extractFunction(region, 'seatbeltProfileArgs')
    const sbpl = extractFunction(region, 'sbplString')
    if (bwrap === undefined) {
      failures.push('bwrapProfileArgs function not found')
    } else {
      if (!bwrapBaseIntact(bwrap)) failures.push('bwrap base flags changed')
      if (!bwrapPrivateTmp(bwrap)) failures.push('bwrap workspace-write no longer mounts a private /tmp')
      if (!bwrapUsesWorkspaceRoots(bwrap)) failures.push('bwrap workspace binds no longer come from workspaceWritableRoots')
    }
    if (seatbelt === undefined || sbpl === undefined || !seatbeltSkeleton(seatbelt, sbpl)) {
      failures.push('seatbelt profile skeleton changed')
    } else if (!seatbeltUsesWritableRoots(seatbelt)) {
      failures.push('seatbelt grants no longer come from writableRoots')
    }
  }
  const workspaceRoots = extractFunction(sandboxSource, 'workspaceWritableRoots')
  const writable = extractFunction(sandboxSource, 'writableRoots')
  if (workspaceRoots === undefined || !workspaceRootsMeanWorkspace(workspaceRoots)) {
    failures.push('workspaceWritableRoots no longer means the workspace plus explicit extra directories')
  }
  if (writable === undefined || !writableRootsMeanTemp(writable)) {
    failures.push('writableRoots no longer adds the host temp directories on top of the workspace')
  }
  if (failures.length === 0 && region !== undefined) {
    try {
      failures.push(...acceptedRootHelpers(sandboxSource))
      if (failures.length === 0) failures.push(...acceptedProfileArgv(compileProfiles(region)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`sandbox profile constructors did not evaluate: ${message}`)
    }
  }
  return {
    failures,
    profileSha256: region === undefined ? '' : sha256(region),
    rootsSha256: sha256(`${workspaceRoots ?? ''}\n${writable ?? ''}`),
  }
}

function remoteWorkspaceRoots(policy: OfficialSandboxPolicy): string[] {
  if (policy.mode !== 'workspace-write') return []
  const extra = policy.additionalWritableRoots ?? []
  return [...new Set([policy.workspaceRoot, ...extra].filter(root => root.length > 0))]
}

function remoteWritableRoots(policy: OfficialSandboxPolicy): readonly string[] {
  if (policy.mode !== 'workspace-write') return []
  return policy.remoteWritableRoots ?? []
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${name} did not return a string array`)
  }
  return value as string[]
}

function compileProfiles(region: string): OfficialSandboxProfiles {
  const factory = new Function(
    'workspaceWritableRoots',
    'writableRoots',
    'grantArgs',
    `${region}\nreturn { bwrapProfileArgs, seatbeltProfileArgs };`,
  ) as (
    workspaceWritableRoots: (policy: OfficialSandboxPolicy) => readonly string[],
    writableRoots: (policy: OfficialSandboxPolicy) => readonly string[],
    grantArgs: () => never,
  ) => {
    bwrapProfileArgs?: (policy: OfficialSandboxPolicy) => unknown
    seatbeltProfileArgs?: (policy: OfficialSandboxPolicy) => unknown
  }
  const api = factory(
    remoteWorkspaceRoots,
    remoteWritableRoots,
    () => {
      throw new Error('remote confinement does not call the official landlock profile')
    },
  )
  const bwrap = api.bwrapProfileArgs
  const seatbelt = api.seatbeltProfileArgs
  if (typeof bwrap !== 'function' || typeof seatbelt !== 'function') {
    throw new Error('the profile region did not define bwrapProfileArgs and seatbeltProfileArgs')
  }
  return {
    bwrap: policy => stringArray(bwrap(policy), 'bwrapProfileArgs'),
    seatbelt: policy => stringArray(seatbelt(policy), 'seatbeltProfileArgs'),
  }
}

function failUnevaluated(message: string): never {
  const failures: string[] = []
  failures.push(`sandbox profile constructors did not evaluate: ${message}`)
  throw new Error(failures[0])
}

/**
 * Read the installed packages and return the probe.
 *
 * A missing install is a failure, not a throw, so `check:upstream` can print
 * the guide row. An empty failure list means the constructors were called and
 * returned the accepted argv.
 */
export function probeInstalledSandboxProfiles(env: NodeJS.ProcessEnv = process.env): SandboxProfileProbe {
  try {
    const located = locateSources(env)
    return probeSandboxProfileSources(located.sandboxLocalSource, located.sandboxSource)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failures: string[] = []
    failures.push(`sandbox profile package could not be read: ${message}`)
    return { failures, profileSha256: '', rootsSha256: '' }
  }
}

/** Load the official constructors. Throws when the probe fails or the region will not run. */
export function loadSandboxProfiles(env: NodeJS.ProcessEnv = process.env): OfficialSandboxProfiles {
  const located = locateSources(env)
  const probe = probeSandboxProfileSources(located.sandboxLocalSource, located.sandboxSource)
  if (probe.failures.length > 0) {
    throw new Error(
      `the installed sandbox profile does not match the expected contract: ${probe.failures.join('; ')}. See docs/upstream-reuse-playbook.md`,
    )
  }
  const region = extractProfileRegion(located.sandboxLocalSource)
  if (region === undefined) failUnevaluated('the profile region disappeared after a green probe')
  try {
    const profiles = compileProfiles(region)
    const drifted = acceptedProfileArgv(profiles)
    if (drifted.length > 0) {
      throw new Error(
        `the installed sandbox profile does not match the expected contract: ${drifted.join('; ')}. See docs/upstream-reuse-playbook.md`,
      )
    }
    return profiles
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('does not match the expected contract')) throw error
    failUnevaluated(message)
  }
}

/**
 * Probe, load, and call. `check:upstream` uses this so a region that compiles
 * but throws, or that returns a different argv, fails the gate before a remote
 * command.
 */
export function assertSandboxProfilesLoad(env: NodeJS.ProcessEnv = process.env): SandboxProfileProbe {
  const probe = probeInstalledSandboxProfiles(env)
  if (probe.failures.length > 0) return probe
  try {
    const profiles = loadSandboxProfiles(env)
    const drifted = acceptedProfileArgv(profiles)
    return drifted.length === 0 ? probe : { ...probe, failures: drifted }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('sandbox profile constructors did not evaluate') || message.includes('does not match the expected contract')) {
      return { ...probe, failures: [message] }
    }
    const failures: string[] = []
    failures.push(`sandbox profile constructors did not evaluate: ${message}`)
    return { ...probe, failures }
  }
}
