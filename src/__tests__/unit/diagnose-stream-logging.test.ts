/**
 * 单元测试：diagnose_and_repair handler 流式监听 + 实时 log 落盘 + 即时 finalize
 *
 * 现状：handler 用 porygon.run() 等 LLM 全部跑完才返回，期间用户从 UI 看是
 * "卡 N 分钟突然出结果"。改造：用 porygon.query() 流式迭代，每条 AgentMessage
 * 写一行到 <DATA_DIR>/<runId>/<NN>-capability.log（append + 立即 flush），且
 * 收到 'result' 即 break loop（不再等 maxRetries 用尽）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── hoisted mock refs ────────────────────────────────────────────────────────
const mockQuery = vi.hoisted(() => vi.fn())
const mockAppendFile = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<void>>(async () => {}))
const mockMkdir = vi.hoisted(() => vi.fn<(...args: any[]) => Promise<void>>(async () => {}))

vi.mock('@snack-kit/porygon', () => ({
  createPorygon: vi.fn(() => ({ query: mockQuery, run: vi.fn() })),
}))

vi.mock('../../agent/claude-config.js', () => ({
  buildClaudeEnv: vi.fn(async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'test-token' })),
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    appendFile: mockAppendFile,
    mkdir: mockMkdir,
  }
})

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return {
    ...actual,
    appendFile: mockAppendFile,
    mkdir: mockMkdir,
  }
})

// ─── helpers ──────────────────────────────────────────────────────────────────
type Msg = Record<string, unknown> & { type: string }

function genFromArray(messages: Msg[]) {
  return async function* () {
    for (const m of messages) {
      yield m
    }
  }
}

function makeOpts(taskId: string, params: Record<string, unknown> = {}) {
  return {
    capabilityKey: 'diagnose_and_repair',
    context: {
      taskId,
      groupId: 'pipeline',
      platform: 'pipeline',
      initiatorId: 'pipeline-executor',
      initiatorRole: 'admin',
    },
    extraParams: {
      failedCommand: 'systemctl restart foo',
      stdout: '',
      stderr: 'Unit foo.service not found',
      serverHost: '10.0.0.1',
      maxRetries: 2,
      ...params,
    },
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────
describe('diagnose-repair-handler streaming + log + finalize', () => {
  let handler: (opts: any) => Promise<any>

  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.TEST_DATA_DIR = '/tmp/diagnose-test-data'
    // re-import to ensure registerCapabilityHandler runs against fresh registry
    vi.resetModules()
    // We need the EXPORTED function — but the handler is registered, not exported.
    // Capture it by spying on registerCapabilityHandler.
    const captured: { fn?: any } = {}
    vi.doMock('../../agent/coordinator.js', async () => {
      const actual = await vi.importActual<typeof import('../../agent/coordinator.js')>(
        '../../agent/coordinator.js',
      )
      return {
        ...actual,
        registerCapabilityHandler: (key: string, fn: any) => {
          if (key === 'diagnose_and_repair') captured.fn = fn
          actual.registerCapabilityHandler(key, fn)
        },
      }
    })
    await import('../../agent/repair/diagnose-repair-handler.js')
    handler = captured.fn
    expect(handler).toBeDefined()
  })

  it('writes one log line per non-stream_chunk message and breaks on result', async () => {
    const messages: Msg[] = [
      { type: 'system', timestamp: 1, model: 'sonnet' },
      { type: 'assistant', timestamp: 2, text: '分析中…' },
      { type: 'tool_use', timestamp: 3, toolName: 'run_remote_command', input: { host: '10.0.0.1', command: 'ls' } },
      { type: 'stream_chunk', timestamp: 4, text: '修' }, // should be skipped
      { type: 'assistant', timestamp: 5, text: '修好了' },
      { type: 'result', timestamp: 6, text: '{"success":true,"attempts":1,"summary":"修复完成"}' },
      // After result handler MUST break — this should NEVER be processed.
      { type: 'assistant', timestamp: 7, text: 'NEVER-WRITTEN' },
    ]
    let consumed = 0
    mockQuery.mockImplementation(async function* () {
      for (const m of messages) {
        consumed++
        yield m
      }
    })

    const result = await handler(makeOpts('pipeline-14-stage-4'))

    expect(result.success).toBe(true)
    expect(result.output).toContain('修复完成')

    // Path: TEST_DATA_DIR/14/05-capability.log
    const expectedPath = '/tmp/diagnose-test-data/14/05-capability.log'
    const calls = mockAppendFile.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c[0]).toBe(expectedPath)

    // mkdir was called for the directory
    expect(mockMkdir).toHaveBeenCalled()
    expect(mockMkdir.mock.calls[0][0]).toBe('/tmp/diagnose-test-data/14')

    // Each non-stream_chunk message before & including 'result' should be logged.
    // system, assistant, tool_use, assistant, result = 5 messages
    expect(calls.length).toBe(5)

    // Each line should carry [<type>] tag
    const joined = calls.map((c) => String(c[1])).join('')
    expect(joined).toMatch(/\[system\]/)
    expect(joined).toMatch(/\[assistant\]/)
    expect(joined).toMatch(/\[tool_use\]/)
    expect(joined).toMatch(/\[result\]/)
    // stream_chunk must be skipped
    expect(joined).not.toMatch(/\[stream_chunk\]/)
    // Post-result message must NOT be logged
    expect(joined).not.toMatch(/NEVER-WRITTEN/)
    // Generator should not have been fully consumed past the result
    expect(consumed).toBeLessThanOrEqual(6)
  })

  it('does not write to file when taskId does not match pipeline-<n>-stage-<n>', async () => {
    const messages: Msg[] = [
      { type: 'assistant', timestamp: 1, text: 'hi' },
      { type: 'result', timestamp: 2, text: 'done' },
    ]
    mockQuery.mockImplementation(genFromArray(messages))

    const result = await handler(makeOpts('random-task-id-xyz'))

    expect(result.success).toBe(true)
    expect(mockAppendFile).not.toHaveBeenCalled()
    expect(mockMkdir).not.toHaveBeenCalled()
  })

  it('returns success=false with error message when an error message is yielded', async () => {
    const messages: Msg[] = [
      { type: 'assistant', timestamp: 1, text: '尝试中' },
      { type: 'error', timestamp: 2, message: 'rate limit exceeded', code: 'RATE_LIMIT' },
      { type: 'assistant', timestamp: 3, text: 'NEVER' }, // post-error must be skipped
    ]
    mockQuery.mockImplementation(genFromArray(messages))

    const result = await handler(makeOpts('pipeline-7-stage-0'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('rate limit exceeded')

    const joined = mockAppendFile.mock.calls.map((c) => String(c[1])).join('')
    expect(joined).toMatch(/\[error\]/)
    expect(joined).not.toMatch(/NEVER/)
  })

  it('catches generator throw and returns success=false', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'assistant', timestamp: 1, text: 'starting' } as Msg
      throw new Error('porygon backend crashed')
    })

    const result = await handler(makeOpts('pipeline-1-stage-0'))

    expect(result.success).toBe(false)
    expect(String(result.error)).toContain('porygon backend crashed')
  })

  it('falls back to last assistant text when stream ends without a result message', async () => {
    const messages: Msg[] = [
      { type: 'assistant', timestamp: 1, text: '阶段 1' },
      { type: 'tool_use', timestamp: 2, toolName: 'run_remote_command', input: {} },
      { type: 'assistant', timestamp: 3, text: '最终阶段总结文本' },
    ]
    mockQuery.mockImplementation(genFromArray(messages))

    const result = await handler(makeOpts('pipeline-2-stage-1'))

    expect(result.success).toBe(true)
    expect(result.output).toContain('最终阶段总结文本')
  })

  it('rejects with validation error when failedCommand or serverHost is missing', async () => {
    const result = await handler({
      capabilityKey: 'diagnose_and_repair',
      context: { taskId: 'pipeline-1-stage-0', groupId: 'g', platform: 'p', initiatorId: 'u', initiatorRole: 'admin' },
      extraParams: { failedCommand: '', serverHost: '' },
    })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/failedCommand 和 serverHost 必填/)
  })
})
