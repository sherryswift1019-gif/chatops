import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ExecutionContext } from '../../../pipeline/node-types/types.js'

// Mock ssh.ts before importing the executor (which registers on import).
vi.mock('../../../pipeline/ssh.js', () => ({
  sshExec: vi.fn(),
}))

import { sshExec } from '../../../pipeline/ssh.js'
import { getExecutor } from '../../../pipeline/node-types/registry.js'
// Importing the wrapper triggers self-registration once at module load.
import '../../../pipeline/node-types/script.js'

const mockedSshExec = vi.mocked(sshExec)

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    runId: 1,
    pipelineId: 100,
    nodeId: 'n1',
    triggerParams: {},
    vars: {},
    steps: {},
    server: { host: '10.0.0.1', port: 22, username: 'root', password: 'pw' },
    ...overrides,
  }
}

function loadScriptExecutor() {
  const exec = getExecutor('script')
  if (!exec) throw new Error('script executor not registered')
  return exec
}

describe('script node executor (phase 3 standalone)', () => {
  beforeEach(() => { mockedSshExec.mockReset() })

  it('runs SSH against ctx.server and reports success on exit 0', async () => {
    mockedSshExec.mockResolvedValueOnce({ stdout: 'hello\n', stderr: '', code: 0 })
    const executor = loadScriptExecutor()

    const result = await executor.execute(
      { script: 'echo hello' },
      makeCtx(),
    )

    expect(result.status).toBe('success')
    expect(result.output).toEqual({ exitCode: 0, stdout: 'hello\n', stderr: '' })
    expect(mockedSshExec).toHaveBeenCalledWith(
      { host: '10.0.0.1', port: 22, username: 'root', password: 'pw' },
      'echo hello',
    )
  })

  it('returns failed when exit code != 0 with error summary', async () => {
    mockedSshExec.mockResolvedValueOnce({ stdout: '', stderr: 'oops', code: 2 })
    const executor = loadScriptExecutor()

    const result = await executor.execute({ script: 'false' }, makeCtx())

    expect(result.status).toBe('failed')
    const out = result.output as Record<string, unknown>
    expect(out.exitCode).toBe(2)
    expect(out.stderr).toBe('oops')
    expect(result.error).toMatch(/exit code 2 on 10.0.0.1/)
  })

  it('resolves {{vars.x}} and {{server.host}} templates before exec', async () => {
    mockedSshExec.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
    const executor = loadScriptExecutor()

    await executor.execute(
      { script: 'deploy {{vars.tag}} to {{server.host}}' },
      makeCtx({ vars: { tag: 'v1.2.3' } }),
    )

    expect(mockedSshExec).toHaveBeenCalledWith(
      expect.any(Object),
      'deploy v1.2.3 to 10.0.0.1',
    )
  })

  it('returns failed when ctx.server missing', async () => {
    const executor = loadScriptExecutor()
    const result = await executor.execute({ script: 'echo' }, makeCtx({ server: undefined }))
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/ctx\.server/)
    expect(mockedSshExec).not.toHaveBeenCalled()
  })

  it('returns failed when password missing', async () => {
    const executor = loadScriptExecutor()
    const result = await executor.execute(
      { script: 'echo' },
      makeCtx({ server: { host: 'h', port: 22, username: 'u' } }),
    )
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/password/)
    expect(mockedSshExec).not.toHaveBeenCalled()
  })

  it('returns success skipped marker when script blank', async () => {
    const executor = loadScriptExecutor()
    const result = await executor.execute({ script: '   ' }, makeCtx())
    expect(result.status).toBe('success')
    const out = result.output as Record<string, unknown>
    expect(out.skipped).toBe('no script')
    expect(mockedSshExec).not.toHaveBeenCalled()
  })

  it('catches sshExec throw and reports failed', async () => {
    mockedSshExec.mockRejectedValueOnce(new Error('connection refused'))
    const executor = loadScriptExecutor()

    const result = await executor.execute({ script: 'echo' }, makeCtx())
    expect(result.status).toBe('failed')
    expect(result.error).toBe('connection refused')
    const out = result.output as Record<string, unknown>
    expect(out.exitCode).toBe(-1)
  })
})
