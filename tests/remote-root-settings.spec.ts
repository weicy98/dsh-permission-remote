import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { apply } from '../src/index.ts'
import { clearSupersededRoots, defaultRemoteRoot, encodeRemotePath, mapRemoteToLocal, remoteRoot, routeByCwd, setRemoteRootOverride } from '../src/router.ts'

/**
 * Editing the remote root through any other surface (the generic settings
 * editor, a hand-written profile) must take effect in the running process.
 *
 * `apply` is wired to the settings document event; these tests emit it the same
 * way the settings service does and read routing back.
 */

function pluginContext(): Context {
  const ctx = new Context()
  ctx.provide('settings', {
    configure: () => () => undefined,
    describe: () => [],
    update: async () => undefined,
  })
  return ctx
}

function emitSettingsUpdated(ctx: Context, ns: string): void {
  // The event name is declared by @deepseek-ai/dsh-settings; cordis itself
  // accepts any name at runtime, so the cast keeps this test self-contained.
  (ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('settings/document-updated', ns, 1)
}

function cleanRouting(): void {
  clearSupersededRoots()
  setRemoteRootOverride(null)
}

test('a root written by another surface is used without a restart', () => {
  const root = createVolatile('/tmp/root-a')
  const ctx = pluginContext()
  try {
    apply(ctx, { hosts: createVolatile([]), deletedHosts: createVolatile([]), remoteRoot: root })
    assert.equal(remoteRoot(), '/tmp/root-a')
    updateVolatile(root, createVolatile('/tmp/root-b'))
    emitSettingsUpdated(ctx, 'permission-remote')
    assert.equal(remoteRoot(), '/tmp/root-b')
  } finally {
    cleanRouting()
  }
})

test('an update for another section leaves the root alone', () => {
  const root = createVolatile('/tmp/root-a')
  const ctx = pluginContext()
  try {
    apply(ctx, { hosts: createVolatile([]), deletedHosts: createVolatile([]), remoteRoot: root })
    updateVolatile(root, createVolatile('/tmp/root-b'))
    emitSettingsUpdated(ctx, 'some-other-plugin')
    assert.equal(remoteRoot(), '/tmp/root-a')
  } finally {
    cleanRouting()
  }
})

test('clearing the setting goes back to the built-in default', () => {
  const root = createVolatile('/tmp/root-a')
  const ctx = pluginContext()
  try {
    apply(ctx, { hosts: createVolatile([]), deletedHosts: createVolatile([]), remoteRoot: root })
    updateVolatile(root, createVolatile(''))
    emitSettingsUpdated(ctx, 'permission-remote')
    assert.equal(remoteRoot(), defaultRemoteRoot())
  } finally {
    cleanRouting()
  }
})

test('a relative root written by hand falls back to the default instead of breaking routing', () => {
  const root = createVolatile('/tmp/root-a')
  const ctx = pluginContext()
  try {
    apply(ctx, { hosts: createVolatile([]), deletedHosts: createVolatile([]), remoteRoot: root })
    updateVolatile(root, createVolatile('relative/root'))
    emitSettingsUpdated(ctx, 'permission-remote')
    assert.equal(remoteRoot(), defaultRemoteRoot())
  } finally {
    cleanRouting()
  }
})

test('a generic settings switch keeps a placeholder from the previous root remote', () => {
  const root = createVolatile('/tmp/root-a')
  const ctx = pluginContext()
  try {
    apply(ctx, { hosts: createVolatile([]), deletedHosts: createVolatile([]), remoteRoot: root })
    assert.equal(remoteRoot(), '/tmp/root-a')
    // The load itself is not a migration: the built-in default was never this process's root.
    const builtinPlaceholder = join(defaultRemoteRoot(), 'host1', encodeRemotePath('/srv/app'))
    assert.equal(routeByCwd(builtinPlaceholder).kind, 'local')
    const captured = mapRemoteToLocal('host1', '/srv/app')!
    assert.equal(captured.startsWith('/tmp/root-a/'), true)

    updateVolatile(root, createVolatile('/tmp/root-b'))
    emitSettingsUpdated(ctx, 'permission-remote')
    assert.equal(remoteRoot(), '/tmp/root-b')
    assert.equal(routeByCwd(captured).kind, 'remote')

    updateVolatile(root, createVolatile(''))
    emitSettingsUpdated(ctx, 'permission-remote')
    assert.equal(remoteRoot(), defaultRemoteRoot())
    assert.equal(routeByCwd(captured).kind, 'remote')

    updateVolatile(root, createVolatile('/tmp/root-c'))
    emitSettingsUpdated(ctx, 'permission-remote')
    updateVolatile(root, createVolatile('relative/root'))
    emitSettingsUpdated(ctx, 'permission-remote')
    assert.equal(remoteRoot(), defaultRemoteRoot())
    const route = routeByCwd(captured)
    assert.equal(route.kind, 'remote')
    assert.equal(route.kind === 'remote' ? route.hostId : '', 'host1')
    assert.equal(route.kind === 'remote' ? route.remoteCwd : '', '/srv/app')
  } finally {
    cleanRouting()
  }
})
