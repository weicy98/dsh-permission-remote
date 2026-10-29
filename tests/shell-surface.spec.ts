import assert from 'node:assert/strict'
import test from 'node:test'
import {
  REMOTE_POSIX_PROMPT,
  WINDOWS_SHELL_DENIED,
  WINDOWS_SHELLS,
  isUnknownRestrictError,
  isWindowsShell,
  remotePosixPrompt,
  sameShellSurface,
  shellSurfacePlan,
  windowsShellGuardReason,
  withoutWindowsShells,
} from '../src/shell-surface.ts'
import type { Route } from '../src/router.ts'

const remote: Route = { kind: 'remote', hostId: 'host1', remoteCwd: '/srv/app', placeholderCwd: '/tmp/placeholder' }
const otherRemote: Route = { kind: 'remote', hostId: 'host2', remoteCwd: '/var/lib', placeholderCwd: '/tmp/other' }

test('a remote route denies the Windows shells and covers tool:pwsh', () => {
  assert.deepEqual(shellSurfacePlan(remote, false), {
    remote: true,
    deny: WINDOWS_SHELLS,
    shadowPwshPrompt: true,
    bashFallback: true,
  })
  assert.equal(shellSurfacePlan(remote, true).bashFallback, false)
  assert.equal(sameShellSurface(shellSurfacePlan(remote, false), shellSurfacePlan(otherRemote, false)), true)
  assert.equal(sameShellSurface(shellSurfacePlan(remote, false), shellSurfacePlan(remote, true)), false)
})

test('a local route registers nothing dynamic', () => {
  const plan = shellSurfacePlan({ kind: 'local' }, false)
  assert.deepEqual(plan, { remote: false, deny: [], shadowPwshPrompt: false, bashFallback: false })
  assert.equal(remotePosixPrompt(false), '')
  assert.equal(windowsShellGuardReason(false), undefined)
})

test('only an unknown-global-tool restrict error is ignored', () => {
  assert.equal(isUnknownRestrictError(new Error('tools.restrict() names unknown global tool "pwsh"; known global tools: bash')), true)
  assert.equal(isUnknownRestrictError(new Error('tools.restrict() names unknown global tools "powershell", "cmd"; known global tools: (none)')), true)
  assert.equal(isUnknownRestrictError(new Error('tools registry is closed')), false)
  assert.equal(isUnknownRestrictError(new Error('permission denied for tools.restrict()')), false)
  assert.equal(isUnknownRestrictError('unknown global tool'), false)
})

test('the schema filter drops Windows shells only while remote', () => {
  const tools = [{ name: 'pwsh' }, { name: 'powershell' }, { name: 'cmd' }, { name: 'bash' }, { name: 'read' }]
  assert.equal(withoutWindowsShells(tools, false), tools)
  assert.deepEqual(withoutWindowsShells(tools, true).map(tool => tool.name), ['bash', 'read'])
  assert.equal(isWindowsShell('pwsh'), true)
  assert.equal(isWindowsShell('bash'), false)
})

test('the remote prompt names POSIX bash and does not repeat the Windows termination sentence', () => {
  const text = remotePosixPrompt(true)
  assert.equal(text, REMOTE_POSIX_PROMPT)
  assert.match(text, /POSIX host/)
  assert.match(text, /placeholder paths/)
  assert.doesNotMatch(text, /On Windows a killed process settles/)
  assert.equal(windowsShellGuardReason(true), WINDOWS_SHELL_DENIED)
  assert.match(WINDOWS_SHELL_DENIED, /Windows machine where DSH is running/)
  assert.match(WINDOWS_SHELL_DENIED, /Use bash/)
})
