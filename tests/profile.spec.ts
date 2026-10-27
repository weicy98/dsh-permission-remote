import assert from 'node:assert/strict'
import test from 'node:test'
import { bwrapProbeArgv, bwrapProfileArgs, fileWriteAllowed, seatbeltProbeArgv } from '../src/profile.ts'

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
