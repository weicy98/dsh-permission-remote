import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { PACKAGED_RANK, registerUpstreamSkill } from '../src/skills.ts'
import { run } from '../scripts/check-upstream.mjs'
import { resolveFromDshInstall } from './helpers/dsh-install.ts'

/**
 * The packaged runbook is the only upgrade instructions an installed plugin
 * user can reach, because `.agents/skills/` is not a discovery root under
 * `node_modules`. These tests drive the real skill registry rather than a stub,
 * so a provider-shape mistake fails here instead of silently offering nothing.
 */

// Resolved from the running DSH install, the same way the plugin finds it.
const REGISTRY = resolveFromDshInstall('@deepseek-ai/dsh-skill')

interface LoadedSkill {
  readonly content: string
  readonly resourceBase?: { readonly path: string }
}

interface FakeRegistry {
  list(options: { cwd: string }): Promise<Array<{ name: string, source?: string, provider?: string }>>
  get(name: string, options: { cwd: string }): Promise<LoadedSkill | undefined>
}

interface ProviderControl {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

interface SkillCandidate {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean, readonly userInvocable: boolean }
  readonly provider: string
  readonly source: string
  readonly rank: number
}

interface SkillRegistryModule {
  readonly SkillRegistry: new (ctx: Context) => unknown
}

// The registry ships inside the installed DSH and is not a dependency of this
// plugin, so it is loaded by path. `import()` of a .js path has no types; the
// module shape is asserted by the tests that use it.
async function loadRegistryModule(): Promise<SkillRegistryModule> {
  return await import(REGISTRY) as SkillRegistryModule
}

async function registry(): Promise<FakeRegistry> {
  const { SkillRegistry } = await loadRegistryModule()
  return new SkillRegistry(new Context() as never) as FakeRegistry
}

/** A registry that can also accept extra providers, for the override test. */
async function registryWithProviders(): Promise<FakeRegistry & { registerProvider(create: (control: ProviderControl) => unknown): () => void }> {
  return await registry() as FakeRegistry & { registerProvider(create: (control: ProviderControl) => unknown): () => void }
}

test('the runbook is registered and loadable', async () => {
  const skills = await registry()
  const dispose = registerUpstreamSkill({ skills } as never)
  try {
    assert.equal(typeof dispose, 'function')
    const loaded = await skills.get('upstream-ptc-upgrade', { cwd: process.cwd() })
    assert.notEqual(loaded, undefined, 'the skill was not offered')
    assert.match(loaded!.content, /## Upgrade runbook/u)
    assert.match(loaded!.content, /npm run upgrade:ptc/u)
  } finally {
    dispose?.()
  }
})

test('disposing the registration removes the skill', async () => {
  const skills = await registry()
  const dispose = registerUpstreamSkill({ skills } as never)
  dispose?.()
  assert.equal(await skills.get('upstream-ptc-upgrade', { cwd: process.cwd() }), undefined)
})

test('the skill body is the packaged doc itself, not a copy', async () => {
  const skills = await registry()
  const dispose = registerUpstreamSkill({ skills } as never)
  try {
    const loaded = await skills.get('upstream-ptc-upgrade', { cwd: process.cwd() })
    const doc = readFileSync(new URL('../docs/upstream-ptc-worker.md', import.meta.url), 'utf8')
    assert.equal(loaded!.content, doc, 'the skill body drifted from docs/upstream-ptc-worker.md')
    assert.equal(loaded!.resourceBase?.path, join(process.cwd(), 'docs'))
  } finally {
    dispose?.()
  }
})

test('the provider advertises itself as a packaged skill', async () => {
  const skills = await registry()
  const dispose = registerUpstreamSkill({ skills } as never)
  try {
    const listed = await skills.list({ cwd: process.cwd() })
    const mine = (Array.isArray(listed) ? listed : []).find(item => item.name === 'upstream-ptc-upgrade')
    assert.notEqual(mine, undefined)
    assert.equal(mine!.provider, 'dsh-permission-remote-upstream')
    assert.equal(mine!.source, 'plugin')
  } finally {
    dispose?.()
  }
})

test('the packaged rank equals the upstream bundled skill rank', async () => {
  // A literal 600 in src/skills.ts would silently drift from the installed
  // dsh-skill. Compare against the constant the registry itself exports.
  const upstream = await import(REGISTRY) as { BUNDLED_SKILL_RANK: number }
  assert.equal(typeof upstream.BUNDLED_SKILL_RANK, 'number')
  assert.equal(PACKAGED_RANK, upstream.BUNDLED_SKILL_RANK, 'PACKAGED_RANK drifted from the upstream BUNDLED_SKILL_RANK')
  assert.equal(PACKAGED_RANK, 600, 'lower ranks win, so 600 stays numerically above the project/user roots')
})

test('a lower-rank provider offering the same name wins', async () => {
  // This is the behaviour that matters: an overriding copy must take precedence.
  // Asserting a numeric formula on upstream constants proved nothing, so this
  // races two real providers through the registry instead.
  const skills = await registryWithProviders()
  const disposeMine = registerUpstreamSkill({ skills } as never)
  // A local override at the project-agents rank (200), below the packaged 600.
  const disposeOverride = skills.registerProvider(() => ({
    name: 'override-provider',
    list: () => Promise.resolve([{
      name: 'upstream-ptc-upgrade',
      description: 'Local override of the upstream upgrade runbook.',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'override-provider',
      source: 'project',
      rank: 200,
    }]),
    get: async (candidate: SkillCandidate) => ({
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      content: '# Local override',
    }),
  }))
  try {
    const loaded = await skills.get('upstream-ptc-upgrade', { cwd: process.cwd() })
    assert.notEqual(loaded, undefined, 'neither provider offered the skill')
    assert.match(loaded!.content, /# Local override/u, 'the packaged skill shadowed a lower-rank override')
  } finally {
    disposeOverride()
    disposeMine?.()
  }
})

/**
 * check-upstream is the first gate of the upgrade flow. Its exit code and its
 * refusal to write on a dry run are what `upgrade:ptc` and CI depend on.
 */

function harness(argv: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-check-'))
  const previousHome = process.env.DSH_HOME
  const previousRoot = process.env.DSH_INSTALL_ROOT
  process.env.DSH_HOME = home
  const lines: string[] = []
  const errors: string[] = []
  return {
    home,
    lines,
    errors,
    overlay: () => join(home, 'permission-remote', 'upstream-ptc.manifest.json'),
    outcome: () => run({ argv, log: line => lines.push(line), error: line => errors.push(line) }) as { code: number, wrote?: string },
    restore: () => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      // `--dsh-root` writes DSH_INSTALL_ROOT into the real environment, so a
      // failed probe would otherwise redirect every later test's locator.
      if (previousRoot === undefined) delete process.env.DSH_INSTALL_ROOT
      else process.env.DSH_INSTALL_ROOT = previousRoot
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test('--check against the installed host is green', () => {
  const h = harness(['--check'])
  try {
    assert.equal(h.outcome().code, 0)
    assert.match(h.lines.join('\n'), /check:upstream: sandbox profile sha256 [0-9a-f]{64}/u)
    assert.match(h.lines.join('\n'), /check:upstream: OK/u)
  } finally {
    h.restore()
  }
})

test('--adapt records the host overlay and --reset clears it', async () => {
  const h = harness(['--adapt'])
  try {
    const result = h.outcome()
    assert.equal(result.code, 0)
    assert.equal(result.wrote, h.overlay())
    const manifest = JSON.parse(readFileSync(h.overlay(), 'utf8')) as { verified: unknown[] }
    assert.equal(manifest.verified.length, 1)

    const cleared = run({ argv: ['--reset'], log: () => undefined, error: () => undefined }) as { code: number }
    assert.equal(cleared.code, 0)
    // `--reset` deletes the overlay rather than writing an empty entry list, so
    // a later `ls` cannot suggest an adaptation still exists.
    assert.equal(existsSync(h.overlay()), false, '--reset left the overlay file behind')
  } finally {
    h.restore()
  }
})

test('--adapt --dry-run reports the target without writing', () => {
  const h = harness(['--adapt', '--dry-run'])
  try {
    const result = h.outcome()
    assert.equal(result.code, 0)
    assert.equal(result.wrote, undefined)
    assert.match(h.lines.join('\n'), /would record/u)
    assert.throws(() => readFileSync(h.overlay()), /ENOENT/u)
  } finally {
    h.restore()
  }
})

test('drift advice splits between an installed package and a source checkout', async () => {
  // A real drift: copy the host install and change one byte of process.js so the
  // recorded hashes no longer match, then ask for advice in both modes.
  const { cpSync, appendFileSync } = await import('node:fs')
  const { locateDshRoot } = await import('../src/upstream-worker.ts')
  const root = locateDshRoot().root
  const copy = mkdtempSync(join(tmpdir(), 'dsh-drift-'))
  const previousRoot = process.env.DSH_INSTALL_ROOT
  try {
    // Copy only the packages the locator reads, not the whole install.
    // The sandbox profile probe reads the two sandbox bundles as well.
    const dshRoot = join(copy, 'dsh')
    const packages = ['dsh-ptc-runtime-node', 'dsh-subprocess', 'dsh-sandbox-local', 'dsh-sandbox']
    mkdirSync(dshRoot, { recursive: true })
    writeFileSync(join(dshRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2' }))
    for (const name of packages) {
      const from = join(root, 'node_modules', '@deepseek-ai', name)
      const to = join(dshRoot, 'node_modules', '@deepseek-ai', name)
      cpSync(join(from, 'package.json'), join(to, 'package.json') as never)
      cpSync(join(from, 'lib'), join(to, 'lib'), { recursive: true })
    }
    appendFileSync(join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-ptc-runtime-node', 'lib', 'process.js'), '\n// drift\n')
    process.env.DSH_INSTALL_ROOT = dshRoot

    const installedErrors: string[] = []
    const installed = run({ argv: ['--check', '--explain'], installed: true, log: () => undefined, error: line => installedErrors.push(line) }) as { code: number }
    assert.equal(installed.code, 1, 'a byte change must report drift')
    const installedText = installedErrors.join('\n')
    assert.match(installedText, /adapt:upstream/u, 'installed advice must name the writable-overlay command')
    assert.doesNotMatch(installedText, /--update/u, 'installed advice must not suggest rewriting the package manifest')
    assert.match(installedText, /cannot run the offline gate/u)

    const sourceErrors: string[] = []
    const source = run({ argv: ['--check', '--explain'], installed: false, log: () => undefined, error: line => sourceErrors.push(line) }) as { code: number }
    assert.equal(source.code, 1)
    assert.match(sourceErrors.join('\n'), /upgrade:ptc/u)
  } finally {
    if (previousRoot === undefined) delete process.env.DSH_INSTALL_ROOT
    else process.env.DSH_INSTALL_ROOT = previousRoot
    rmSync(copy, { recursive: true, force: true })
  }
})

test('--reset works even when the DSH install cannot be located', () => {
  // Deleting a JSON file needs no worker bytes, and a broken install is exactly
  // when an operator wants this flag.
  const h = harness(['--adapt'])
  const previousRoot = process.env.DSH_INSTALL_ROOT
  try {
    assert.equal(h.outcome().code, 0)
    assert.equal(existsSync(h.overlay()), true)
    process.env.DSH_INSTALL_ROOT = join(tmpdir(), 'dsh-definitely-not-here')

    const errors: string[] = []
    const reset = run({ argv: ['--reset'], log: () => undefined, error: line => errors.push(line) }) as { code: number }
    assert.equal(reset.code, 0, `--reset failed: ${errors.join('; ')}`)
    assert.equal(existsSync(h.overlay()), false, '--reset left the overlay behind')
  } finally {
    if (previousRoot === undefined) delete process.env.DSH_INSTALL_ROOT
    else process.env.DSH_INSTALL_ROOT = previousRoot
    h.restore()
  }
})

test('--adapt --reset resets the overlay instead of being a usage error', () => {
  // This combination was a valid way to clear the overlay before `--reset`
  // gained its own branch, so it must keep working.
  const h = harness(['--adapt'])
  try {
    assert.equal(h.outcome().code, 0)
    assert.equal(existsSync(h.overlay()), true)
    const adapted = run({ argv: ['--adapt', '--reset'], log: () => undefined, error: () => undefined }) as { code: number }
    assert.equal(adapted.code, 0)
    assert.equal(existsSync(h.overlay()), false)
  } finally {
    h.restore()
  }
})

test('--update --reset is still refused', () => {
  const h = harness(['--update', '--reset'])
  try {
    assert.throws(() => h.outcome(), /cannot be combined with --update/u)
  } finally {
    h.restore()
  }
})

test('--explain names a file and a function for a failing probe', () => {
  // A DSH root with no runtime package fails at locate, not at a probe, so this
  // exercises the locate guidance; probe guidance is covered by
  // tests/upstream-map.spec.ts, which owns the table itself.
  const h = harness(['--check', '--explain', '--dsh-root', join(tmpdir(), 'dsh-no-such-install')])
  try {
    assert.equal(h.outcome().code, 1)
    assert.match(h.errors.join('\n'), /cannot locate the installed/u)
  } finally {
    h.restore()
  }
})

test('an unwritable package manifest points at --adapt instead of a stack', async () => {
  // `vendor/upstream/` lives inside the package, which is read-only for a
  // normal npm install. The script must translate EACCES into the overlay
  // command. Only the mode bit changes here; the file content is untouched.
  const { chmodSync, statSync } = await import('node:fs')
  const manifest = new URL('../vendor/upstream/ptc-worker.manifest.json', import.meta.url)
  const original = statSync(manifest).mode
  const h = harness(['--update'])
  try {
    chmodSync(manifest, 0o444)
    const result = h.outcome()
    assert.equal(result.code, 1, 'a read-only package manifest must not report success')
    assert.match(h.errors.join('\n'), /adapt:upstream/u)
    assert.doesNotMatch(h.errors.join('\n'), /^\s+at /mu, 'the script leaked a stack trace')
  } finally {
    chmodSync(manifest, original)
    h.restore()
  }
})
