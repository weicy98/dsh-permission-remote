/**
 * Integration test: drive the REAL official DSH 0.2.2 file tools against the
 * plugin's patched `ctx.fs` backed by a fake SFTP pool.
 *
 * A hand-written "replicated call sequence" cannot catch the `str_replace_editor`
 * bug this file exists for: the official `resolveTarget` calls
 * `ctx.fs.resolve(path, { signal })` with NO cwd, so a bare remote absolute path
 * (e.g. `/srv/app/a.ts`) would otherwise fall through to the local filesystem.
 * The plugin's editor shadow rewrites that bare path to the same host's
 * placeholder path before delegating to the official execute — so the official
 * `resolveTarget` sees a placeholder and the fake SFTP pool, never this machine.
 *
 * The official packages are loaded from the globally installed DSH 0.2.2 via
 * `createRequire` + dynamic `import()` (they are NOT in this workspace's
 * dependency tree). If they cannot be loaded, the whole suite SKIPs; the file
 * still typechecks and never fails `npm test`.
 *
 * NOTE on `FsError`: the official packages import `@deepseek-ai/dsh-fs` from
 * DSH's own node_modules (0.2.2-rc.1), while the plugin's `src` imports it from
 * this workspace (0.2.1-rc.3). An `FsError` thrown by one copy is NOT
 * `instanceof` the other. Everything here exercises SUCCESS paths; any failure
 * assertion must compare `error.code` (a string) rather than use `instanceof`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { apply } from '../src/index.ts'
import { mapRemoteToLocal } from '../src/router.ts'
import {
  createHarness, POLICY, remoteCwd, HOST_ID, placeholder, absolutePlaceholder,
  type Harness,
} from './helpers/remote-fs-harness.ts'

// ---------------------------------------------------------------------------
// Load the real official packages from the global DSH installation.
// ---------------------------------------------------------------------------
const ANCHOR = path.resolve(
  path.dirname(process.execPath),
  '../lib/node_modules/@deepseek-ai/dsh/package.json',
)

interface OfficialModules {
  cordis: any
  tools: any
  sysp: any
  scope: any
  fsMod: any
  editorMod: any
  fsCore: any
}

let official: OfficialModules | undefined
try {
  const require = createRequire(ANCHOR)
  const url = (m: string): string => pathToFileURL(require.resolve(m)).href
  const [cordis, tools, sysp, scope, fsMod, editorMod, fsCore] = await Promise.all([
    import(url('@deepseek-ai/cordis')).catch(() => undefined),
    import(url('@deepseek-ai/dsh-tools')).catch(() => undefined),
    import(url('@deepseek-ai/dsh-system-prompt')).catch(() => undefined),
    import(url('@deepseek-ai/dsh-scope')).catch(() => undefined),
    import(url('@deepseek-ai/dsh-tool-fs')).catch(() => undefined),
    import(url('@deepseek-ai/dsh-tool-str-replace-editor')).catch(() => undefined),
    import(url('@deepseek-ai/dsh-fs')).catch(() => undefined),
  ])
  if (cordis && tools && sysp && scope && fsMod && editorMod && fsCore) {
    official = { cordis, tools, sysp, scope, fsMod, editorMod, fsCore }
  }
} catch {
  official = undefined
}

/**
 * CI must not turn a missing official install into a green run. Set
 * `DSH_REQUIRE_OFFICIAL_TOOLS=1` to make the whole suite fail loudly instead of
 * skipping; local development keeps the graceful skip.
 */
const REQUIRE_OFFICIAL = process.env.DSH_REQUIRE_OFFICIAL_TOOLS === '1'
const SKIP: false | string = official
  ? false
  : REQUIRE_OFFICIAL
    ? false
    : 'official DSH 0.2.2 tool packages could not be loaded from the global install'

const SYS_CONFIG = { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' }
// Only `apply_patch` is needed; disabling read/write/edit keeps the composition small.
const FS_CONFIG = {
  read: false, readImage: false, write: false, edit: false, applyPatch: true,
  readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 50 * 1024, readStreamMinSize: 64 * 1024,
}
const EDITOR_CONFIG = { maxOutputChars: 16_000, description: 'view/create/edit files over the Harness filesystem seam' }

const BARE = '/srv/app/a.ts'
const EXPECTED_PLACEHOLDER = mapRemoteToLocal(HOST_ID, BARE)!

/** Build the exact `exec` the official tools expect (agent, signal, callId). */
function execFor(agent: any): any {
  return { agent, signal: new AbortController().signal, callId: 'call-1' }
}

/** All valid str_replace_editor fields present so defineTool never sees a missing key. */
function editorArgs(command: string, filePath: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command, path: filePath,
    file_text: null, insert_line: null, new_str: null, old_str: null, view_range: null,
    ...extra,
  }
}

interface Host {
  ctx: any
  h: Harness
  /** Create a real Cordis agent scope with the given session cwd. */
  addAgent(id: string, cwd: string): Promise<any>
  /** Fire `agent/created` so the plugin mounts its shadows for this agent. */
  created(agent: any): Promise<void>
  /** Resolve a tool for this agent and call its `.execute(args, exec)` directly. */
  call(agent: any, name: string, args: Record<string, unknown>): Promise<any>
  close(): Promise<void>
}

/** Filesystem methods the official tools call and whose errors they inspect. */
const FS_ERROR_METHODS = [
  'resolve', 'lstat', 'stat', 'listDir', 'readText', 'streamText',
  'readBytes', 'readByteRange', 'writeText', 'editText',
  'patchText', 'deleteFile', 'moveFile',
] as const

/**
 * Model a deployment where this plugin and the official tools share ONE
 * `@deepseek-ai/dsh-fs` instance.
 *
 * The real host installs the plugin from this repo, whose `node_modules` holds
 * dsh-fs 0.2.1-rc.3, while the official tools import DSH's own 0.2.2-rc.1. Two
 * copies of the class mean `instanceof FsError` in `dsh-tool-fs` is false for
 * plugin errors, so its structured `failed` / `unknown` records are unreachable
 * (documented as M-1). This wrapper re-throws plugin errors as the official
 * class so the structured path can be exercised; it changes nothing else.
 */
function alignFsErrors(h: Harness, FsErrorCtor: any): void {
  const fs = h.fs as Record<string, any>
  const convert = (error: any): unknown => {
    if (error instanceof FsErrorCtor) return error
    if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
      return new FsErrorCtor(error.message, error.code)
    }
    return error
  }
  for (const name of FS_ERROR_METHODS) {
    const original = fs[name]
    if (typeof original !== 'function') continue
    fs[name] = function (this: unknown, ...args: unknown[]): unknown {
      try {
        const out = original.apply(this, args)
        return out instanceof Promise ? out.catch((error: unknown) => { throw convert(error) }) : out
      } catch (error) {
        throw convert(error)
      }
    }
  }
}

async function boot(opts: { official?: boolean } = {}): Promise<Host> {
  const o = official!
  const ctx = new o.cordis.Context()
  await ctx.plugin(o.sysp.SystemPrompt, SYS_CONFIG)
  await ctx.plugin(o.tools.ToolRuntime)

  const h = createHarness()
  const cwdOf = (x: any): string => x?.session?.header?.cwd ?? x?.header?.cwd ?? remoteCwd
  ctx.provide('fs', h.fs)
  ctx.provide('workingDirectory', {
    ensure: async (who: any) => cwdOf(who),
    get: (session: any) => cwdOf(session),
  })
  ctx.provide('sandboxPolicy', { resolve: () => POLICY })
  ctx.provide('settings', { configure: () => () => undefined, describe: () => [], update: async () => undefined })
  ctx.provide('credentials', { readRecord: async () => undefined, modifyRecord: async () => undefined })
  ctx.provide('workspaceRegistry', { list: () => [] })
  ctx.provide('approval', {})

  // Mount the plugin FIRST. Its `inject(['fs'])` install sees the marker our
  // harness already set and no-ops, so our fake SFTP pool stays authoritative.
  apply(ctx, { hosts: [], maxConnections: 4 })

  if (opts.official !== false) {
    // Register the official tools on the root so every agent's scope sees them.
    await ctx.plugin(o.fsMod, FS_CONFIG)
    await ctx.plugin(o.editorMod, EDITOR_CONFIG)
  }

  const scopes: any[] = []
  async function addAgent(id: string, cwd: string): Promise<any> {
    const agent: any = { session: { id, header: { cwd } } }
    const s = o.scope.createScope(ctx, agent)
    scopes.push(s)
    let child: any
    await s.ctx.inject(['tools', 'systemPrompt'], (c: any) => { child = c })
    if (child === undefined) throw new Error('agent scope did not start')
    agent.ctx = child
    return agent
  }
  async function created(agent: any): Promise<void> {
    await ctx.serial('agent/created', { agent })
  }
  async function call(agent: any, name: string, args: Record<string, unknown>): Promise<any> {
    const tool = agent.ctx.tools.get(name, agent)
    assert.ok(tool, `tool ${name} must be visible for the agent`)
    return tool.execute(args, execFor(agent))
  }
  async function close(): Promise<void> {
    h.remove()
    for (const s of scopes) {
      try { await s.dispose?.() } catch { /* best effort */ }
    }
  }
  return { ctx, h, addAgent, created, call, close }
}

test('the real official DSH 0.2.2 tool packages are loadable', { skip: SKIP }, () => {
  assert.ok(official, 'official packages missing; set DSH_REQUIRE_OFFICIAL_TOOLS=1 to fail in CI')
})

// ---------------------------------------------------------------------------
// (a) apply_patch: add/update/delete/move through the official preflight+commit
// ---------------------------------------------------------------------------
test('apply_patch add/update/delete/move run the official code path against the remote pool', { skip: SKIP }, async () => {
  const host = await boot()
  try {
    const agent = await host.addAgent('session-1', remoteCwd)
    await host.created(agent)
    host.h.setFile('/srv/app/keep.ts', 'alpha\nbeta\n')
    host.h.setFile('/srv/app/gone.ts', 'delete me\n')
    host.h.setFile('/srv/app/moveme.ts', 'move me\n')
    host.h.reset()

    // Add (relative) + Add (remote-real-absolute). `apply_patch` DOES pass a
    // cwd to ctx.fs.resolve, so both a relative path and a bare remote absolute
    // path are anchored onto the same remote host.
    await host.call(agent, 'apply_patch', {
      input: [
        '*** Begin Patch',
        '*** Add File: added.txt',
        '+hello added',
        '*** Add File: /srv/app/absolute.txt',
        '+absolute remote path',
        '*** End Patch',
      ].join('\n'),
    })
    assert.ok(
      host.h.writes.some(w => w.stdin === 'hello added\n' || w.stdin === 'hello added'),
      'relative add publishes content to the remote host',
    )
    assert.ok(
      host.h.writes.some(w => (w.stdin ?? '').includes('absolute remote path')),
      'remote-real-absolute add publishes content to the remote host',
    )
    assert.ok(host.h.poolPaths.includes('/srv/app/absolute.txt'), 'the pool saw the bare remote absolute patch path')

    host.h.reset()
    await host.call(agent, 'apply_patch', {
      input: ['*** Begin Patch', '*** Update File: keep.ts', '@@', ' alpha', '-beta', '+BETA', '*** End Patch'].join('\n'),
    })
    assert.ok(host.h.writes.some(w => (w.stdin ?? '').includes('BETA')), 'update patches content remotely')

    host.h.reset()
    await host.call(agent, 'apply_patch', {
      input: ['*** Begin Patch', '*** Delete File: gone.ts', '*** End Patch'].join('\n'),
    })
    assert.ok(host.h.commands.some(c => c.includes('rm -- ')), 'delete runs a remote rm script')

    host.h.reset()
    await host.call(agent, 'apply_patch', {
      input: [
        '*** Begin Patch', '*** Update File: moveme.ts', '*** Move to: moved.ts', '@@', ' move me', '*** End Patch',
      ].join('\n'),
    })
    assert.ok(host.h.commands.some(c => c.includes('rm -- ')), 'move removes the remote source')
    assert.ok(host.h.writes.some(w => (w.stdin ?? '').includes('move me')), 'move publishes the remote destination')

    // None of these operations ever fell through to the local provider.
    assert.equal(host.h.decoyWrites(), 0)
    assert.deepEqual(host.h.localWrites, [])
    assert.equal(readFileSync(host.h.decoyFile, 'utf8'), host.h.decoyContent, 'local decoy untouched')
  } finally {
    await host.close()
  }
})

test('apply_patch preflight refusal writes nothing to the remote host', { skip: SKIP }, async () => {
  const host = await boot()
  try {
    const agent = await host.addAgent('session-1', remoteCwd)
    await host.created(agent)
    host.h.setFile('/srv/app/keep.ts', 'alpha\nbeta\n')
    host.h.reset()
    // The hunk cannot match, so the whole patch must be refused before any
    // commit: not a single content-bearing exec may reach the host.
    // The official tool throws a structured refusal ("Patch rejected before any
    // change") instead of returning a value; what matters here is that the
    // remote host saw no content-bearing command.
    await assert.rejects(
      () => host.call(agent, 'apply_patch', {
        input: ['*** Begin Patch', '*** Update File: keep.ts', '@@', ' -not present', '+x', '*** End Patch'].join('\n'),
      }),
      (error: any) => {
        assert.equal(error.code, 'FS_PATCH_MISMATCH')
        assert.match(String(error.message), /rejected before any change/)
        return true
      },
    )
    assert.equal(host.h.writes.filter(entry => entry.stdin !== undefined).length, 0, 'preflight must not write')
    assert.equal(host.h.getFile('/srv/app/keep.ts'), 'alpha\nbeta\n', 'the remote file is untouched')
  } finally {
    await host.close()
  }
})

test('apply_patch reports an uncertain commit as unknown when the fs classes align', { skip: SKIP }, async () => {
  const host = await boot()
  try {
    alignFsErrors(host.h, official!.fsCore.FsError)
    const agent = await host.addAgent('session-1', remoteCwd)
    await host.created(agent)
    host.h.setFile('/srv/app/keep.ts', 'alpha\nbeta\n')
    host.h.reset()
    // The rename lands, then the command fails (e.g. a later chmod). The
    // plugin must drop its stat cache so apply_patch's `unchanged` probe sees
    // the new content and records `unknown` rather than `failed`.
    host.h.setExecOverride((command, stdin) => {
      if (stdin !== undefined && command.includes('mv -f')) {
        host.h.setFile('/srv/app/keep.ts', stdin)
        return { code: 1, signal: null, stdout: '', stderr: 'remote write failed after rename', timedOut: false, stdoutTruncated: false, stderrTruncated: false }
      }
      return undefined
    })
    const result: any = await host.call(agent, 'apply_patch', {
      input: ['*** Begin Patch', '*** Update File: keep.ts', '@@', ' alpha', '-beta', '+BETA-LONGER', '*** End Patch'].join('\n'),
    })
    host.h.setExecOverride(undefined)
    assert.match(host.h.getFile('/srv/app/keep.ts') ?? '', /BETA-LONGER/, 'the rename did land on the remote host')
    assert.equal(result.operations?.[0]?.status, 'unknown', `expected an unknown outcome, got: ${JSON.stringify(result)}`)
  } finally {
    await host.close()
  }
})

test('a commit failure in the shipped two-copy layout surfaces a typed error and drops the cache', { skip: SKIP }, async () => {
  const host = await boot()
  try {
    const agent = await host.addAgent('session-1', remoteCwd)
    await host.created(agent)
    host.h.setFile('/srv/app/keep.ts', 'alpha\nbeta\n')
    host.h.reset()
    const target = await host.h.fs.resolve('/srv/app/keep.ts', { cwd: remoteCwd })
    const before = await host.h.fs.stat(target)
    host.h.setExecOverride((command, stdin) => {
      if (stdin !== undefined && command.includes('mv -f')) {
        host.h.setFile('/srv/app/keep.ts', stdin)
        return { code: 1, signal: null, stdout: '', stderr: 'remote write failed after rename', timedOut: false, stdoutTruncated: false, stderrTruncated: false }
      }
      return undefined
    })
    await assert.rejects(
      () => host.call(agent, 'apply_patch', {
        input: ['*** Begin Patch', '*** Update File: keep.ts', '@@', ' alpha', '-beta', '+BETA-LONGER', '*** End Patch'].join('\n'),
      }),
      // Cross-copy `FsError` (M-1): the official tool cannot recognise this
      // plugin's class, so the typed error escapes instead of a record.
      (error: any) => error.code === 'FS_IO_ERROR',
    )
    host.h.setExecOverride(undefined)
    const after = await host.h.fs.stat(await host.h.fs.resolve('/srv/app/keep.ts', { cwd: remoteCwd }))
    assert.ok(after)
    assert.notEqual(after.version, before?.version, 'the stat cache must not hide the applied change')
  } finally {
    await host.close()
  }
})

test('str_replace_editor view/create/str_replace/insert run the official code path on placeholder paths', { skip: SKIP }, async () => {
  const host = await boot()
  try {
    const agent = await host.addAgent('session-1', remoteCwd)
    await host.created(agent)

    const edit = placeholder('edit.ts')
    host.h.setFile('/srv/app/edit.ts', 'alpha\nbeta\ngamma\n')

    const view = await host.call(agent, 'str_replace_editor', editorArgs('view', edit))
    assert.match(String(view), /beta/, 'view returns the remote file content')

    const fresh = placeholder('fresh.ts')
    const created = await host.call(agent, 'str_replace_editor', editorArgs('create', fresh, { file_text: 'brand new\n' }))
    assert.match(String(created), /created successfully/, 'create succeeds through the official execute')

    const replaced = await host.call(agent, 'str_replace_editor', editorArgs('str_replace', edit, { old_str: 'beta', new_str: 'BETA' }))
    assert.match(String(replaced), /edited successfully/, 'str_replace succeeds')

    const inserted = await host.call(agent, 'str_replace_editor', editorArgs('insert', edit, { insert_line: 1, new_str: 'inserted' }))
    assert.match(String(inserted), /edited successfully/, 'insert succeeds')

    assert.ok(host.h.writes.some(w => (w.stdin ?? '').includes('brand new')), 'create published to the pool')
    assert.ok(host.h.writes.some(w => (w.stdin ?? '').includes('BETA')), 'str_replace published to the pool')
    assert.ok(host.h.poolPaths.includes('/srv/app/edit.ts'), 'the pool served the placeholder path')
    assert.equal(host.h.decoyReads(), 0, 'the local decoy was never read')
    assert.equal(readFileSync(host.h.decoyFile, 'utf8'), host.h.decoyContent)
  } finally {
    await host.close()
  }
})

test('str_replace_editor view lists a remote directory', { skip: SKIP }, async () => {
  const host = await boot()
  try {
    const agent = await host.addAgent('session-1', remoteCwd)
    await host.created(agent)
    host.h.setFile('/srv/app/pkg/a.ts', 'aaa\n')
    host.h.setFile('/srv/app/pkg/b.ts', 'bbb\n')
    host.h.setDir('/srv/app/pkg', [
      { name: 'a.ts', type: 'file', size: 4, mtime: 7 },
      { name: 'b.ts', type: 'file', size: 4, mtime: 7 },
    ])
    host.h.reset()
    const text = String(await host.call(agent, 'str_replace_editor', editorArgs('view', '/srv/app/pkg')))
    assert.match(text, /a\.ts/, `directory view must list the remote children: ${text}`)
    assert.match(text, /b\.ts/)
    assert.equal(host.h.decoyReads(), 0, 'the local decoy was never read')
  } finally {
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// (c) THE KEY REGRESSION: a bare remote absolute path must be rewritten to the
//     SAME host's placeholder, so the official resolveTarget (which omits cwd)
//     lands on the fake SFTP pool and never on the local filesystem.
// ---------------------------------------------------------------------------
test('str_replace_editor rewrites a bare remote absolute path to the same-host placeholder', { skip: SKIP }, async () => {
  const host = await boot()
  try {
    const agent = await host.addAgent('session-1', remoteCwd)
    await host.created(agent)
    host.h.setFile(BARE, 'REMOTE-CONTENT-ALPHA\nremote second line\n')
    host.h.reset()

    const result = await host.call(agent, 'str_replace_editor', editorArgs('view', BARE))
    const text = String(result)

    // The official tool resolved the bare path to the same-host placeholder.
    assert.ok(
      host.h.resolveCalls.includes(EXPECTED_PLACEHOLDER),
      `ctx.fs.resolve must receive ${EXPECTED_PLACEHOLDER}; got ${JSON.stringify(host.h.resolveCalls)}`,
    )
    assert.ok(!host.h.resolveCalls.includes(BARE), 'the bare local path must never reach ctx.fs.resolve')
    assert.match(text, /REMOTE-CONTENT-ALPHA/, 'view returns the REMOTE file content')
    assert.doesNotMatch(text, /DECOY LOCAL CONTENT/, 'view never returns the local decoy content')

    // The fake SFTP pool saw the remote path, and the local stub was never asked
    // to resolve (or read) the bare path as a local file.
    assert.ok(host.h.poolPaths.includes(BARE), `the fake SFTP pool must see ${BARE}; got ${JSON.stringify(host.h.poolPaths)}`)
    assert.ok(!host.h.localResolveCalls.includes(BARE), 'local fs.resolve never delegated the bare path')
    assert.equal(host.h.decoyReads(), 0, 'the decoy file was never read')
    assert.equal(host.h.decoyWrites(), 0, 'the decoy file was never written')
    assert.equal(readFileSync(host.h.decoyFile, 'utf8'), host.h.decoyContent, 'decoy content unchanged')
    assert.ok(text.includes(EXPECTED_PLACEHOLDER), 'the model sees the placeholder spelling')
  } finally {
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// (d) placeholder passes through unchanged; a local session passes through to
//     the official tool with its original (unrewritten) args.
// ---------------------------------------------------------------------------
test('a placeholder path is passed through and a local session uses the official tool as-is', { skip: SKIP }, async () => {
  const host = await boot()
  try {
    const remote = await host.addAgent('session-1', remoteCwd)
    const local = await host.addAgent('session-local', '/tmp/local-project')
    await host.created(remote)
    await host.created(local)
    host.h.setFile(BARE, 'REMOTE-PASSTHROUGH\n')

    // Placeholder absolute path: the shadow leaves it untouched.
    host.h.reset()
    const viaPlaceholder = await host.call(remote, 'str_replace_editor', editorArgs('view', EXPECTED_PLACEHOLDER))
    assert.ok(host.h.resolveCalls.includes(EXPECTED_PLACEHOLDER), 'placeholder reaches fs.resolve unchanged')
    assert.ok(!host.h.resolveCalls.includes(BARE))
    assert.match(String(viaPlaceholder), /REMOTE-PASSTHROUGH/)

    // Local session: no rewrite, so the bare absolute path is handed straight
    // to the official resolveTarget and falls through to the local provider.
    host.h.reset()
    const localView = await host.call(local, 'str_replace_editor', editorArgs('view', BARE))
    assert.ok(host.h.resolveCalls.includes(BARE), 'local session passes the original bare path to the official tool')
    assert.ok(!host.h.resolveCalls.includes(EXPECTED_PLACEHOLDER), 'local session does NOT rewrite to a placeholder')
    assert.ok(host.h.localResolveCalls.includes(BARE), 'the local provider resolves the bare path')
    assert.match(String(localView), /DECOY LOCAL CONTENT/, 'official tool read the local filesystem as expected')
  } finally {
    await host.close()
  }
})

// ---------------------------------------------------------------------------
// (e) When no editor shadow is mounted, the guard refuses a bare remote
//     absolute path with a "no path-rewriting shadow" message and the decoy is
//     untouched. Captured via a hand-written agent ctx so we can inspect the
//     guard the plugin registers on `tools.guard`.
// ---------------------------------------------------------------------------
test('a bare remote path is refused by the guard when no editor shadow is mounted', { skip: SKIP }, async () => {
  const o = official!
  const ctx = new o.cordis.Context()
  await ctx.plugin(o.sysp.SystemPrompt, SYS_CONFIG)
  await ctx.plugin(o.tools.ToolRuntime)
  const h = createHarness()
  const cwdOf = (x: any): string => x?.session?.header?.cwd ?? x?.header?.cwd ?? remoteCwd
  ctx.provide('fs', h.fs)
  ctx.provide('workingDirectory', { ensure: async (who: any) => cwdOf(who), get: (s: any) => cwdOf(s) })
  ctx.provide('sandboxPolicy', { resolve: () => POLICY })
  ctx.provide('settings', { configure: () => () => undefined, describe: () => [], update: async () => undefined })
  ctx.provide('credentials', { readRecord: async () => undefined, modifyRecord: async () => undefined })
  ctx.provide('workspaceRegistry', { list: () => [] })
  ctx.provide('approval', {})

  apply(ctx, { hosts: [], maxConnections: 4 })
  // NOTE: the official str_replace_editor is deliberately NOT mounted, so
  // `editorShadowReady` is false and the permanent guard refuses bare paths.

  const guards: Array<(exec: any) => string | undefined> = []
  const cleanups: Array<() => void> = []
  const agent: any = {
    session: { id: 'session-1', header: { cwd: remoteCwd } },
    ctx: {
      tools: {
        get: () => undefined,
        register: () => () => undefined,
        restrict: () => () => undefined,
        guard: (fn: (exec: any) => string | undefined) => { guards.push(fn); return () => undefined },
      },
      systemPrompt: {
        section: () => () => undefined,
        getSectionOrder: () => 1000,
        context: () => () => undefined,
        getContextOrder: () => 100,
      },
      on: () => () => undefined,
      get: () => undefined,
      effect: (fn: () => unknown) => { const d = fn(); if (typeof d === 'function') cleanups.push(d as () => void) },
    },
  }

  await ctx.serial('agent/created', { agent })
  assert.ok(guards.length > 0, 'the plugin must install a guard')

  const execution = { name: 'str_replace_editor', arguments: editorArgs('view', BARE), agent }
  const reasons = guards.map(g => g(execution)).filter((r): r is string => typeof r === 'string')
  assert.ok(
    reasons.some(r => r.includes('no path-rewriting shadow')),
    `guard must refuse with the shadow message; got ${JSON.stringify(reasons)}`,
  )
  assert.equal(h.decoyReads(), 0, 'the guard stopped before any local read')
  assert.equal(readFileSync(h.decoyFile, 'utf8'), h.decoyContent, 'decoy content unchanged')
  h.remove()
  for (const c of cleanups) { try { c() } catch { /* best effort */ } }
})
