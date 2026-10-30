import assert from 'node:assert/strict'
import test from 'node:test'
import type { HostConfig } from '../src/config.ts'
import type { ApprovalDetail, RunnerStatus, ToolHost } from '../src/execute.ts'
import { forgetOpsHost, renderOpsExec, renderOpsRead, requireOps, resolveOpsHost, runSshExec, runSshRead, runSshWrite } from '../src/ops.ts'
import type { ExecResult, SshPool } from '../src/ssh-pool.ts'

function host(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id: 'prod1',
    name: 'prod',
    host: '10.0.0.1',
    port: 22,
    username: 'ops',
    auth: 'key',
    privateKeyPath: '',
    fingerprint: 'SHA256:trusted',
    opsPolicy: 'ask',
    ...overrides,
  }
}

const status: RunnerStatus = {
  os: 'linux',
  sandbox: { available: true, reason: 'ok' },
  sandboxTool: 'bwrap',
  ripgrep: 'system',
  ripgrepPath: '/usr/bin/rg',
  roots: { workspaceRoot: '/', tmp: '/tmp', userTmp: '/tmp' },
  install: null,
}

function result(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  }
}

interface OpsApi {
  api: ToolHost
  commands: string[]
  reads: string[]
  stats: string[]
  modes: Array<[string | undefined, string | undefined, ApprovalDetail | undefined]>
}

const markedHome = `__DSH_OPS_HOME_BEGIN__\n/home/ops\n__DSH_OPS_HOME_END__\n`

function api(options: {
  mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  exec?: (command: string) => ExecResult
  read?: (path: string) => Buffer
  stat?: (path: string) => { isDirectory: boolean, size: number, mode: number }
} = {}): OpsApi {
  forgetOpsHost('prod1')
  const commands: string[] = []
  const reads: string[] = []
  const stats: string[] = []
  const modes: Array<[string | undefined, string | undefined, ApprovalDetail | undefined]> = []
  const pool = {
    exec: async (_host: HostConfig, _secret: unknown, command: string) => {
      commands.push(command)
      if (command.includes('"$HOME"')) return options.exec?.(command) ?? result({ stdout: markedHome })
      return options.exec?.(command) ?? result()
    },
    sftpRead: async (_host: HostConfig, _secret: unknown, path: string) => {
      reads.push(path)
      if (options.read !== undefined) return options.read(path)
      return Buffer.from('line one\nline two\nline three\n')
    },
    sftpStat: async (_host: HostConfig, _secret: unknown, path: string) => {
      stats.push(path)
      if (options.stat !== undefined) return options.stat(path)
      return { isDirectory: false, size: 24, mode: 0o100644 }
    },
    sftpRealpath: async (_host: HostConfig, _secret: unknown, path: string) => path,
  } as unknown as SshPool
  return {
    api: {
      pool,
      hostOf: id => id === 'prod1' ? host() : undefined,
      secretOf: async () => ({}),
      statusOf: async () => status,
      resolveMode: async (_exec, requested, justification, _tool, _subject, detail) => {
        modes.push([requested, justification, detail])
        if (requested === 'danger-full-access' && justification !== undefined) return 'danger-full-access'
        return options.mode ?? 'read-only'
      },
    },
    commands,
    reads,
    stats,
    modes,
  }
}

test('ops hosts resolve by id, name, and address', () => {
  const hosts = [host(), host({ id: 'dev2', name: 'dev', host: '10.0.0.2' })]
  assert.equal(resolveOpsHost(hosts, 'prod1').id, 'prod1')
  assert.equal(resolveOpsHost(hosts, 'PROD').id, 'prod1')
  assert.equal(resolveOpsHost(hosts, '10.0.0.2').id, 'dev2')
})

test('an ambiguous host name names the candidate ids', () => {
  const hosts = [host(), host({ id: 'prod2', name: 'PROD' })]
  assert.throws(() => resolveOpsHost(hosts, 'prod'), /prod1, prod2/)
})

test('an unknown host asks for ssh_hosts', () => {
  assert.throws(() => resolveOpsHost([host()], 'nope'), /ssh_hosts/)
})

test('an untrusted host names the Settings step instead of a verifier error', async () => {
  const { api: hostApi, commands, reads } = api()
  const untrusted = host({ fingerprint: '' })
  await assert.rejects(() => runSshRead(hostApi, untrusted, { file_path: '/etc/hosts' }), /trust its fingerprint/)
  await assert.rejects(
    () => runSshExec(hostApi, untrusted, { command: 'uptime', sandbox_permissions: 'danger-full-access', justification: 'check load' }, {}),
    /trust its fingerprint/,
  )
  assert.deepEqual(commands, [])
  assert.deepEqual(reads, [])
})

test('a deny host rejects reads too', async () => {
  const { api: hostApi, reads } = api()
  await assert.rejects(() => runSshRead(hostApi, host({ opsPolicy: 'deny' }), { file_path: '/etc/hosts' }), /disabled/)
  assert.deepEqual(reads, [])
})

test('requireOps lets a trust host through without asking for a mode', async () => {
  const { api: hostApi, modes } = api()
  await requireOps(hostApi, host({ opsPolicy: 'trust' }), {}, {}, 'ssh_exec', 'remote command')
  assert.deepEqual(modes, [])
})

test('requireOps denies an ask host outside danger-full-access', async () => {
  const { api: hostApi } = api()
  await assert.rejects(
    () => requireOps(hostApi, host(), {}, {}, 'ssh_exec', 'remote command'),
    /escalation available/,
  )
})

test('requireOps passes the escalation args to the session mode resolver', async () => {
  const { api: hostApi, modes } = api()
  const detail = {
    en: 'command on prod (10.0.0.1): systemctl restart nginx',
    zh: '在 prod (10.0.0.1) 上执行：systemctl restart nginx',
  }
  await requireOps(hostApi, host(), {}, {
    sandbox_permissions: 'danger-full-access',
    justification: 'restart nginx',
  }, 'ssh_exec', 'remote command', detail)
  assert.deepEqual(modes, [['danger-full-access', 'restart nginx', detail]])
})

test('requireOps does not ask the user to approve workspace-write', async () => {
  const { api: hostApi, modes } = api()
  await assert.rejects(
    () => requireOps(hostApi, host(), {}, {
      sandbox_permissions: 'workspace-write',
      justification: 'edit a file',
    }, 'ssh_write', 'remote file write'),
    /sandbox_permissions "danger-full-access"/,
  )
  assert.deepEqual(modes, [[undefined, undefined, undefined]])
})

test('a danger-full-access session keeps a narrower ops request', async () => {
  const { api: hostApi, modes } = api({ mode: 'danger-full-access' })
  await requireOps(hostApi, host(), {}, {
    sandbox_permissions: 'workspace-write',
    justification: 'edit a file',
  }, 'ssh_write', 'remote file write')
  assert.deepEqual(modes, [[undefined, undefined, undefined]])
})

test('a deny host is rejected before the fingerprint prompt', async () => {
  const { api: hostApi, commands, reads } = api()
  const denied = host({ opsPolicy: 'deny', fingerprint: '' })
  await assert.rejects(() => runSshRead(hostApi, denied, { file_path: '/etc/hosts' }), /disabled/)
  await assert.rejects(
    () => runSshExec(hostApi, denied, { command: 'uptime', sandbox_permissions: 'danger-full-access', justification: 'check load' }, {}),
    /disabled/,
  )
  assert.deepEqual(commands, [])
  assert.deepEqual(reads, [])
})

test('ssh_exec runs bash -lc and reports output', async () => {
  const { api: hostApi, commands } = api({
    mode: 'danger-full-access',
    exec: () => result({ stdout: 'active\n' }),
  })
  const value = await runSshExec(hostApi, host(), { command: 'systemctl is-active nginx' }, {})
  assert.equal(commands[0], "'bash' '-lc' 'systemctl is-active nginx'")
  assert.equal(value.exitCode, 0)
  assert.deepEqual(value.stdout, { text: 'active\n', truncated: false })
  assert.equal(value.workdir, null)
})

test('ssh_exec cds into an absolute workdir', async () => {
  const { api: hostApi, commands } = api({ mode: 'danger-full-access' })
  await runSshExec(hostApi, host(), { command: 'ls', workdir: '/var/log' }, {})
  assert.equal(commands[0], "cd '/var/log' && 'bash' '-lc' 'ls'")
})

test('ssh_exec ignores the workspace login environment switch', async () => {
  const { api: hostApi, commands } = api({ mode: 'danger-full-access' })
  await runSshExec(hostApi, host({ loginEnv: true }), { command: 'ls', workdir: '/var/log' }, {})
  assert.equal(commands[0], "cd '/var/log' && 'bash' '-lc' 'ls'")
})

test('ssh_exec rejects a relative workdir before connecting', async () => {
  const { api: hostApi, commands } = api({ mode: 'danger-full-access' })
  await assert.rejects(() => runSshExec(hostApi, host(), { command: 'ls', workdir: 'logs' }, {}), /absolute/)
  assert.deepEqual(commands, [])
})

test('ssh_read expands ~/ against the remote home and pages lines', async () => {
  const { api: hostApi, reads } = api()
  const value = await runSshRead(hostApi, host(), { file_path: '~/app.log', offset: 2, limit: 1 }, {})
  assert.deepEqual(reads, ['/home/ops/app.log'])
  assert.equal(value.totalLines, 4)
  assert.deepEqual(value.lines, [{ number: 2, text: 'line two' }])
})

test('ssh_read ignores login-shell noise around the home markers', async () => {
  const { api: hostApi, reads } = api({
    exec: command => command.includes('"$HOME"')
      ? result({ stdout: `welcome\n${markedHome}bye\n` })
      : result(),
  })
  await runSshRead(hostApi, host(), { file_path: '~/app.log' }, {})
  assert.deepEqual(reads, ['/home/ops/app.log'])
})

test('a home probe that is not an absolute path is not cached', async () => {
  let calls = 0
  const { api: hostApi, reads } = api({
    exec: command => {
      if (!command.includes('"$HOME"')) return result()
      calls += 1
      if (calls === 1) return result({ stdout: 'welcome to /home/ops\n' })
      return result({ stdout: markedHome })
    },
  })
  await assert.rejects(() => runSshRead(hostApi, host(), { file_path: '~/app.log' }, {}), /remote home/)
  await runSshRead(hostApi, host(), { file_path: '~/app.log' }, {})
  assert.equal(calls, 2)
  assert.deepEqual(reads, ['/home/ops/app.log'])
})

test('ssh_read requires an absolute path or ~/', async () => {
  const { api: hostApi } = api()
  await assert.rejects(() => runSshRead(hostApi, host(), { file_path: 'app.log' }, {}), /absolute/)
})

test('a cancelled write never runs the remote command', async () => {
  const controller = new AbortController()
  controller.abort()
  const { api: hostApi, commands } = api({ mode: 'danger-full-access' })
  await assert.rejects(
    () => runSshWrite(hostApi, host(), { file_path: '/etc/app.conf', content: 'next' }, { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  assert.deepEqual(commands, [])
})

test('ssh_write creates a missing file and reports the content', async () => {
  const { api: hostApi, commands } = api({
    mode: 'danger-full-access',
    stat: () => {
      throw new Error('No such file')
    },
    exec: () => result({ code: 0, signal: null }),
  })
  const value = await runSshWrite(hostApi, host(), { file_path: '/etc/app.conf', content: 'next' }, {})
  assert.equal(value.operation, 'create')
  assert.equal(value.before, null)
  assert.equal(value.after, 'next')
  assert.equal(commands.length, 1)
  assert.match(commands[0]!, /cat > '\/etc\/\.dsh-permission-remote-[0-9a-f]+' && mv -f/)
  assert.doesNotMatch(commands[0]!, /chmod/)
})

test('ssh_write reports update when the file already exists', async () => {
  const { api: hostApi, commands } = api({
    mode: 'danger-full-access',
    stat: () => ({ isDirectory: false, size: 24, mode: 0o100600 }),
  })
  const value = await runSshWrite(hostApi, host(), { file_path: '/etc/app.conf', content: 'next' }, {})
  assert.equal(value.operation, 'update')
  assert.equal(value.before, 'line one\nline two\nline three\n')
  assert.equal(value.after, 'next')
  assert.match(commands[0]!, /chmod 600 /)
})

test('ssh_write does not treat an unreadable target as a new file', async () => {
  const { api: hostApi, commands } = api({
    mode: 'danger-full-access',
    stat: () => {
      throw new Error('Permission denied')
    },
  })
  await assert.rejects(
    () => runSshWrite(hostApi, host(), { file_path: '/etc/app.conf', content: 'next' }, {}),
    /Permission denied/,
  )
  assert.deepEqual(commands, [])
})

test('ssh_write rejects a directory before running mv', async () => {
  const { api: hostApi, commands } = api({
    mode: 'danger-full-access',
    stat: () => ({ isDirectory: true, size: 0, mode: 0o040755 }),
  })
  await assert.rejects(
    () => runSshWrite(hostApi, host(), { file_path: '/etc/nginx', content: 'next' }, {}),
    /directory/,
  )
  assert.deepEqual(commands, [])
})

test('ssh_write does not replace a file it could not read', async () => {
  const { api: hostApi, commands } = api({
    mode: 'danger-full-access',
    read: () => {
      throw new Error('file is 2000000 bytes, over the 1048576 byte limit')
    },
  })
  await assert.rejects(
    () => runSshWrite(hostApi, host(), { file_path: '/etc/app.conf', content: 'next' }, {}),
    /over the 1048576 byte limit/,
  )
  assert.deepEqual(commands, [])
})

test('ssh_exec reports truncation and timeouts', async () => {
  const truncated = api({
    mode: 'danger-full-access',
    exec: () => result({ stdout: 'partial', stdoutTruncated: true }),
  })
  const cut = await runSshExec(truncated.api, host(), { command: 'cat big.log' }, {})
  assert.deepEqual(cut.stdout, { text: 'partial\n[output truncated]', truncated: true })

  const timedOut = api({
    mode: 'danger-full-access',
    exec: () => result({ code: null, signal: 'KILL', timedOut: true }),
  })
  const killed = await runSshExec(timedOut.api, host(), { command: 'sleep 999' }, {})
  assert.equal(killed.exitCode, null)
  assert.equal(killed.timedOut, true)
  assert.equal(killed.signal, 'KILL')
})

test('ssh_write needs danger-full-access on an ask host', async () => {
  const { api: hostApi, commands } = api()
  await assert.rejects(
    () => runSshWrite(hostApi, host(), { file_path: '/etc/app.conf', content: 'next' }, {}),
    /sandbox_permissions "danger-full-access"/,
  )
  assert.deepEqual(commands, [])
})

test('rendered exec output names a timeout and separates stderr', () => {
  const text = renderOpsExec({
    host: { name: 'prod', address: '10.0.0.1' },
    timedOut: true,
    exitCode: null,
    stdout: { text: 'partial' },
    stderr: { text: 'killed' },
  })
  assert.match(text, /\[stderr\]\nkilled/)
  assert.match(text, /\[prod: timed out\]/)
})

test('rendered reads say when more lines follow', () => {
  const text = renderOpsRead({
    offset: 1,
    totalLines: 4,
    lines: [{ number: 1, text: 'line one' }],
  })
  assert.match(text, /1\|line one/)
  assert.match(text, /lines 1-1 of 4; more lines follow/)
})
