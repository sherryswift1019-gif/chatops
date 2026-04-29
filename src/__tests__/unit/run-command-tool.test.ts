import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TaskContext } from '../../agent/tools/types.js'

// Mock child_process.exec used by run-command tool
const execMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ exec: execMock }))
vi.mock('util', () => ({
  promisify: () =>
    (cmd: string, opts: { cwd?: string; timeout?: number }) => execMock(cmd, opts),
}))

import { runCommandTool } from '../../agent/tools/run-command.js'

const baseCtx: TaskContext = {
  taskId: 't1', groupId: 'g1', platform: 'pipeline',
  initiatorId: 'u1', initiatorRole: 'admin',
}

describe('run_command tool', () => {
  beforeEach(() => execMock.mockReset())

  it('without dockerContainerName: runs execAsync(cmd, { cwd })', async () => {
    execMock.mockResolvedValueOnce({ stdout: 'ok', stderr: '' })
    const ctx: TaskContext = { ...baseCtx, cwd: '/tmp/work' }
    const r = await runCommandTool.execute({ command: 'echo hi' }, ctx)
    expect(r.success).toBe(true)
    expect(execMock).toHaveBeenCalledWith('echo hi', expect.objectContaining({ cwd: '/tmp/work' }))
  })

  it('with dockerContainerName: routes to docker exec sh -c "cd <cwd> && <cmd>"', async () => {
    execMock.mockResolvedValueOnce({ stdout: 'inside', stderr: '' })
    const ctx: TaskContext = { ...baseCtx, cwd: '/workspace/proj', dockerContainerName: 'cap-1' }
    const r = await runCommandTool.execute({ command: 'go test ./...' }, ctx)
    expect(r.success).toBe(true)
    const [calledCmd] = execMock.mock.calls[0] as [string, unknown]
    expect(calledCmd).toBe('docker exec cap-1 sh -c "cd /workspace/proj && go test ./..."')
  })

  it('cwd not set: returns failure without spawning', async () => {
    const r = await runCommandTool.execute({ command: 'ls' }, baseCtx)
    expect(r.success).toBe(false)
    expect(r.output).toContain('未设置工作目录')
    expect(execMock).not.toHaveBeenCalled()
  })

  it('exec failure surfaces exit code and stderr', async () => {
    execMock.mockRejectedValueOnce({ code: 2, stdout: 'partial', stderr: 'boom' })
    const ctx: TaskContext = { ...baseCtx, cwd: '/tmp/work' }
    const r = await runCommandTool.execute({ command: 'false' }, ctx)
    expect(r.success).toBe(false)
    expect((r.data as { exitCode: number }).exitCode).toBe(2)
    expect(r.output).toContain('boom')
  })
})
