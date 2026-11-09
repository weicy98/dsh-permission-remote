import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertSandboxProfilesLoad,
  extractFunction,
  extractProfileRegion,
  loadSandboxProfiles,
  probeInstalledSandboxProfiles,
  probeSandboxProfileSources,
} from '../src/profile-contract.ts'
import { locateDshRoot } from '../src/upstream-worker.ts'

const REQUIRE = process.env.DSH_REQUIRE_OFFICIAL_TOOLS === '1'

const MINIMAL_LOCAL = `
//#region lib/types/profiles.js
function bwrapProfileArgs(policy) {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--die-with-parent"];
  if (policy.mode === "workspace-write") {
    args.push("--tmpfs", "/tmp");
    for (const root of workspaceWritableRoots(policy)) args.push("--bind", root, root);
  }
  return args;
}
function sbplString(path) {
  return '"' + path.replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\\\"') + '"';
}
function seatbeltProfileArgs(policy) {
  const forms = ["(version 1)", "(allow default)", "(deny file-write*)"];
  forms.push("(allow file-write* (literal " + sbplString("/dev/null") + "))");
  const roots = writableRoots(policy);
  if (roots.length > 0) forms.push("(allow file-write* " + roots.map((root) => "(subpath " + sbplString(root) + ")").join(" ") + ")");
  return ["-p", forms.join(" ")];
}
//#endregion
`

const MINIMAL_SANDBOX = `
function workspaceWritableRoots(policy) {
  if (policy.mode !== "workspace-write") return [];
  return [...new Set([canonicalPath(policy.workspaceRoot), ...(policy.additionalWritableRoots ?? []).map(additionalRoot)])];
}
function writableRoots(policy) {
  if (policy.mode !== "workspace-write") return [];
  return [...new Set([...workspaceWritableRoots(policy), canonicalPath("/tmp"), canonicalPath(tmpdir())])];
}
`

function installedOrSkip(): string | false {
  const probe = probeInstalledSandboxProfiles()
  if (probe.failures.length === 0) return false
  const missing = probe.failures.every(failure => failure.startsWith('sandbox profile package could not be read'))
  if (missing && !REQUIRE) return probe.failures.join('; ')
  return false
}

test('sbplString that emits four backslashes per one is rejected', () => {
  const source = MINIMAL_LOCAL.replace(
    /function sbplString\(path\) \{[\s\S]*?\n\}/u,
    String.raw`function sbplString(path) {
  return '"' + path.replaceAll("\\", "\\\\".repeat(2)).replaceAll('"', '\\"') + '"';
}`,
  )
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.equal(probe.failures.length, 1)
  assert.match(probe.failures[0] ?? '', /^sandbox profile argv does not match the accepted contract: seatbelt workspace-write returned /u)
})

test('a minimal official-shaped bundle passes the shape probe', () => {
  const probe = probeSandboxProfileSources(MINIMAL_LOCAL, MINIMAL_SANDBOX)
  assert.deepEqual(probe.failures, [])
  assert.match(probe.profileSha256, /^[0-9a-f]{64}$/u)
})

test('a missing profile region is its own failure', () => {
  const probe = probeSandboxProfileSources('no profile region', MINIMAL_SANDBOX)
  assert.deepEqual(probe.failures, ['sandbox profile region markers changed'])
})

test('dropping the private tmpfs flag fails the bwrap probe', () => {
  const source = MINIMAL_LOCAL.replace('args.push("--tmpfs", "/tmp");', 'args.push("--bind", "/tmp", "/tmp");')
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.ok(probe.failures.includes('bwrap workspace-write no longer mounts a private /tmp'))
})

test('binding writableRoots from bwrap fails the workspace-root probe', () => {
  const source = MINIMAL_LOCAL.replace('workspaceWritableRoots(policy)', 'writableRoots(policy)')
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.ok(probe.failures.includes('bwrap workspace binds no longer come from workspaceWritableRoots'))
})

test('a seatbelt profile that stops asking writableRoots fails closed', () => {
  const source = MINIMAL_LOCAL.replace('const roots = writableRoots(policy);', 'const roots = [];')
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.deepEqual(probe.failures, ['seatbelt grants no longer come from writableRoots'])
})

test('writableRoots without the host temp directories fails closed', () => {
  const source = MINIMAL_SANDBOX.replace('canonicalPath("/tmp"), canonicalPath(tmpdir())', 'canonicalPath("/var/empty")')
  const probe = probeSandboxProfileSources(MINIMAL_LOCAL, source)
  assert.deepEqual(probe.failures, ['writableRoots no longer adds the host temp directories on top of the workspace'])
})

test('a missing bwrap constructor is its own failure', () => {
  const source = MINIMAL_LOCAL.replace('function bwrapProfileArgs', 'function renamedBwrapProfileArgs')
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.deepEqual(probe.failures, ['bwrapProfileArgs function not found'])
})

test('dropping a base flag fails the bwrap probe', () => {
  const source = MINIMAL_LOCAL.replace('"--dev", "/dev", ', '')
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.deepEqual(probe.failures, ['bwrap base flags changed'])
})

test('a changed seatbelt version fails the skeleton probe', () => {
  const source = MINIMAL_LOCAL.replace('"(version 1)"', '"(version 2)"')
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.deepEqual(probe.failures, ['seatbelt profile skeleton changed'])
})

test('workspaceWritableRoots that skips canonicalPath fails closed', () => {
  const source = MINIMAL_SANDBOX.replace('canonicalPath(policy.workspaceRoot)', 'policy.workspaceRoot')
  const probe = probeSandboxProfileSources(MINIMAL_LOCAL, source)
  assert.deepEqual(probe.failures, ['workspaceWritableRoots no longer means the workspace plus explicit extra directories'])
})

test('a comment that still names the temp calls does not preserve writableRoots', () => {
  const source = MINIMAL_SANDBOX
    .replace(
      'function writableRoots(policy) {',
      `function writableRoots(policy) {
  /* canonicalPath("/tmp") canonicalPath(tmpdir()) workspaceWritableRoots(policy) */`,
    )
    .replace(
      'return [...new Set([...workspaceWritableRoots(policy), canonicalPath("/tmp"), canonicalPath(tmpdir())])];',
      'return [...workspaceWritableRoots(policy)];',
    )
  const probe = probeSandboxProfileSources(MINIMAL_LOCAL, source)
  assert.equal(probe.failures.length, 1)
  assert.match(probe.failures[0] ?? '', /^sandbox root helpers did not return the accepted directories: writableRoots workspace-write returned /u)
  assert.doesNotMatch(probe.failures[0] ?? '', /canon:\/tmp/u)
})

test('a conditional private tmpfs is rejected from the argv it returns', () => {
  const source = MINIMAL_LOCAL.replace(
    'args.push("--tmpfs", "/tmp");',
    'if (policy.privateTmp) args.push("--tmpfs", "/tmp");',
  )
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.equal(probe.failures.length, 1)
  assert.match(probe.failures[0] ?? '', /^sandbox profile argv does not match the accepted contract: bwrap workspace-write returned /u)
  assert.doesNotMatch(probe.failures[0] ?? '', /"--tmpfs"/u)
})

test('a narrowed root bind is rejected from the argv it returns', () => {
  const source = MINIMAL_LOCAL.replace('"--ro-bind", "/", "/"', '"--ro-bind", "/usr", "/usr"')
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.equal(probe.failures.length, 1)
  assert.match(probe.failures[0] ?? '', /bwrap read-only returned \["--ro-bind","\/usr","\/usr"/u)
  assert.match(probe.failures[0] ?? '', /bwrap workspace-write returned /u)
})

test('extra bwrap flags are rejected from the argv they return', () => {
  const source = MINIMAL_LOCAL.replace(
    '"--die-with-parent"',
    '"--die-with-parent", "--clearenv", "--new-session"',
  )
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.equal(probe.failures.length, 1)
  assert.match(probe.failures[0] ?? '', /"--clearenv","--new-session"/u)
  assert.match(probe.failures[0] ?? '', /bwrap read-only returned /u)
  assert.match(probe.failures[0] ?? '', /bwrap workspace-write returned /u)
})

test('a region function that shadows the injected root helper is rejected from its bind target', () => {
  const source = MINIMAL_LOCAL.replace(
    'function bwrapProfileArgs(policy) {',
    `function workspaceWritableRoots(policy) {
  return ["/REGION-SHADOWED-" + policy.workspaceRoot];
}
function bwrapProfileArgs(policy) {`,
  )
  const probe = probeSandboxProfileSources(source, MINIMAL_SANDBOX)
  assert.equal(probe.failures.length, 1)
  assert.match(probe.failures[0] ?? '', /bwrap workspace-write returned /u)
  assert.match(probe.failures[0] ?? '', /\/REGION-SHADOWED-\/srv\/contract-workspace/u)
  assert.doesNotMatch(probe.failures[0] ?? '', /bwrap read-only returned /u)
})

function writeInstall(root: string, local: string, sandbox: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0' }))
  for (const [name, source] of [['dsh-sandbox-local', local], ['dsh-sandbox', sandbox]] as const) {
    const directory = join(root, 'node_modules', '@deepseek-ai', name, 'lib')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, '..', 'package.json'), JSON.stringify({
      name: `@deepseek-ai/${name}`,
      version: '0.0.0',
      main: './lib/index.js',
    }))
    writeFileSync(join(directory, 'index.js'), source)
  }
}

test('the gate calls a constructor that compiles but names an outside binding', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-contract-'))
  const source = MINIMAL_LOCAL.replace('return args;', 'args.push(OUTSIDE_THE_REGION);\n  return args;')
  try {
    writeInstall(root, source, MINIMAL_SANDBOX)
    const env = { ...process.env, DSH_INSTALL_ROOT: root }
    const probe = assertSandboxProfilesLoad(env)
    assert.equal(probe.failures.length, 1)
    assert.match(probe.failures[0] ?? '', /^sandbox profile constructors did not evaluate: OUTSIDE_THE_REGION is not defined/u)
    assert.throws(
      () => loadSandboxProfiles(env),
      /the installed sandbox profile does not match the expected contract: sandbox profile constructors did not evaluate: OUTSIDE_THE_REGION is not defined/u,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an in-place rewrite is read again on the next load', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-contract-'))
  const drifted = MINIMAL_LOCAL.replace(
    '"--die-with-parent"',
    '"--die-with-parent", "--clearenv", "--new-session"',
  )
  try {
    writeInstall(root, MINIMAL_LOCAL, MINIMAL_SANDBOX)
    const env = { ...process.env, DSH_INSTALL_ROOT: root }
    const first = loadSandboxProfiles(env).bwrap({ mode: 'read-only', workspaceRoot: '/srv/app' })
    assert.equal(first.includes('--clearenv'), false)
    writeInstall(root, drifted, MINIMAL_SANDBOX)
    assert.throws(
      () => loadSandboxProfiles(env),
      /sandbox profile argv does not match the accepted contract/u,
    )
    writeInstall(root, MINIMAL_LOCAL, MINIMAL_SANDBOX)
    const restored = loadSandboxProfiles(env).bwrap({ mode: 'read-only', workspaceRoot: '/srv/app' })
    assert.deepEqual(restored, first)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing install is a readable probe failure', () => {
  const probe = probeInstalledSandboxProfiles({ DSH_INSTALL_ROOT: '/definitely/not/a/dsh/root' })
  assert.equal(probe.failures.length, 1)
  assert.match(probe.failures[0] ?? '', /^sandbox profile package could not be read: /u)
})

test('the installed constructors are the bash profile', { skip: installedOrSkip() }, () => {
  const probe = assertSandboxProfilesLoad()
  assert.deepEqual(probe.failures, [])
  assert.match(probe.profileSha256, /^[0-9a-f]{64}$/u)
  const located = probeInstalledSandboxProfiles()
  assert.equal(located.failures.length, 0)
  const root = locateDshRoot(process.env).root
  const local = readFileSync(createRequire(join(root, '__dsh_profile_spec__.js')).resolve(
    '@deepseek-ai/dsh-sandbox-local',
    { paths: [root] },
  ), 'utf8')
  const region = extractProfileRegion(local)
  assert.ok(region)
  const seatbelt = extractFunction(region!, 'seatbeltProfileArgs')
  assert.match(seatbelt ?? '', /writableRoots\(policy\)/u)
  assert.match(seatbelt ?? '', /\}\s*$/u)
  const profiles = loadSandboxProfiles()
  assert.deepEqual(profiles.bwrap({ mode: 'read-only', workspaceRoot: '/srv/app' }), [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--proc', '/proc',
    '--die-with-parent',
  ])
  assert.deepEqual(profiles.bwrap({ mode: 'workspace-write', workspaceRoot: '/srv/app' }).slice(-5), [
    '--tmpfs', '/tmp', '--bind', '/srv/app', '/srv/app',
  ])
  const belt = profiles.seatbelt({
    mode: 'workspace-write',
    workspaceRoot: '/srv/app',
    remoteWritableRoots: ['/srv/app', '/private/tmp'],
  })
  assert.equal(belt[0], '-p')
  assert.match(belt[1] ?? '', /subpath "\/srv\/app"/u)
  assert.match(belt[1] ?? '', /subpath "\/private\/tmp"/u)
  assert.doesNotMatch(belt[1] ?? '', /"\/tmp"/u)
})
