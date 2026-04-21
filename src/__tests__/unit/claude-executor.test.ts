import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../agent/claude-cli.js', () => ({
  runClaudeCli: vi.fn(),
}))

import { runClaudeCli } from '../../agent/claude-cli.js'
import {
  CliExecutor,
  getClaudeExecutor,
  resetExecutorForTest,
  type ClaudeExecutor,
} from '../../agent/claude-executor.js'

describe('CliExecutor', () => {
  beforeEach(() => vi.mocked(runClaudeCli).mockReset())

  it('run 透传 prompt/allowedTools/timeoutMs/onEvent/signal 到 runClaudeCli', async () => {
    vi.mocked(runClaudeCli).mockResolvedValue('mock output')
    const onEvent = vi.fn()
    const signal = new AbortController().signal

    const executor: ClaudeExecutor = new CliExecutor()
    const out = await executor.run({
      prompt: 'hello',
      allowedTools: 'Read,Glob',
      timeoutMs: 1_200_000,
      onEvent,
      signal,
    })

    expect(out).toBe('mock output')
    expect(vi.mocked(runClaudeCli)).toHaveBeenCalledWith({
      prompt: 'hello',
      allowedTools: 'Read,Glob',
      timeoutMs: 1_200_000,
      onEvent,
      signal,
    })
  })
})

describe('getClaudeExecutor factory', () => {
  beforeEach(() => {
    resetExecutorForTest()
    delete process.env.CLAUDE_EXECUTOR
    process.env.NODE_ENV = 'test'
  })

  it('NODE_ENV=test → 默认 CliExecutor（不触碰外部 Claude）', () => {
    process.env.NODE_ENV = 'test'
    const exec = getClaudeExecutor()
    expect(exec.constructor.name).toBe('CliExecutor')
  })

  it('显式 CLAUDE_EXECUTOR=cli → CliExecutor（即使生产环境）', () => {
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_EXECUTOR = 'cli'
    const exec = getClaudeExecutor()
    expect(exec.constructor.name).toBe('CliExecutor')
  })

  it('显式 CLAUDE_EXECUTOR=porygon → PorygonExecutor', () => {
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_EXECUTOR = 'porygon'
    const exec = getClaudeExecutor()
    expect(exec.constructor.name).toBe('PorygonExecutor')
  })

  it('非 test 环境 + 未设 CLAUDE_EXECUTOR → 默认 PorygonExecutor', () => {
    process.env.NODE_ENV = 'production'
    const exec = getClaudeExecutor()
    expect(exec.constructor.name).toBe('PorygonExecutor')
  })

  it('非法值（既不是 cli 也不是 porygon）→ 立即抛错', () => {
    process.env.NODE_ENV = 'production'
    process.env.CLAUDE_EXECUTOR = 'sonnet-4-6'
    expect(() => getClaudeExecutor()).toThrow(/CLAUDE_EXECUTOR/)
  })

  it('缓存同一个实例（module-level singleton）', () => {
    process.env.CLAUDE_EXECUTOR = 'cli'
    const e1 = getClaudeExecutor()
    const e2 = getClaudeExecutor()
    expect(e1).toBe(e2)
  })
})
