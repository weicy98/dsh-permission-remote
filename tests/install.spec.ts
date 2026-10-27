import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import test from 'node:test'
import { distroInstallFor, parseOsRelease } from '../src/install-commands.ts'
import { hostFactsCommand, parseHostFacts, probeOutcome, remoteArchOf, remoteOsOf, ripgrepPackage } from '../src/probe.ts'

test('os-release selects a fixed sudo -n command', () => {
  const ubuntu = distroInstallFor(parseOsRelease('ID=ubuntu\nID_LIKE=debian\n'))
  assert.equal(ubuntu?.auto, 'sudo -n apt-get update && sudo -n apt-get install -y bubblewrap')
  assert.equal(ubuntu?.manual, 'sudo apt-get update && sudo apt-get install -y bubblewrap')
  const fedora = distroInstallFor(parseOsRelease('ID="fedora"\n'))
  assert.match(fedora?.auto ?? '', /^sudo -n dnf /)
  assert.equal(distroInstallFor(parseOsRelease('ID=gentoo\n')), null)
})

test('a present binary is unavailable unless the read-only probe exits 0', () => {
  assert.deepEqual(probeOutcome(0, false), { available: true, reason: 'ok' })
  assert.deepEqual(probeOutcome(1, false), { available: false, reason: 'rejected' })
  assert.deepEqual(probeOutcome(null, true), { available: false, reason: 'timeout' })
  assert.deepEqual(probeOutcome(null, false), { available: false, reason: 'missing' })
  assert.deepEqual(probeOutcome(127, false, 'bwrap: command not found'), { available: false, reason: 'missing' })
})

test('host facts use the canonical temp directory, including macOS /tmp', () => {
  assert.match(hostFactsCommand(), /pwd -P/)
  const facts = parseHostFacts('Darwin\naarch64\n/private/tmp\n/var/folders/ab/T\n/Users/dev\n')
  assert.equal(facts.os, 'darwin')
  assert.equal(facts.arch, 'arm64')
  assert.equal(facts.tmp, '/private/tmp')
  assert.equal(facts.userTmp, '/var/folders/ab/T')
  assert.equal(facts.home, '/Users/dev')
})

test('a blank temp line does not move HOME into userTmp', () => {
  const facts = parseHostFacts('Linux\nx86_64\n/tmp\n\n/home/dev\n')
  assert.equal(facts.tmp, '/tmp')
  assert.equal(facts.userTmp, '/tmp')
  assert.equal(facts.home, '/home/dev')
})

test('a missing TMPDIR still yields five fact lines', () => {
  const stdout = execFileSync('bash', ['-c', hostFactsCommand()], {
    env: { ...process.env, TMPDIR: '/nonexistent-xyz-dsh-probe' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const facts = parseHostFacts(stdout)
  assert.equal(facts.userTmp, facts.tmp)
  assert.notEqual(facts.userTmp, '/nonexistent-xyz-dsh-probe')
  assert.equal(facts.home, process.env.HOME || '/tmp')
})

test('ripgrep package follows the remote uname', () => {
  assert.equal(remoteOsOf('Linux\n'), 'linux')
  assert.equal(remoteArchOf('aarch64'), 'arm64')
  assert.equal(ripgrepPackage('linux', 'arm64'), '@vscode/ripgrep-linux-arm64')
  assert.equal(ripgrepPackage('darwin', 'x64'), '@vscode/ripgrep-darwin-x64')
  assert.equal(ripgrepPackage('other', 'x64'), null)
})
