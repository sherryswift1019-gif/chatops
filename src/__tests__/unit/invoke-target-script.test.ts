import { describe, it, expect, vi, beforeEach } from 'vitest'
import { type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

import { spawn } from 'child_process'
import { getExecutor, __resetRegistryForTesting } from '../../pipeline/node-types/registry.js'

import '../../pipeline/node-types/invoke-target-script.js'

function makeSpawnMock(stdout: string, exitCode: number) {
  const proc = new EventEmitter() as unknown as ChildProcess
  const stdoutEmitter = new EventEmitter()
  const stderrEmitter = new EventEmitter()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(proc as any).stdout = stdoutEmitter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(proc as any).stderr = stderrEmitter
  vi.mocked(spawn).mockReturnValueOnce(proc as unknown as ChildProcess)
  setImmediate(() => {
    stdoutEmitter.emit('data', Buffer.from(stdout))
    proc.emit('close', exitCode)
  })
  return proc
}

const baseCtx = { runId: 1, pipelineId: 1, nodeId: 'test', triggerParams: {}, vars: {}, steps: {} }

describe('invoke_target_script node', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('exit 0 + valid JSON last line → success', async () => {
    makeSpawnMock('some output\n{"artifact":"chatops:v1","kind":"docker-image"}', 0)
    const executor = getExecutor('invoke_target_script')!
    const result = await executor.execute({ scriptPath: '/app/build.sh', args: [] }, baseCtx)
    expect(result.status).toBe('success')
    expect(result.output.parsed).toEqual({ artifact: 'chatops:v1', kind: 'docker-image' })
    expect(result.output.exitCode).toBe(0)
  })

  it('exit 1 → failed', async () => {
    makeSpawnMock('error occurred\n', 1)
    const executor = getExecutor('invoke_target_script')!
    const result = await executor.execute({ scriptPath: '/app/deploy.sh', args: ['provision'] }, baseCtx)
    expect(result.status).toBe('failed')
    expect(result.output.exitCode).toBe(1)
  })

  it('exit 0 but no JSON last line → success with parsed=null', async () => {
    makeSpawnMock('just text output\n', 0)
    const executor = getExecutor('invoke_target_script')!
    const result = await executor.execute({ scriptPath: '/app/test.sh', args: ['--discover'] }, baseCtx)
    expect(result.status).toBe('success')
    expect(result.output.parsed).toBeNull()
  })

  it('missing scriptPath → failed', async () => {
    const executor = getExecutor('invoke_target_script')!
    const result = await executor.execute({ args: [] }, baseCtx)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('scriptPath')
  })

  it('passes env vars to spawn', async () => {
    makeSpawnMock('{"ok":true}', 0)
    const executor = getExecutor('invoke_target_script')!
    await executor.execute(
      { scriptPath: '/app/deploy.sh', args: ['provision'], env: { DATABASE_URL: 'postgres://sandbox/db' } },
      baseCtx,
    )
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      '/app/deploy.sh',
      ['provision'],
      expect.objectContaining({ env: expect.objectContaining({ DATABASE_URL: 'postgres://sandbox/db' }) }),
    )
  })
})
