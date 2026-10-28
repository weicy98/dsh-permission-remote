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

test('an active tab is marked without adding a filled control', () => {
  // Two regressions this guards: a misspelled variable dropped the whole
  // declaration, and the theme's layer backgrounds are all one white in its
  // light variant, so a fill could not show the selection even when valid.
  const active = CSS.slice(CSS.indexOf('.dsh-ssh-tab[data-active]'))
  const block = active.slice(0, active.indexOf('}'))
  const names = [...block.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(match => match[1] ?? '')
  for (const name of names) assert.equal(THEME_VARS.has(name), true, name)
  // The state is an underline that sits on the container rule; a fill read as
  // a heavy control, and an inset shadow floated above the rule as a second one.
  assert.match(block, /border-bottom-color:/)
  assert.doesNotMatch(block, /background:/)
  assert.doesNotMatch(block, /box-shadow:/)
})

test('the tab underline reaches the container rule instead of floating above it', () => {
  const tabs = CSS.slice(CSS.indexOf('.dsh-ssh-tabs {'))
  const tabBlock = tabs.slice(0, tabs.indexOf('}'))
  // Without a negative margin the line sits above the rule, leaving two
  // parallel lines a few pixels apart.
  assert.match(tabBlock, /border-bottom:/)
  const tab = CSS.slice(CSS.indexOf('.dsh-ssh-tab {'))
  const rule = tab.slice(0, tab.indexOf('}'))
  assert.match(rule, /margin-bottom:\s*-1px/)
  assert.match(rule, /border-bottom:\s*2px solid transparent/)
})

test('the header row keeps its height whether or not the add button is shown', () => {
  // The button is taller than the title, so on tabs without it the row shrank
  // and everything below moved up by 4px.
  const header = CSS.slice(CSS.indexOf('.dsh-ssh-header {'))
  const block = header.slice(0, header.indexOf('}'))
  assert.match(block, /min-height:/)
  const title = CSS.slice(CSS.indexOf('.dsh-ssh-title {'))
  const titleBlock = title.slice(0, title.indexOf('}'))
  const titleHeight = Number(/line-height:\s*(\d+)px/.exec(titleBlock)?.[1] ?? 0)
  const button = CSS.slice(CSS.indexOf('.dsh-ssh-button {'))
  const buttonBlock = button.slice(0, button.indexOf('}'))
  const buttonHeight = Number(/height:\s*(\d+)px/.exec(buttonBlock)?.[1] ?? 0)
  const reserved = Number(/min-height:\s*(\d+)px/.exec(block)?.[1] ?? 0)
  // The row must reserve at least the taller of the two, or the shorter tab
  // content leaves a gap.
  assert.ok(reserved >= Math.max(titleHeight, buttonHeight), `reserved ${reserved} < ${Math.max(titleHeight, buttonHeight)}`)
})
