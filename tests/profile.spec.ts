import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { probeInstalledSandboxProfiles } from '../src/profile-contract.ts'
import { atomicWriteScript, bwrapFileProfileArgs, bwrapProbeArgv, bwrapProfileArgs, fileWriteAllowed, seatbeltBashCommand, seatbeltProbeArgv } from '../src/profile.ts'

const REQUIRE_PROFILE = process.env.DSH_REQUIRE_OFFICIAL_TOOLS === '1'
const profileProbe = probeInstalledSandboxProfiles()
const profileMissing = profileProbe.failures.length > 0
  && profileProbe.failures.every(failure => failure.startsWith('sandbox profile package could not be read'))
if (profileProbe.failures.length > 0 && (!profileMissing || REQUIRE_PROFILE)) {
  throw new Error(profileProbe.failures.join('; '))
}
const profileSkip: string | false = profileMissing ? profileProbe.failures.join('; ') : false

test('the bwrap probe wraps the official read-only profile', { skip: profileSkip }, () => {
  const readOnly = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent',
  ]
  // Check the wrapper and the profile it delegates to. The literal array is
  // intentionally repeated here: the wrapper is used by execute.ts and
  // remote-world.ts, so a mode mix-up in the wrapper must fail in this file
  // even if profile-contract.spec.ts pins the official constructor.
  assert.deepEqual(bwrapProfileArgs('read-only', '/srv/app'), readOnly)
  assert.deepEqual(bwrapProbeArgv(), ['bwrap', ...readOnly, '--', 'true'])
})

test('workspace-write adds a private /tmp and binds the remote workspace', { skip: profileSkip }, () => {
  const args = bwrapProfileArgs('workspace-write', '/srv/app')
  assert.ok(args)
  assert.deepEqual(args!.slice(-5), ['--tmpfs', '/tmp', '--bind', '/srv/app', '/srv/app'])
  assert.equal(bwrapProfileArgs('danger-full-access', '/srv/app'), null)
})

test('seatbelt probe runs true under the read-only profile', { skip: profileSkip }, () => {
  const argv = seatbeltProbeArgv()
  assert.equal(argv[0], 'sandbox-exec')
  assert.equal(argv.at(-1), 'true')
  assert.match(argv[2] ?? '', /deny file-write\*/)
})

test('read-only seatbelt does not substitute the filesystem root', () => {
  const source = readFileSync(new URL('../src/profile.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export function seatbeltProfileArgs')
  const end = source.indexOf('export function seatbeltProbeArgv')
  assert.notEqual(start, -1)
  assert.ok(end > start)
  assert.doesNotMatch(source.slice(start, end), /\?\?\s*'\/'/u)
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

test('file writes bind the real temp directories and skip the private tmpfs', { skip: profileSkip }, () => {
  const args = bwrapFileProfileArgs('workspace-write', {
    workspaceRoot: '/tmp/proj',
    tmp: '/tmp',
    userTmp: '/var/tmp',
  })
  assert.ok(args)
  assert.equal(args![0], '--ro-bind')
  assert.equal(args!.includes('--tmpfs'), false)
  assert.ok(args!.indexOf('/tmp') < args!.lastIndexOf('/tmp/proj'))
  assert.equal(args!.filter(arg => arg === '/var/tmp').length, 2)
})

test('a missing temp root is not a bwrap bind source', { skip: profileSkip }, () => {
  const roots = { workspaceRoot: '/srv/app', tmp: '', userTmp: '' }
  const args = bwrapFileProfileArgs('workspace-write', roots)
  assert.ok(args)
  assert.equal(args!.includes(''), false)
  assert.equal(args!.filter(arg => arg === '/srv/app').length, 2)
  assert.equal(args!.includes('--tmpfs'), false)
  assert.equal(fileWriteAllowed('workspace-write', '/srv/app/a', roots), true)
  assert.equal(fileWriteAllowed('workspace-write', '/tmp/x', roots), false)
})

test('seatbelt bash enters the workdir before sandbox-exec', { skip: profileSkip }, () => {
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

test('mode 000 is a real mode and is restored instead of falling back to umask', () => {
  const script = atomicWriteScript('/srv/app', '/srv/app/.dsh-tmp', '/srv/app/file', 0o100000)
  assert.match(script, /chmod 0 '\/srv\/app\/file'/)
})

test('an unreported mode leaves the new file on the remote umask', () => {
  const script = atomicWriteScript('/srv/app', '/srv/app/.dsh-tmp', '/srv/app/file', undefined)
  assert.doesNotMatch(script, /chmod/)
})

test('a createIfAbsent write uses an atomic no-clobber rename and reports collisions', () => {
  const script = atomicWriteScript('/srv/app', '/srv/app/.dsh-tmp', '/srv/app/new.txt', undefined, { noClobber: true })
  assert.match(script, /mv -n '\/srv\/app\/\.dsh-tmp' '\/srv\/app\/new\.txt'/)
  assert.match(script, /remote target already exists/)
  assert.match(script, /rm -f '\/srv\/app\/\.dsh-tmp'/)
})
