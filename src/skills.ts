/**
 * Publish the upstream-contract runbook as a skill.
 *
 * `docs/` ships with the package (it is listed in `package.json` `files`), but
 * a skill under `.agents/skills/` is only discovered when it sits in a project
 * root or a user skill directory. An installed plugin has neither, so the
 * runbook has to be registered at runtime instead of left on disk. This is the
 * same shape `@deepseek-ai/dsh-skill-badge` uses for its bundled skill.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_NAME = 'upstream-ptc-upgrade'
const PROVIDER_NAME = 'dsh-permission-remote-upstream'
/**
 * Skill ranks are ascending in `@deepseek-ai/dsh-skill`: a LOWER number wins a
 * duplicate name. The packaged provider rank is 600, numerically HIGHER than
 * the project and user roots, so it has LOWER priority and a project that ships
 * an edited copy of this runbook still wins. Keeping the upstream bundled rank
 * means this skill never shadows a local override.
 */
export const PACKAGED_RANK = 600
const DESCRIPTION = 'Use when a remote run_code call in dsh-permission-remote reports an upstream PTC worker contract error, when `npm run check:upstream` reports drift after a DeepSeek Harness upgrade, or when adapting this plugin to a new installed DSH version. Covers the probe decision table (which file and function each contract probe protects), the `npm run upgrade:ptc` gate, the writable overlay vs the package manifest, and the actions that must never be taken (vendoring the worker, hand-editing the manifest, falling back to a local process).'

/**
 * Resolve `docs/upstream-ptc-worker.md` from this module's directory.
 *
 * The bundler inlines this file into `lib/index.js`, so `import.meta.url` is
 * `lib/` when installed and `src/` in a source checkout; both sit one level
 * below the package root, where `docs/` lives. There is no second layout to
 * fall back to.
 */
function runbookPath() {
  const candidate = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'upstream-ptc-worker.md')
  return existsSync(candidate) ? candidate : undefined
}

export interface SkillRegistrationContext {
  readonly skills: {
    registerProvider(create: (control: { signal: AbortSignal, invalidate: () => void }) => SkillProvider): unknown
  }
}

export interface SkillProvider {
  readonly name: string
  list(): Promise<readonly SkillCandidate[]>
  get(candidate: SkillCandidate): Promise<SkillDefinition>
}

interface SkillCandidate {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean, readonly userInvocable: boolean }
  readonly provider: string
  readonly source: string
  readonly resourceBase: { readonly kind: 'directory', readonly path: string } | undefined
  readonly rank: number
  readonly locator: string
}

interface SkillDefinition {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean, readonly userInvocable: boolean }
  readonly provider: string
  readonly source: string
  readonly resourceBase: { readonly kind: 'directory', readonly path: string } | undefined
  readonly content: string
}

function candidateFor(path: string, docsDirectory: string): SkillCandidate {
  return {
    name: SKILL_NAME,
    description: DESCRIPTION,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: PROVIDER_NAME,
    source: 'plugin',
    resourceBase: { kind: 'directory', path: docsDirectory },
    rank: PACKAGED_RANK,
    locator: path,
  }
}

/**
 * Register the runbook skill on `ctx.skills`.
 *
 * A missing `docs/` directory is not fatal: the plugin still works, the skill
 * is simply not offered. That matches how the rest of the PTC path degrades —
 * a missing optional asset must not take down remote workspaces.
 *
 * @returns the registration disposer, or undefined when the runbook is absent
 */
export function registerUpstreamSkill(ctx: SkillRegistrationContext): (() => void) | undefined {
  const path = runbookPath()
  if (path === undefined) return undefined
  const docsDirectory = dirname(path)
  const candidate = candidateFor(path, docsDirectory)
  const provider: SkillProvider = {
    name: PROVIDER_NAME,
    list: () => Promise.resolve([candidate]),
    get: async requested => ({
      name: requested.name,
      description: requested.description,
      invocation: requested.invocation,
      provider: requested.provider,
      source: requested.source,
      resourceBase: requested.resourceBase,
      content: readFileSync(path, 'utf8'),
    }),
  }
  return ctx.skills.registerProvider(() => provider) as () => void
}
