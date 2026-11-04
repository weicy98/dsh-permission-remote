import assert from 'node:assert/strict'
import test from 'node:test'
import { Core, installRemoteApprovalDetail } from '../src/index.ts'
import { mapRemoteToLocal } from '../src/router.ts'

test('approval detail cache keeps the current cwd and file_path', () => {
  const core = new Core({} as never, {} as never, undefined as never)
  core.rememberSessionEvent('session-1', { type: 'working-directory/change', data: { cwd: '/srv/app/src' } })
  core.rememberSessionEvent('session-1', { type: 'tool/call', data: { callId: 'call-1', name: 'write', arguments: '{"file_path":"../a.ts"}' } })
  assert.deepEqual(core.toolCallDetail('session-1', 'call-1'), { filePath: '../a.ts', cwd: '/srv/app/src' })
  core.forgetSession('session-1')
  assert.equal(core.toolCallDetail('session-1', 'call-1'), undefined)
})

test('the approval waterfall decorates remote write/edit once and leaves other approvals alone', async () => {
  let listener: ((request: Record<string, unknown>, next: () => Promise<unknown>) => Promise<unknown>) | undefined
  const agentCtx = {
    on(event: string, fn: typeof listener) {
      if (event === 'approval/request') listener = fn
      return () => undefined
    },
  }
  const remoteCwd = mapRemoteToLocal('host1', '/srv/app')!
  const core = {
    toolCallDetail: (sessionId: string | undefined, callId: string | undefined) =>
      sessionId === 'session-1' && callId === 'call-1' ? { filePath: 'src/a.ts', cwd: remoteCwd } : undefined,
    requireHost: () => ({ id: 'host1', host: 'build.example', name: 'Build' }),
  }
  installRemoteApprovalDetail(agentCtx as never, core as never)
  assert.ok(listener)

  let nextCalls = 0
  const request: Record<string, any> = {
    agent: { session: { id: 'session-1', header: { cwd: remoteCwd } } },
    toolName: 'write',
    callId: 'call-1',
    reason: 'write file',
    displayReason: { en: 'write file', zh: '写文件' },
  }
  assert.equal(await listener!(request, async () => { nextCalls += 1; return 'approved' }), 'approved')
  assert.equal(nextCalls, 1)
  assert.equal(request.displayReason.en, 'SSH Build: write /srv/app/src/a.ts — write file')
  assert.equal(request.displayReason.zh, 'SSH Build：write /srv/app/src/a.ts — 写文件')

  const localRequest: Record<string, any> = {
    agent: { session: { id: 'session-2', header: { cwd: '/tmp/local' } } },
    toolName: 'bash',
    displayReason: { en: 'run command' },
  }
  await listener!(localRequest, async () => { nextCalls += 1; return 'local' })
  assert.equal(nextCalls, 2)
  assert.deepEqual(localRequest.displayReason, { en: 'run command' })
})
