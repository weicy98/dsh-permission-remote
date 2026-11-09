import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { probePresentContract } from '../src/upstream-worker.ts'

/**
 * The delivery contract `present` staging depends on.
 *
 * `probePresentContract` reads the installed package, so a fixture tree stands
 * in for the DSH install here. The two shapes that matter are the ones the real
 * build uses today (`lstat(path, { cwd })` inline, `resolve(path, options)` with
 * `options = { cwd, signal }`) and a future one passing the literal object to
 * both.
 */
function install(source: string | undefined): { root: string, dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-present-probe-'))
  if (source !== undefined) {
    const dir = join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-present', 'lib')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.js'), source)
  }
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) }
}

const WITH_OPTIONS_BINDING = `
const options = { cwd, signal: exec.signal };
const entry = await ctx.fs.lstat(file.path, { cwd }, exec.signal);
const target = await ctx.fs.resolve(file.path, options);
const info = await ctx.fs.stat(target, exec.signal);
files.push({ ...file, path: ctx.fs.processPath(target) });
`

const WITH_LITERALS = `
const target = await ctx.fs.resolve(file.path, { cwd, signal: exec.signal });
const entry = await ctx.fs.lstat(file.path, { cwd }, exec.signal);
const info = await ctx.fs.stat(target, exec.signal);
files.push({ ...file, path: ctx.fs.processPath(target) });
`

test('the current present implementation satisfies the delivery contract', () => {
  const fixture = install(WITH_OPTIONS_BINDING)
  try {
    const probe = probePresentContract(fixture.root)
    assert.deepEqual(probe.failures, [])
    assert.equal(probe.lstatWithCwd, true)
    assert.equal(probe.resolveWithCwd, true)
    assert.equal(probe.statsResolved, true)
    assert.equal(probe.recordsProcessPath, true)
  } finally {
    fixture.dispose()
  }
})

test('an inline options literal satisfies the delivery contract too', () => {
  const fixture = install(WITH_LITERALS)
  try {
    assert.deepEqual(probePresentContract(fixture.root).failures, [])
  } finally {
    fixture.dispose()
  }
})

test('losing the Session cwd is reported, because the snapshot carve-out would stop being exercised', () => {
  const fixture = install(`
const entry = await ctx.fs.lstat(file.path, {}, exec.signal);
const target = await ctx.fs.resolve(file.path, {});
const info = await ctx.fs.stat(target, exec.signal);
files.push({ path: ctx.fs.processPath(target) });
`)
  try {
    const probe = probePresentContract(fixture.root)
    assert.equal(probe.lstatWithCwd, false)
    assert.equal(probe.resolveWithCwd, false)
    assert.ok(probe.failures.some(f => /lstat with the Session cwd/u.test(f)))
    assert.ok(probe.failures.some(f => /resolve with the Session cwd/u.test(f)))
  } finally {
    fixture.dispose()
  }
})

test('recording the raw argument instead of the resolved target is reported', () => {
  const fixture = install(`
const options = { cwd, signal: exec.signal };
const entry = await ctx.fs.lstat(file.path, { cwd }, exec.signal);
const target = await ctx.fs.resolve(file.path, options);
const info = await ctx.fs.stat(target, exec.signal);
files.push({ ...file, path: file.path });
`)
  try {
    const probe = probePresentContract(fixture.root)
    assert.equal(probe.recordsProcessPath, false)
    assert.ok(probe.failures.some(f => /processPath/u.test(f)))
  } finally {
    fixture.dispose()
  }
})

test('a missing package is not drift: a composition may not mount present at all', () => {
  const fixture = install(undefined)
  try {
    const probe = probePresentContract(fixture.root)
    // The plugin never reaches `runPresent` without the tool, so absent is not
    // a contract change. Reporting it would make `check:upstream` red for every
    // slimmed install.
    assert.deepEqual(probe.failures, [])
    assert.equal(probe.lstatWithCwd, false)
  } finally {
    fixture.dispose()
  }
})
