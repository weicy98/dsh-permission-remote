import assert from 'node:assert/strict'
import test from 'node:test'
import { FACT_BEGIN, FACT_END, NODE_LOOKUP_BEGIN, NODE_LOOKUP_END, RG_LOOKUP_BEGIN, RG_LOOKUP_END, hostFactsCommand, nodeProbeCommand, parseHostFacts, parseNodeProbe, systemRipgrepCommand, systemRipgrepPath } from '../src/probe.ts'

function block(lines: readonly string[]): string {
  return [FACT_BEGIN, ...lines, FACT_END].join('\n')
}

test('a login-shell banner before the facts block does not shift the fields', () => {
  const stdout = ['Welcome to Ubuntu 24.04 LTS', block(['Linux', 'x86_64', '/tmp', '/var/tmp', '/home/me']), ''].join('\n')
  const facts = parseHostFacts(stdout)
  assert.equal(facts.os, 'linux')
  assert.equal(facts.arch, 'x64')
  assert.equal(facts.tmp, '/tmp')
  assert.equal(facts.userTmp, '/var/tmp')
  assert.equal(facts.home, '/home/me')
})

test('the facts command brackets its output with markers', () => {
  const command = hostFactsCommand()
  assert.ok(command.includes(FACT_BEGIN))
  assert.ok(command.includes(FACT_END))
  assert.match(command, /pwd -P/)
  assert.equal(command.split('; ').length, 7)
})

test('relative values fall back instead of poisoning the sandbox roots', () => {
  const facts = parseHostFacts(block(['Linux', 'x86_64', 'x86_64', 'relative', 'relative']))
  assert.equal(facts.os, 'linux')
  assert.equal(facts.tmp, '/tmp')
  assert.equal(facts.userTmp, '/tmp')
  assert.equal(facts.home, '')
})

test('an unmarked block keeps the legacy five-line layout', () => {
  const facts = parseHostFacts('Darwin\naarch64\n/private/tmp\n/var/folders/ab/T\n/Users/dev\n')
  assert.equal(facts.os, 'darwin')
  assert.equal(facts.arch, 'arm64')
  assert.equal(facts.tmp, '/private/tmp')
  assert.equal(facts.userTmp, '/var/folders/ab/T')
  assert.equal(facts.home, '/Users/dev')
})

test('a blank user temp line inherits the canonical /tmp', () => {
  const facts = parseHostFacts(block(['Linux', 'x86_64', '/tmp', '', '/home/dev']))
  assert.equal(facts.tmp, '/tmp')
  assert.equal(facts.userTmp, '/tmp')
  assert.equal(facts.home, '/home/dev')
})

test('facts after the begin marker are kept when the end marker is missing', () => {
  const stdout = ['Welcome to Ubuntu 24.04', FACT_BEGIN, 'Linux', 'x86_64', '/tmp', '/var/tmp', '/home/me'].join('\n')
  const facts = parseHostFacts(stdout)
  assert.equal(facts.os, 'linux')
  assert.equal(facts.arch, 'x64')
  assert.equal(facts.tmp, '/tmp')
  assert.equal(facts.userTmp, '/var/tmp')
  assert.equal(facts.home, '/home/me')
})

test('a login banner is not the system ripgrep path', () => {
  const command = systemRipgrepCommand()
  assert.ok(command.includes(RG_LOOKUP_BEGIN))
  assert.ok(command.includes('exit $status'))
  const marked = ['/etc/banner-path', RG_LOOKUP_BEGIN, 'Welcome to Ubuntu', '/usr/bin/rg', RG_LOOKUP_END].join('\n')
  assert.equal(systemRipgrepPath(marked), '/usr/bin/rg')
  assert.equal(systemRipgrepPath([RG_LOOKUP_BEGIN, 'rg is a function', 'rg () ', '{ ', '}', RG_LOOKUP_END].join('\n')), '')
  // A function body can hold an absolute command; that line is not the binary.
  assert.equal(systemRipgrepPath([RG_LOOKUP_BEGIN, 'rg () ', '{ ', '  /usr/local/bin/rg "$@"', '}', RG_LOOKUP_END].join('\n')), '')
  assert.equal(systemRipgrepPath(['Welcome to Ubuntu', '/usr/bin/rg'].join('\n')), '/usr/bin/rg')
})


test('the node probe extracts an absolute path and version across a banner', () => {
  const stdout = ['banner line', NODE_LOOKUP_BEGIN, '/usr/local/bin/node', '22.20.0', NODE_LOOKUP_END, ''].join('\n')
  assert.deepEqual(parseNodeProbe(stdout), { path: '/usr/local/bin/node', version: '22.20.0', major: 22, minor: 20 })
  assert.match(nodeProbeCommand(), /command -v node/)
})

test('the node probe rejects output without an absolute binary', () => {
  const stdout = [NODE_LOOKUP_BEGIN, '22.20.0', NODE_LOOKUP_END].join('\n')
  assert.equal(parseNodeProbe(stdout), null)
})
