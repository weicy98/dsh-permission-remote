import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { locateDshRoot } from '../src/upstream-worker.ts'
import { probeTerminalContract, VERIFIED_TERMINAL_DSH_VERSIONS } from '../src/upstream-terminal.ts'

function writeRepo(root: string, files: Record<string, string>): void {
  for (const [relative, body] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
}

test('the installed DSH terminal contract matches this plugin', () => {
  const located = locateDshRoot()
  const probe = probeTerminalContract(located.root, located.version)
  assert.deepEqual(probe.failures, [], probe.failures.join('\n'))
  const spawn = probe.rows.find(([name]) => name === 'terminal.spawn params')
  assert.ok(spawn !== undefined && (spawn[1] === '4' || spawn[1] === '5'), `spawn row: ${JSON.stringify(spawn)}`)
  assert.ok((VERIFIED_TERMINAL_DSH_VERSIONS as readonly string[]).includes(located.version))
})

test('a 3-parameter spawn and an unknown DSH version fail the gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-terminal-contract-'))
  try {
    writeRepo(root, {
      'node_modules/@deepseek-ai/dsh-api-terminal-controller/lib/index.js': [
        'async spawn(agent, owner) { return 1; }',
        'async create(agent, request, signal) { return 1; }',
        '  shells(agent, signal) { return []; }',
      ].join('\n'),
      'node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js': 'const env = { DSH_SESSION_ID: spec.owner.id };',
      'node_modules/@deepseek-ai/dsh-subprocess/lib/index.js': 'function spawnTerminal() {}',
    })
    const probe = probeTerminalContract(root, '0.2.2-rc.99')
    assert.ok(probe.failures.some(message => /spawn has 2 parameters/.test(message)), probe.failures.join('\n'))
    assert.ok(probe.failures.some(message => /not in the verified terminal contract list/.test(message)), probe.failures.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
