import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * Theme variables the DSH client defines. A misspelled name is not an error the
 * browser reports: the declaration is dropped and the rule silently loses that
 * property, so an active tab looks exactly like an inactive one.
 *
 * Mirrors `@deepseek-ai/dsh-client-ui-theme`; extend it when a new token is
 * adopted rather than inventing a name that reads correctly.
 */
const THEME_VARS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-brand-primary',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-inverted',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-settings-card-fill',
  '--dsw-alias-settings-card-stroke',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-label',
  '--dsw-radius-lg',
  '--dsw-radius-md',
  '--dsw-radius-sm',
  '--dsw-radius-xl',
  '--dsw-radius-xs',
])

const CSS = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')

test('every theme variable the stylesheet reads is one the theme defines', () => {
  const used = new Set([...CSS.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(match => match[1] ?? ''))
  assert.ok(used.size > 0, 'no theme variables found; the extraction is broken')
  const unknown = [...used].filter(name => !THEME_VARS.has(name))
  assert.deepEqual(unknown, [], `unknown theme variables: ${unknown.join(', ')}`)
})

test('an active tab is styled by a background the theme actually provides', () => {
  // The regression this guards: `--dsw-alias-bg-l3` does not exist, so the
  // active tab kept only its text weight and looked unstyled.
  const active = CSS.slice(CSS.indexOf('.dsh-ssh-tab[data-active]'))
  const block = active.slice(0, active.indexOf('}'))
  assert.match(block, /background:/)
  const names = [...block.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(match => match[1] ?? '')
  for (const name of names) assert.equal(THEME_VARS.has(name), true, name)
})
