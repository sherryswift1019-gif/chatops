// Validates that ClaudeRunner.executeCapabilityDirect's consume loop reads
// Porygon's AgentMessage schema correctly (text / toolName), not Anthropic
// SDK's raw fields (content / name).
//
// Anti-regression for: fe61c07 — pre-fix, every long / multi-turn LLM call
// returned empty string because 'content' in msg was always false against
// Porygon's AgentAssistantMessage.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TaskContext } from '../../agent/tools/types.js'

// Mock Porygon: createPorygon returns an object whose query() yields whatever
// messages mockMessages is set to at the time of the call.
let mockMessages: Array<Record<string, unknown>> = []
vi.mock('@snack-kit/porygon', () => ({
  createPorygon: vi.fn(() => ({
    query: vi.fn(() => {
      const messages = mockMessages
      return (async function* () {
        for (const msg of messages) yield msg
      })()
    }),
    run: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
}))

// buildClaudeEnv hits DB; stub out
vi.mock('../../agent/claude-config.js', () => ({
  buildClaudeEnv: vi.fn().mockResolvedValue({}),
}))

// Avoid pulling DB-bound tools registration on import path
vi.mock('../../agent/tools/index.js', () => ({
  getTool: vi.fn(),
  getAllTools: vi.fn(() => []),
  getPermittedTools: vi.fn(() => []),
}))

const { ClaudeRunner } = await import('../../agent/claude-runner.js')

const baseContext: TaskContext = {
  taskId: 't1',
  groupId: 'g1',
  platform: 'internal',
  initiatorId: 'u1',
  initiatorRole: null,
}
const baseOpts = {
  prompt: 'test prompt',
  systemPrompt: 'test system',
  context: baseContext,
  tools: [],
}

describe('ClaudeRunner.executeCapabilityDirect consume loop ↔ Porygon AgentMessage contract', () => {
  let runner: InstanceType<typeof ClaudeRunner>
  let consoleLogSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    runner = new ClaudeRunner()
    mockMessages = []
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLogSpy.mockRestore()
  })

  it('accumulates assistant.text across multiple turns when no result message', async () => {
    // Pre-fix code read msg.content (which Porygon doesn't set), so this
    // returned ''. With the fix we read msg.text and fall back to
    // assistantBuffer when result.text is absent.
    mockMessages = [
      { type: 'assistant', text: 'abc', timestamp: 1 },
      { type: 'assistant', text: 'def', timestamp: 2 },
    ]
    const result = await runner.executeCapabilityDirect(baseOpts)
    expect(result).toBe('abcdef')
  })

  it('prefers result.text over assistant fallback when result is emitted', async () => {
    mockMessages = [
      { type: 'assistant', text: 'partial', timestamp: 1 },
      { type: 'result', text: 'final', timestamp: 2 },
    ]
    const result = await runner.executeCapabilityDirect(baseOpts)
    // result.text is the canonical final text; we don't double-count assistant
    expect(result).toBe('final')
  })

  it('logs tool_use using msg.toolName, not literal "unknown"', async () => {
    mockMessages = [
      { type: 'tool_use', toolName: 'bash', input: { cmd: 'ls' }, timestamp: 1 },
      { type: 'result', text: 'ok', timestamp: 2 },
    ]
    await runner.executeCapabilityDirect(baseOpts)
    const logs: string[] = consoleLogSpy.mock.calls.map((c: unknown[]) => String(c[0]))
    // Pre-fix code did `'name' in msg ? msg.name : 'unknown'`; Porygon msg has
    // no `name` field, so it always logged "Tool called: unknown" regardless
    // of the actual tool. The fix reads msg.toolName.
    expect(logs.some((l: string) => l.includes('Tool called: bash'))).toBe(true)
    expect(logs.some((l: string) => l === '[Runner] Tool called: unknown')).toBe(false)
  })

  it('falls back to assistantBuffer when consume ends without result.text', async () => {
    // Simulates Claude using SDK-builtin planning tools (TodoWrite etc.) that
    // exhaust maxTurns before a final result message is emitted.
    mockMessages = [
      { type: 'tool_use', toolName: 'TodoWrite', input: {}, timestamp: 1 },
      { type: 'assistant', text: 'I will write code\n', timestamp: 2 },
      { type: 'tool_use', toolName: 'TodoWrite', input: {}, timestamp: 3 },
      { type: 'assistant', text: 'function foo() {}', timestamp: 4 },
    ]
    const result = await runner.executeCapabilityDirect(baseOpts)
    expect(result).toBe('I will write code\nfunction foo() {}')
  })

  it('returns empty string when Porygon emits no messages', async () => {
    mockMessages = []
    const result = await runner.executeCapabilityDirect(baseOpts)
    expect(result).toBe('')
  })
})
