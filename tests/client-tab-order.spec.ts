import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The picker keeps one order: the DOM order it is drawn in is the order Tab
 * walks and the order a screen reader reads. Nothing repaints it.
 *
 * The box therefore cannot be the panel's first Tab stop — the toolbar and the
 * breadcrumb sit above it — and the way in is focus plus the hint that says so.
 * Neither can be exercised without a DOM, so these assertions pin what the
 * source states: the JSX order, the absence of `order` juggling, the focus
 * effect, and the hint that replaced the structural guarantee.
 */
const JSX = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const CSS = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')

function pickerOf(): string {
  const start = JSX.indexOf('function renderBrowser')
  assert.notEqual(start, -1, 'renderBrowser is missing')
  // Up to the page's own JSX, which follows the picker and is not part of it.
  const end = JSX.indexOf('<section className="dsh-ssh-page">', start)
  assert.notEqual(end, -1, 'the page JSX after the picker is missing')
  return JSX.slice(start, end)
}

test('the picker is drawn in the order it is tabbed through', () => {
  const picker = pickerOf()
  // Exact markers: `dsh-ssh-dirs` also appears in the box's aria-controls, and
  // `dsh-ssh-browser-head` would also match the heading inside the head.
  const head = picker.indexOf('className="dsh-ssh-browser-head"')
  const crumbs = picker.indexOf('className="dsh-ssh-breadcrumb"')
  const filter = picker.indexOf('className="dsh-ssh-browser-filter"')
  const listing = picker.indexOf('id="dsh-ssh-dirs"')
  for (const [name, at] of [['head', head], ['breadcrumb', crumbs], ['filter', filter], ['listing', listing]] as const) {
    assert.notEqual(at, -1, `${name} is not rendered`)
  }
  // Source order is visual order: head, breadcrumb, box, then the listing. A
  // keyboard user tabs the panel the way they read it, and the listing never
  // ends up between the box and the toolbar it belongs to.
  assert.ok(head < crumbs && crumbs < filter && filter < listing,
    'the picker DOM order must follow its visual order')
})

test('the stylesheet does not repaint an order the DOM already has', () => {
  // `order` is how the box used to be moved to the front of the Tab sequence.
  // It also made keyboard order disagree with reading and visual order, and it
  // put the toolbar and close button behind every listing row. The way in is
  // focus now, so an `order` here would silently undo that.
  assert.doesNotMatch(CSS, /(^|\n)\s*order:\s*\d/, 'the picker must not set `order`')
})

test('opening the picker, or walking into another directory, focuses the box', () => {
  // This is the replacement for the structural guarantee: focus is the only way
  // into the box, so the effect must stay and must follow both the host that
  // was opened and the directory that was listed.
  const at = JSX.indexOf("The filter box is the picker's keyboard entry point")
  assert.notEqual(at, -1, 'the focus effect is missing')
  const body = JSX.slice(at, JSX.indexOf('}, [browsing, dir])', at))
  assert.match(body, /searchRef\.current\?\.focus\(\{ preventScroll: true \}\)/)
  // A coarse pointer keeps its exception: focusing there raises the soft
  // keyboard over the listing that was just opened.
  assert.match(body, /pointer: coarse/)
})

test('a typed path is completed in the listing, not turned into an "open" row', () => {
  const picker = pickerOf()
  // The path lives in the box: the rows below are the children of the directory
  // before its last separator. The old "Open <path>" row is gone with that
  // model, and the matched part of a name is marked so the row shows what it
  // would add to the box.
  assert.ok(!picker.includes('dsh-ssh-goto'), 'the open-path row is back')
  assert.ok(picker.includes('className="dsh-ssh-complete"'), 'the completion line is missing')
  assert.ok(picker.includes('matchRange(entry.name, needle)'), 'rows do not mark the matched segment')
  // The line only appears while a segment is being typed; a finished path has
  // nothing to complete, so it would just repeat the breadcrumb. It is also
  // what the box describes itself with in that state.
  assert.match(picker, /context !== null && needle\.length > 0/)
  assert.match(picker, /aria-describedby=\{[^}]*'dsh-ssh-complete'/)
})

test('the empty box says where Tab and / go, and names itself to screen readers', () => {
  const picker = pickerOf()
  const hint = picker.indexOf('className="dsh-ssh-filter-hint"')
  assert.notEqual(hint, -1, 'the filter hint is missing')
  assert.ok(picker.includes('id="dsh-ssh-filter-hint"'), 'the hint has no id for the box to point at')
  // The box describes itself with whichever of the two lines is on screen: the
  // hint while it is empty, the segment being completed while it holds a path.
  assert.match(picker, /aria-describedby=\{[^}]*'dsh-ssh-filter-hint'/, 'the box does not point at the hint')
  // One slot with the match count: the hint shows while the box is empty, the
  // count while it is not, so the row never grows.
  const before = picker.slice(Math.max(0, hint - 400), hint)
  assert.match(before, /filter\.trim\(\)\.length === 0/)
  // A missing key renders as the key itself, so both locales must carry it.
  for (const file of ['../locale/en.json', '../locale/zh.json']) {
    const table = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8')) as Record<string, string>
    assert.ok((table.filterHint ?? '').length > 0, `${file} is missing filterHint`)
  }
})
