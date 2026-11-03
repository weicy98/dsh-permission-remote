import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { childDirectoryPath, isValidHostId, listingPath, mapRemoteToLocal, normalizeRemoteDirectory, resolveRemotePath, routeByCwd, toModelPath, workspaceBinding } from '../src/router.ts'

const env = { DSH_HOME: '/tmp/dsh-home' }

test('placeholder path round-trips through the session cwd', () => {
  const local = mapRemoteToLocal('host1', '/srv/app', env)
  assert.ok(local)
  const route = routeByCwd(local!, env)
  assert.equal(route.kind, 'remote')
  if (route.kind !== 'remote') return
  assert.equal(route.hostId, 'host1')
  assert.equal(route.remoteCwd, '/srv/app')
  assert.equal(routeByCwd('/home/me/project', env).kind, 'local')
})

test('relative and placeholder paths re-anchor to the remote directory', () => {
  const local = mapRemoteToLocal('host1', '/srv/app', env)!
  const route = routeByCwd(local, env)
  assert.equal(route.kind, 'remote')
  if (route.kind !== 'remote') return
  assert.equal(resolveRemotePath('src/main.ts', route.remoteCwd, route.placeholderCwd), '/srv/app/src/main.ts')
  assert.equal(resolveRemotePath('/etc/passwd', route.remoteCwd, route.placeholderCwd), '/etc/passwd')
  const nested = path.join(local, 'src', 'main.ts')
  assert.equal(resolveRemotePath(nested, route.remoteCwd, route.placeholderCwd), '/srv/app/src/main.ts')
})

test('workspace binding keeps the encoded root and drops subdirectory segments', () => {
  const local = mapRemoteToLocal('host1', '/srv/app', env)!
  assert.deepEqual(workspaceBinding(local, env), { hostId: 'host1', remotePath: '/srv/app' })
  assert.deepEqual(workspaceBinding(path.join(local, 'src'), env), { hostId: 'host1', remotePath: '/srv/app' })
  assert.equal(workspaceBinding('/tmp/local-project', env), null)
  assert.equal(workspaceBinding(undefined, env), null)
})

test('a subdirectory of the placeholder still routes to the remote workspace', () => {
  const local = mapRemoteToLocal('host1', '/srv/app', env)!
  const child = path.join(local, 'src')
  const route = routeByCwd(child, env)
  assert.equal(route.kind, 'remote')
  if (route.kind !== 'remote') return
  assert.equal(route.remoteCwd, '/srv/app/src')
  assert.equal(route.placeholderCwd, child)
})

test('model-facing paths stay on the placeholder the session cwd uses', () => {
  const local = mapRemoteToLocal('host1', '/srv/app', env)!
  const route = routeByCwd(local, env)
  assert.equal(route.kind, 'remote')
  if (route.kind !== 'remote') return
  assert.equal(toModelPath('/srv/app/src/main.ts', route, env), path.join(local, 'src', 'main.ts'))
  assert.equal(toModelPath('/srv/app', route, env), local)
})

test('host ids use the credential-key grammar', () => {
  assert.equal(isValidHostId('host1'), true)
  assert.equal(isValidHostId('h0123abcd'), true)
  assert.equal(isValidHostId('Host'), false)
  assert.equal(isValidHostId('host.name'), false)
  assert.equal(mapRemoteToLocal('Host', '/srv/app', env), null)
})

test('a new folder name becomes one child of the listed directory', () => {
  assert.deepEqual(childDirectoryPath('/', 'proj'), { path: '/proj' })
  assert.deepEqual(childDirectoryPath('/home/u', 'proj'), { path: '/home/u/proj' })
  // A trailing slash on the parent must not double the separator.
  assert.deepEqual(childDirectoryPath('/home/u/', 'proj'), { path: '/home/u/proj' })
  // Spaces are part of the name, but a tab-only name is empty after trimming.
  assert.deepEqual(childDirectoryPath('/home/u', '  my dir  '), { path: '/home/u/my dir' })
})

test('a new folder name that would leave the listed directory is refused', () => {
  // A separator would create a tree the picker never listed.
  assert.deepEqual(childDirectoryPath('/home/u', 'a/b'), { error: 'separator' })
  assert.deepEqual(childDirectoryPath('/home/u', '/abs'), { error: 'separator' })
  // Dot segments resolve somewhere the operator is not looking at.
  assert.deepEqual(childDirectoryPath('/home/u', '.'), { error: 'dot' })
  assert.deepEqual(childDirectoryPath('/home/u', '..'), { error: 'dot' })
  assert.deepEqual(childDirectoryPath('/home/u', '   '), { error: 'empty' })
  assert.deepEqual(childDirectoryPath('/home/u', ''), { error: 'empty' })
  // A dot inside a longer name is a normal name.
  assert.deepEqual(childDirectoryPath('/home/u', '.config'), { path: '/home/u/.config' })
  assert.deepEqual(childDirectoryPath('/home/u', 'a..b'), { path: '/home/u/a..b' })
})

test('a remote directory has one spelling, whatever the trailing slashes', () => {
  assert.equal(normalizeRemoteDirectory('/srv/app'), '/srv/app')
  assert.equal(normalizeRemoteDirectory('/srv/app/'), '/srv/app')
  assert.equal(normalizeRemoteDirectory('//srv//app//'), '/srv/app')
  // The filesystem root must not collapse to an empty string.
  assert.equal(normalizeRemoteDirectory('/'), '/')
  assert.equal(normalizeRemoteDirectory('   '), null)
  assert.equal(normalizeRemoteDirectory('srv/app'), null)
})

test('a listing request expands ~ against the login home and defaults to the root', () => {
  // The picker accepts typed paths, and SFTP itself does not expand a tilde.
  assert.equal(listingPath('~', '/home/me'), '/home/me')
  assert.equal(listingPath('~/src', '/home/me'), '/home/me/src')
  assert.equal(listingPath('~/src/', '/home/me'), '/home/me/src')
  // Everything else is passed through for the remote realpath to settle.
  assert.equal(listingPath('/srv/../srv/app', '/home/me'), '/srv/../srv/app')
  // Another account's home is not ours to expand, so it is not rewritten into
  // something under the listed directory either.
  assert.equal(listingPath('~me/src', '/home/me'), '~me/src')
  assert.equal(listingPath('/srv/app', ''), '/srv/app')
  // A request that lost its path still lists something.
  assert.equal(listingPath('   ', '/home/me'), '/')
})

test('a placeholder root spelled through a symlink still routes and binds', () => {
  const box = mkdtempSync(path.join(tmpdir(), 'dsh-route-link-'))
  try {
    const real = path.join(box, 'real')
    mkdirSync(real)
    const link = path.join(box, 'link')
    symlinkSync(real, link)
    // The operator configured the symlink spelling; DSH stores the realpath.
    const linked = { DSH_HOME: box, DSH_SSH_REMOTE_ROOT: link }
    const local = path.join(real, 'host1', Buffer.from('/srv/app').toString('base64url'), 'src')
    const route = routeByCwd(local, linked)
    assert.equal(route.kind, 'remote')
    if (route.kind !== 'remote') return
    assert.equal(route.hostId, 'host1')
    assert.equal(route.remoteCwd, '/srv/app/src')
    assert.deepEqual(workspaceBinding(local, linked), { hostId: 'host1', remotePath: '/srv/app' })
    assert.equal(routeByCwd(path.join(box, 'elsewhere'), linked).kind, 'local')
  } finally {
    rmSync(box, { recursive: true, force: true })
  }
})
