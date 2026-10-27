import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { isValidHostId, mapRemoteToLocal, resolveRemotePath, routeByCwd, toModelPath } from '../src/router.ts'

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
