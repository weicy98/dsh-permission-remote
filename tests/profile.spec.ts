import assert from 'node:assert/strict'
import test from 'node:test'
import { atomicWriteScript, bwrapFileProfileArgs, bwrapProbeArgv, bwrapProfileArgs, fileWriteAllowed, seatbeltBashCommand, seatbeltProbeArgv } from '../src/profile.ts'

test('read-only bwrap profile matches the official argv', () => {
  assert.deepEqual(bwrapProfileArgs('read-only', '/srv/app'), [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent',
  ])
  assert.deepEqual(bwrapProbeArgv(), [
    'bwrap',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent',
    '--',
    'true',
  ])
})

test('workspace-write adds a private /tmp and binds the remote workspace', () => {
  const args = bwrapProfileArgs('workspace-write', '/srv/app')
  assert.ok(args)
  assert.deepEqual(args!.slice(-5), ['--tmpfs', '/tmp', '--bind', '/srv/app', '/srv/app'])
  assert.equal(bwrapProfileArgs('danger-full-access', '/srv/app'), null)
})

test('seatbelt probe runs true under the read-only profile', () => {
  const argv = seatbeltProbeArgv()
  assert.equal(argv[0], 'sandbox-exec')
  assert.equal(argv.at(-1), 'true')
  assert.match(argv[2] ?? '', /deny file-write\*/)
})

test('file writes use the remote temp roots, not the harness host temp', () => {
  const roots = { workspaceRoot: '/srv/app', tmp: '/private/tmp', userTmp: '/var/folders/ab/T' }
  assert.equal(fileWriteAllowed('read-only', '/srv/app/a', roots), false)
  assert.equal(fileWriteAllowed('workspace-write', '/srv/app/a', roots), true)
  assert.equal(fileWriteAllowed('workspace-write', '/private/tmp/x', roots), true)
  assert.equal(fileWriteAllowed('workspace-write', '/var/folders/ab/T/x', roots), true)
  assert.equal(fileWriteAllowed('workspace-write', '/etc/passwd', roots), false)
  assert.equal(fileWriteAllowed('danger-full-access', '/etc/passwd', roots), true)
})

test('file writes bind the real temp directories and skip the private tmpfs', () => {
  const args = bwrapFileProfileArgs('workspace-write', {
    workspaceRoot: '/tmp/proj',
    tmp: '/tmp',
    userTmp: '/var/tmp',
  })
  assert.ok(args)
  assert.equal(args!.includes('--tmpfs'), false)
  assert.ok(args!.indexOf('/tmp') < args!.lastIndexOf('/tmp/proj'))
  assert.equal(args!.filter(arg => arg === '/var/tmp').length, 2)
})

test('a missing temp root is not a bwrap bind source', () => {
  const roots = { workspaceRoot: '/srv/app', tmp: '', userTmp: '' }
  const args = bwrapFileProfileArgs('workspace-write', roots)
  assert.ok(args)
  assert.equal(args!.includes(''), false)
  assert.equal(args!.filter(arg => arg === '/srv/app').length, 2)
  assert.equal(args!.includes('--tmpfs'), false)
  assert.equal(fileWriteAllowed('workspace-write', '/srv/app/a', roots), true)
  assert.equal(fileWriteAllowed('workspace-write', '/tmp/x', roots), false)
})

test('seatbelt bash enters the workdir before sandbox-exec', () => {
  const line = seatbeltBashCommand('workspace-write', ['/srv/app', '/private/tmp'], '/srv/app/src', 'pwd')
  assert.match(line, /^cd '\/srv\/app\/src' && 'sandbox-exec' /)
  assert.match(line, /'bash' '-c' 'pwd'/)
  assert.match(line, /subpath "\/srv\/app"/)
})

test('a confined write replaces the target by rename, and does not truncate it first', () => {
  const script = atomicWriteScript('/srv/app', '/srv/app/.dsh-tmp', '/srv/app/file')
  assert.match(script, /if test -d '\/srv\/app\/file'/)
  assert.match(script, /cat > '\/srv\/app\/\.dsh-tmp' && mv -f '\/srv\/app\/\.dsh-tmp' '\/srv\/app\/file'/)
  assert.doesNotMatch(script, /cat > '\/srv\/app\/file'/)
  assert.doesNotMatch(script, /chmod/)
})

test('a replacement can restore the previous permission bits', () => {
  const script = atomicWriteScript('/srv/app', '/srv/app/.dsh-tmp', '/srv/app/file', 0o100600)
  assert.match(script, /chmod 600 '\/srv\/app\/file'/)
})
