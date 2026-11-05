import assert from 'node:assert/strict'
import test from 'node:test'
import { composeCreatedPath } from '../src/contain.ts'
import { claimPending } from '../src/pool-claim.ts'
import { fileWriteAllowed, sandboxDenied } from '../src/profile.ts'

test('a symlink parent is judged at its real path, so link → /etc cannot create evil', () => {
  const target = composeCreatedPath('/etc', ['evil'])
  assert.equal(target, '/etc/evil')
  const roots = { workspaceRoot: '/data/app', tmp: '/private/tmp', userTmp: '/var/folders/ab/T' }
  assert.equal(fileWriteAllowed('workspace-write', target, roots), false)
})

test('a symlinked workspace root still allows a new file inside the real directory', () => {
  const target = composeCreatedPath('/data/app', ['a'])
  const roots = { workspaceRoot: '/data/app', tmp: '/tmp', userTmp: '/tmp' }
  assert.equal(fileWriteAllowed('workspace-write', target, roots), true)
})

test('ordinary permission denied is not a sandbox denial', () => {
  assert.equal(sandboxDenied(1, 'git: Permission denied'), false)
  assert.equal(sandboxDenied(1, 'Read-only file system'), true)
  assert.equal(sandboxDenied(1, 'Operation not permitted'), true)
  assert.equal(sandboxDenied(0, 'Read-only file system'), false)
})

test('concurrent claims share one pending connection', async () => {
  const map = new Map<string, Promise<string>>()
  let created = 0
  const first = claimPending(map, 'host', async () => {
    created += 1
    return 'live'
  })
  const second = claimPending(map, 'host', async () => {
    created += 1
    return 'other'
  })
  assert.equal(first, second)
  assert.equal(await first, 'live')
  assert.equal(created, 1)
})
