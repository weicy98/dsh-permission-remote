import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The built browser bundle, exercised through the same `window.__ModuleLoader__`
 * contract the shell uses. Rendering is out of scope here: the seeded React is
 * a stub, so these assertions cover what `apply` registers, not what it draws.
 */
interface Registration {
  options: { name: string, id?: string, key?: string, order?: number, label?: string | (() => string), inject?: () => unknown }
  component: unknown
}

function loadBundle(): { apply: (ctx: unknown) => void, inject: string[] } {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let factory: ((require: (name: string) => unknown) => { apply: (ctx: unknown) => void, inject: string[] }) | undefined
  const stub = { createElement: () => null, Fragment: null, useState: () => [], useEffect: () => {}, useRef: () => ({ current: null }) }
  new Function('window', code)({ __ModuleLoader__: { load: (entry: { factory: typeof factory }) => { factory = entry.factory } } })
  assert.ok(factory !== undefined, 'the bundle did not register a factory')
  return factory((name: string) => {
    if (name === 'react' || name === 'react/jsx-runtime') return stub
    throw new Error(`bundle required an unexpected module: ${name}`)
  })
}

const PANEL_ID = 'permission-remote'

function applyBundle(): { registrations: Registration[], closed: Array<string | null>, disposed: number } {
  const registrations: Registration[] = []
  const closed: Array<string | null> = []
  const state = { disposed: 0 }
  const bundle = loadBundle()
  bundle.apply({
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: (options: Registration['options'], component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect: (dispose: () => void) => {
      state.disposed++
      return dispose()
    },
    get: (name: string) => name === 'layout' ? { selectPanel: (id: string | null) => closed.push(id) } : undefined,
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    remote: { settings: { describe: async () => ({ namespaces: [] }), mutate: async () => undefined } },
  })
  return { registrations, closed, disposed: state.disposed }
}

test('the sidebar row and the main panel share one id', () => {
  // The sidebar resolves a row's id against the layout's keyed main slot, so a
  // mismatched pair throws on click instead of opening the page.
  const { registrations } = applyBundle()
  const list = registrations.find(row => row.options.name === 'sidebar.panellist')
  const page = registrations.find(row => row.options.name === 'main')
  assert.ok(list !== undefined, 'no sidebar.panellist registration')
  assert.ok(page !== undefined, 'no main registration')
  assert.equal(list.options.id, PANEL_ID)
  assert.equal(page.options.key, PANEL_ID)
})

test('the panel row lands after the shipped rows and carries a locale key', () => {
  const { registrations } = applyBundle()
  const list = registrations.find(row => row.options.name === 'sidebar.panellist')!
  // Plugins is 0 and the task manager 10; a row at 0 would tie with Plugins and
  // depend on registration order for its position.
  assert.equal(list.options.order, 30)
  const label = list.options.label
  assert.equal(typeof label, 'function')
  // A thunk is re-read on every projection, so the row follows the locale
  // without re-registering; the key must exist in both dictionaries.
  assert.equal((label as () => string)(), 'panel')
})

test('the settings section survives a host without the panel slots', () => {
  // Older hosts own neither `main` nor `sidebar.panellist`; the settings entry
  // is the only way in there and must still register.
  const registrations: Registration[] = []
  const bundle = loadBundle()
  bundle.apply({
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots: {
      inject: (name: string, register: () => () => void) => {
        // Only the settings contract is declared here.
        if (name !== 'settings.section') return () => {}
        return register()
      },
      register: (options: Registration['options'], component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect: (dispose: () => void) => dispose(),
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    remote: { settings: { describe: async () => ({ namespaces: [] }), mutate: async () => undefined } },
  })
  assert.deepEqual(registrations.map(row => row.options.name), ['settings.section'])
})

test('closing the panel returns to the conversation without touching a Session', () => {
  const { registrations, closed } = applyBundle()
  const page = registrations.find(row => row.options.name === 'main')!
  const injected = page.options.inject?.() as { onClose?: () => void }
  assert.equal(typeof injected.onClose, 'function')
  injected.onClose?.()
  assert.deepEqual(closed, [null])
})

test('a host without the layout service closes the panel without throwing', () => {
  const registrations: Registration[] = []
  const bundle = loadBundle()
  bundle.apply({
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    slots: {
      inject: (_name: string, register: () => () => void) => register(),
      register: (options: Registration['options'], component: unknown) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect: (dispose: () => void) => dispose(),
    connection: { rpc: { call: async () => ({ ok: true, value: {} }) } },
    remote: { settings: { describe: async () => ({ namespaces: [] }), mutate: async () => undefined } },
  })
  const page = registrations.find(row => row.options.name === 'main')!
  const injected = page.options.inject?.() as { onClose?: () => void }
  assert.doesNotThrow(() => injected.onClose?.())
})
