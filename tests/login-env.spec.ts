import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LoginEnvCache, LOGIN_ENV_CAPTURE_MS, loginEnvApply, loginEnvCaptureCommand, loginEnvSnapshot, type LoginEnvRead } from '../src/login-env.ts'
import { shJoin } from '../src/shell-quote.ts'

test('the capture reads each startup file once and a command only evals the snapshot', () => {
  const capture = loginEnvCaptureCommand()
  assert.match(capture, /bash --noprofile --norc -ic /)
  assert.match(capture, /\/etc\/profile/)
  assert.match(capture, /\$HOME\/\.bash_profile/)
  assert.match(capture, /\$HOME\/\.bash_login/)
  assert.match(capture, /\$HOME\/\.profile/)
  assert.match(capture, /\/etc\/bash\.bashrc/)
  assert.match(capture, /\$HOME\/\.bashrc/)
  assert.match(capture, /__dsh_hit_rc/)
  assert.match(capture, /unset __dsh_hit_sys __dsh_hit_rc PWD OLDPWD SHLVL _\nexport -p/)
  assert.equal(LOGIN_ENV_CAPTURE_MS, 10_000)

  const command = loginEnvApply('declare -x FROM=1\n', 'printf READY', "/srv/o'brien")
  assert.match(command, /eval /)
  assert.match(command, /cd '\/srv\/o'\\''brien'/)
  assert.match(command, /printf READY$/)
  assert.doesNotMatch(command, /bashrc|bash_profile|bash -ic|--noprofile/)
})

test('a timed out, truncated, or noisy capture is dropped', () => {
  const good = 'declare -x FROM=1\n'
  assert.equal(loginEnvSnapshot({ stdout: good, timedOut: false, stdoutTruncated: false }), good)
  assert.equal(loginEnvSnapshot({ stdout: good, timedOut: true, stdoutTruncated: false }), '')
  assert.equal(loginEnvSnapshot({ stdout: good, timedOut: false, stdoutTruncated: true }), '')
  assert.equal(loginEnvSnapshot({ stdout: 'Welcome\ndeclare -x FROM=1\n', timedOut: false, stdoutTruncated: false }), '')
  assert.equal(loginEnvSnapshot({ stdout: '\n', timedOut: false, stdoutTruncated: false }), '')
})

test('session state is removed and a quoted value that looks like it is kept', () => {
  const raw = [
    'declare -x FROM=kept',
    'declare -x CDPATH="/tmp/cdtest"',
    'declare -x MULTI="line1',
    'declare -x SHLVL=\\"7\\"',
    'line2"',
    'declare -x PWD="/home/weichongyong/codespace/dsh-permission-ssh"',
    'declare -x SHLVL="7"',
    'export OLDPWD="/tmp"',
    'declare -x _="/bin/bash"',
    'declare -x PATH="/usr/bin:/bin"',
    'declare -x MYPWD=stay',
    'declare -x SHLVLX=stay',
  ].join('\n')
  const snap = loginEnvSnapshot({ stdout: raw, timedOut: false, stdoutTruncated: false })
  assert.match(snap, /declare -x FROM=kept/)
  assert.match(snap, /declare -x CDPATH="\/tmp\/cdtest"/)
  assert.match(snap, /declare -x MULTI="line1\ndeclare -x SHLVL=\\"7\\"\nline2"/)
  assert.match(snap, /declare -x PATH="\/usr\/bin:\/bin"/)
  assert.match(snap, /declare -x MYPWD=stay/)
  assert.match(snap, /declare -x SHLVLX=stay/)
  assert.equal(snap.includes('declare -x PWD='), false)
  assert.equal(snap.includes('declare -x SHLVL="7"'), false)
  assert.equal(snap.includes('export OLDPWD='), false)
  assert.equal(snap.includes('declare -x _='), false)
  assert.equal(loginEnvSnapshot({
    stdout: 'declare -x PWD="/tmp"\ndeclare -x SHLVL="2"\n',
    timedOut: false,
    stdoutTruncated: false,
  }), '')
})

test('one host keeps one capture, including a failed one, until it is forgotten', async () => {
  let reads = 0
  const cache = new LoginEnvCache(async (): Promise<LoginEnvRead> => {
    reads += 1
    return { stdout: 'declare -x FROM=1\n', timedOut: false, stdoutTruncated: false }
  })
  const first = cache.get('h1')
  const second = cache.get('h1')
  assert.equal(await first, 'declare -x FROM=1\n')
  assert.equal(await second, 'declare -x FROM=1\n')
  assert.equal(await cache.get('h1'), 'declare -x FROM=1\n')
  assert.equal(reads, 1)

  cache.forget('h1')
  assert.equal(await cache.get('h1'), 'declare -x FROM=1\n')
  assert.equal(reads, 2)

  const stalled = new LoginEnvCache(async () => ({ stdout: 'declare -x FROM=1\n', timedOut: true, stdoutTruncated: false }))
  assert.equal(await stalled.get('h1'), '')
  assert.equal(await stalled.get('h1'), '')

  let attempts = 0
  const flaky = new LoginEnvCache(async () => {
    attempts += 1
    if (attempts === 1) throw new Error('connection dropped')
    return { stdout: 'declare -x FROM=1\n', timedOut: false, stdoutTruncated: false }
  })
  await assert.rejects(() => flaky.get('h1'), /connection dropped/)
  assert.equal(await flaky.get('h1'), 'declare -x FROM=1\n')
  assert.equal(attempts, 2)
})

function runShell(shell: string, script: string, home: string): Promise<{ code: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', script], {
      env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

async function shellHome(profile: string, bashrc: string): Promise<{ home: string, work: string, cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-login-env-'))
  const home = join(root, 'home')
  const work = join(root, "o'brien")
  await mkdir(home)
  await mkdir(work)
  await writeFile(join(home, '.profile'), profile)
  await writeFile(join(home, '.bashrc'), bashrc)
  return { home, work, cleanup: () => rm(root, { recursive: true, force: true }) }
}

const BASHRC = [
  'case $- in',
  '  *i*) ;;',
  '  *) return ;;',
  'esac',
  'echo BANNER_BASHRC',
  'BASHRC_COUNT=$(( ${BASHRC_COUNT:-0} + 1 ))',
  'export BASHRC_COUNT',
  'export PATH="/B:${PATH}"',
  'export FROM_Q="o\'brien"',
  '',
].join('\n')

test('a profile that sources bashrc does not run it again', async () => {
  const { home, work, cleanup } = await shellHome([
    'echo BANNER_PROFILE',
    '. "$HOME/.bashrc"',
    'export FROM_PROFILE=profile',
    'cd /tmp',
    '',
  ].join('\n'), BASHRC)
  try {
    const captured = await runShell('bash', loginEnvCaptureCommand(), home)
    assert.equal(captured.code, 0)
    assert.equal(captured.stderr, '')
    assert.equal(captured.stdout.includes('BANNER'), false)
    assert.match(captured.stdout, /^declare /)
    const snap = loginEnvSnapshot({ stdout: captured.stdout, timedOut: false, stdoutTruncated: false })
    assert.equal(snap.includes('declare -x PWD='), false)
    assert.equal(snap.includes('declare -x OLDPWD='), false)
    assert.equal(snap.includes('declare -x SHLVL='), false)
    assert.equal(snap.includes('declare -x _='), false)

    const body = loginEnvApply(snap, 'printf \'%s\\n\' "$BASHRC_COUNT" "$FROM_PROFILE" "$FROM_Q" "$PWD" "$SHLVL" "$PATH"', work)
    const outer = `cd ${shJoin([work])} && ${shJoin(['bash', '-c', body])}`
    for (const shell of ['bash', 'zsh']) {
      const printed = await runShell(shell, outer, home)
      assert.equal(printed.stderr, '', shell)
      assert.equal(printed.code, 0, shell)
      const [count, profile, quote, pwd, shlvl, path] = printed.stdout.split('\n')
      const natural = await runShell(shell, `cd ${shJoin([work])} && ${shJoin(['bash', '-c', 'printf %s "$SHLVL"'])}`, home)
      assert.equal(count, '1', shell)
      assert.equal(profile, 'profile', shell)
      assert.equal(quote, "o'brien", shell)
      assert.equal(pwd, work, shell)
      assert.equal(shlvl, natural.stdout, shell)
      assert.equal(path?.startsWith('/B:'), true, shell)
      assert.equal(path?.split('/B').length, 2, shell)
      assert.equal(printed.stdout.includes('BANNER'), false)
    }

    const failed = await runShell('bash', loginEnvApply(captured.stdout, 'exit 9', work), home)
    assert.equal(failed.code, 9)
    assert.equal(failed.stdout, '')
    assert.equal(failed.stderr, '')
  } finally {
    await cleanup()
  }
})

test('a poisoned SHLVL in the capture is not what the command shell sees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-login-env-'))
  const work = join(root, "o'brien")
  await mkdir(work)
  try {
    const raw = [
      'declare -x FROM=kept',
      'declare -x PWD="/home/weichongyong/codespace/dsh-permission-ssh"',
      'declare -x SHLVL="7"',
      'declare -x PATH="/usr/bin:/bin"',
    ].join('\n')
    const snap = loginEnvSnapshot({ stdout: raw, timedOut: false, stdoutTruncated: false })
    const body = loginEnvApply(snap, 'printf \'%s\\n\' "$FROM" "$PWD" "$SHLVL"', work)
    const printed = await runShell('bash', body, root)
    const natural = await runShell('bash', 'printf %s "$SHLVL"', root)
    assert.equal(printed.code, 0)
    assert.equal(printed.stderr, '')
    const [from, pwd, shlvl] = printed.stdout.split('\n')
    assert.equal(from, 'kept')
    assert.equal(pwd, work)
    assert.equal(shlvl, natural.stdout)
    assert.notEqual(shlvl, '7')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bashrc still loads when the login file does not source it', async () => {
  const { home, work, cleanup } = await shellHome([
    'echo BANNER_PROFILE',
    'export FROM_PROFILE=profile',
    'cd /tmp',
    '',
  ].join('\n'), BASHRC)
  try {
    const captured = await runShell('bash', loginEnvCaptureCommand(), home)
    const snap = loginEnvSnapshot({ stdout: captured.stdout, timedOut: false, stdoutTruncated: false })
    const printed = await runShell('bash', loginEnvApply(snap, 'printf \'%s\\n\' "$BASHRC_COUNT" "$PWD"', work), home)
    assert.equal(printed.stderr, '')
    assert.equal(printed.stdout, `1\n${work}\n`)
  } finally {
    await cleanup()
  }
})
