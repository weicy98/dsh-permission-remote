import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { locateDshRoot } from '../src/upstream-worker.ts'
import { probeTerminalContract, VERIFIED_TERMINAL_DSH_VERSIONS } from '../src/upstream-terminal.ts'

const CONTROLLER = 'node_modules/@deepseek-ai/dsh-api-terminal-controller/lib/index.js'
const BASH = 'node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js'
const ABSTRACT = 'node_modules/@deepseek-ai/dsh-subprocess/lib/index.js'
const LOCAL = 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js'
const TERMINAL_CORE = 'node_modules/@deepseek-ai/dsh-terminal/lib/index.js'

function writeRepo(root: string, files: Record<string, string>): void {
  for (const [relative, body] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
  }
}

/** A minimal but shape-correct terminal install for the requested DSH version. */
function contractFiles(version = '0.2.2-rc.2'): Record<string, string> {
  const rc2 = version !== '0.2.2-rc.1'
  const controller = rc2
    ? [
        'async spawn(agent, owner, id, prepare, signal) {',
        '  const handle = await this.execution(agent).subprocess.spawnTerminal({',
        '    env: { DSH_SESSION_ID: agent.id },',
        '    signal',
        '  });',
        '  return handle;',
        '}',
        'async create(agent, request, signal) { return 1; }',
        '  shells(agent, signal) { return []; }',
        'async openForAgent(agent, request, signal) { return this.allocate(agent, request, signal); }',
        'async allocate(agent, request, signal) { return this.spawn(agent, request, signal); }',
        'async userLaunch(agent, request, signal) { return { env: { DSH_SESSION_ID: agent.id } }; }',
        'async agentLaunch(agent, id, request, signal) { return { env: { DSH_SESSION_ID: agent.id } }; }',
      ]
    : [
        'async spawn(agent, owner, request, signal) {',
        '  const handle = await this.execution(agent).subprocess.spawnTerminal({',
        '    env: { DSH_SESSION_ID: agent.id },',
        '    signal',
        '  });',
        '  return handle;',
        '}',
        'async create(agent, request, signal) { return 1; }',
        '  shells(agent, signal) { return []; }',
      ]
  return {
    [CONTROLLER]: controller.join('\n'),
    [BASH]: 'const env = { DSH_SESSION_ID: spec.owner.id };',
    // The abstract package only ever mentions spawnTerminal in a JSDoc comment.
    // rc.2 also ships the stable subprocess error catalogue here.
    [ABSTRACT]: rc2
      ? [
          'const SUBPROCESS_ERROR_CODES = ["SUBPROCESS_INVALID_ARGV"];',
          'var SubprocessError = class extends HarnessError { constructor(message, code) { super(message, code); this.code = code; } };',
          '* - {@link spawnTerminal} owns terminal allocation, text transport,',
        ].join('\n')
      : '* - {@link spawnTerminal} owns terminal allocation, text transport,',
    [TERMINAL_CORE]: 'var TerminalError = class extends Error { constructor(message, code) { super(message); this.code = code; } };',
    // The real runtime methods live here.
    [LOCAL]: [
      'async terminalEnvironment(signal) { return { platform: "posix" }; }',
      'async spawnTerminal(spec) { return spec; }',
    ].join('\n'),
  }
}

function withRepo(
  files: Record<string, string>,
  check: (probe: ReturnType<typeof probeTerminalContract>) => void,
  version = '0.2.2-rc.2',
): void {
  const root = mkdtempSync(join(tmpdir(), 'dsh-terminal-contract-'))
  try {
    writeRepo(root, files)
    check(probeTerminalContract(root, version))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the installed DSH terminal contract matches this plugin', () => {
  const located = locateDshRoot()
  const probe = probeTerminalContract(located.root, located.version)
  assert.deepEqual(probe.failures, [], probe.failures.join('\n'))
  const spawn = probe.rows.find(([name]) => name === 'terminal.spawn params')
  assert.ok(spawn !== undefined && (spawn[1] === '4' || spawn[1] === '5'), `spawn row: ${JSON.stringify(spawn)}`)
  assert.ok((VERIFIED_TERMINAL_DSH_VERSIONS as readonly string[]).includes(located.version))
  const runtime = probe.rows.find(([name]) => name === 'dsh-subprocess-local spawnTerminal')
  assert.ok(runtime !== undefined && runtime[1] === '1 parameter(s)', `runtime row: ${JSON.stringify(runtime)}`)
  const controllerSession = probe.rows.find(([name]) => name === 'terminal-controller DSH_SESSION_ID')
  assert.deepEqual(controllerSession, ['terminal-controller DSH_SESSION_ID', '2 site(s)'])
})

test('a 3-parameter spawn and an unknown DSH version fail the gate', () => {
  const files = contractFiles('0.2.2-rc.1')
  files[CONTROLLER] = files[CONTROLLER]!.replace('async spawn(agent, owner, request, signal) {', 'async spawn(agent, owner) {')
  const root = mkdtempSync(join(tmpdir(), 'dsh-terminal-contract-'))
  try {
    writeRepo(root, files)
    const probe = probeTerminalContract(root, '0.2.2-rc.99')
    assert.ok(probe.failures.some(message => /spawn has 2 parameters/.test(message)), probe.failures.join('\n'))
    assert.ok(probe.failures.some(message => /not in the verified terminal contract list/.test(message)), probe.failures.join('\n'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the abstract package comment cannot satisfy the gate', () => {
  // Renaming the comment in dsh-subprocess must NOT change the result: the
  // contract is the runtime method in dsh-subprocess-local.
  const files = contractFiles()
  // No JSDoc comment at all; the catalogue and coded class are what matter.
  files[ABSTRACT] = 'const SUBPROCESS_ERROR_CODES = ["X"]; var SubprocessError = class extends Error { constructor(m, c) { super(m); this.code = c; } };'
  withRepo(files, probe => {
    assert.deepEqual(probe.failures, [], probe.failures.join('\n'))
  })

  // Removing the real runtime method while leaving the comment in place must
  // fail. This is the false-green the old `/spawnTerminal/` substring produced.
  const drifted = contractFiles()
  drifted[LOCAL] = 'async spawnTerminalV2(spec) { return spec; }'
  withRepo(drifted, probe => {
    assert.ok(probe.failures.some(message => /dsh-subprocess-local/.test(message)), probe.failures.join('\n'))
    assert.equal(probe.rows.find(([name]) => name === 'dsh-subprocess-local spawnTerminal')?.[1], 'absent')
  })
})

test('a runtime spawnTerminal with a different arity fails the gate', () => {
  const files = contractFiles()
  files[LOCAL] = 'async spawnTerminal(spec, extra) { return spec; }'
  withRepo(files, probe => {
    assert.ok(probe.failures.some(message => /spawnTerminal has 2 parameters/.test(message)), probe.failures.join('\n'))
  })
})

test('the controller DSH_SESSION_ID and spawnTerminal call are both required', () => {
  const noSession = contractFiles()
  noSession[CONTROLLER] = noSession[CONTROLLER]!.replaceAll('DSH_SESSION_ID: agent.id', 'NO_SESSION: agent.id')
  withRepo(noSession, probe => {
    assert.ok(probe.failures.some(message => /DSH_SESSION_ID from agent\.id at/.test(message)), probe.failures.join('\n'))
  })

  const noCall = contractFiles()
  noCall[CONTROLLER] = noCall[CONTROLLER]!.replace('spawnTerminal({', 'openPty({')
  withRepo(noCall, probe => {
    assert.ok(probe.failures.some(message => /no longer calls subprocess\.spawnTerminal/.test(message)), probe.failures.join('\n'))
  })
})

test('the rc.2 terminalEnvironment method is required', () => {
  const files = contractFiles()
  files[LOCAL] = 'async spawnTerminal(spec) { return spec; }'
  withRepo(files, probe => {
    assert.ok(probe.failures.some(message => /terminalEnvironment\(signal\)/.test(message)), probe.failures.join('\n'))
  })
})

test('uncoded terminal and subprocess error classes fail the gate', () => {
  const noTerminalCodes = contractFiles()
  noTerminalCodes[TERMINAL_CORE] = 'var TerminalError = class extends Error {};'
  withRepo(noTerminalCodes, probe => {
    assert.ok(probe.failures.some(message => /TerminalError no longer carries a stable code/.test(message)), probe.failures.join('\n'))
  })

  const noSubprocessCodes = contractFiles()
  noSubprocessCodes[ABSTRACT] = 'const SUBPROCESS_ERROR_CODES = ["X"]; var SubprocessError = class extends Error {};'
  withRepo(noSubprocessCodes, probe => {
    assert.ok(probe.failures.some(message => /SubprocessError no longer carries/.test(message)), probe.failures.join('\n'))
  })
})

test('an rc.1-style install without the SUBPROCESS_* catalogue is still verified', () => {
  const files = contractFiles('0.2.2-rc.1')
  withRepo(files, probe => {
    assert.deepEqual(probe.failures, [], probe.failures.join('\n'))
    assert.equal(probe.rows.find(([name]) => name === 'subprocess error codes')?.[1], 'n/a (rc.1)')
  }, '0.2.2-rc.1')
})

test('a full install missing a companion terminal package fails instead of skipping', () => {
  const noLocal = contractFiles()
  delete noLocal[LOCAL]
  withRepo(noLocal, probe => {
    assert.ok(probe.failures.some(message => /dsh-subprocess-local: not installed/.test(message)), probe.failures.join('\n'))
  })

  const noBash = contractFiles()
  delete noBash[BASH]
  withRepo(noBash, probe => {
    assert.ok(probe.failures.some(message => /dsh-terminal-bash: not installed/.test(message)), probe.failures.join('\n'))
  })
})

test('a slim install without the terminal controller is still skipped', () => {
  withRepo({ 'node_modules/@deepseek-ai/dsh-subprocess/lib/index.js': 'class SubprocessRuntime {}' }, probe => {
    assert.deepEqual(probe.failures, [])
    assert.ok(probe.rows.some(([name, value]) => name === 'terminal contract' && value.includes('skipped')))
  })
})
