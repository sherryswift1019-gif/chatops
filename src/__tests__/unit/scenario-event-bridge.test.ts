import { describe, it, expect, beforeEach } from 'vitest'
import {
  createOnMessageBridge,
  summarizeArgs,
  truncate,
} from '../../e2e/pipeline-b/scenario-event-bridge.js'
import {
  __resetForTesting,
  ensureRun,
  getHistory,
} from '../../e2e/pipeline-b/scenario-event-bus.js'

const RUN_ID = 12345n

describe('scenario-event-bridge', () => {
  beforeEach(() => {
    __resetForTesting()
    ensureRun(RUN_ID)
  })

  describe('createOnMessageBridge — tool_use', () => {
    it('step 自增（第一次=1，第二次=2）', () => {
      const bridge = createOnMessageBridge(RUN_ID, 'scenario')
      bridge({ type: 'tool_use', toolName: 'Read', input: { path: '/tmp/a' } })
      bridge({ type: 'tool_use', toolName: 'Bash', input: { cmd: 'ls' } })
      const history = getHistory(RUN_ID).filter((e) => e.type === 'tool_use')
      expect(history.length).toBe(2)
      expect(history[0]).toMatchObject({ type: 'tool_use', step: 1, toolName: 'Read' })
      expect(history[1]).toMatchObject({ type: 'tool_use', step: 2, toolName: 'Bash' })
    })

    it('toolName 默认 unknown 当 msg.toolName 缺失', () => {
      const bridge = createOnMessageBridge(RUN_ID, 'scenario')
      bridge({ type: 'tool_use', input: {} })
      const history = getHistory(RUN_ID).filter((e) => e.type === 'tool_use')
      expect(history[0]).toMatchObject({ type: 'tool_use', toolName: 'unknown', step: 1 })
    })

    it('argsSummary 由 summarizeArgs 产出', () => {
      const bridge = createOnMessageBridge(RUN_ID, 'scenario')
      bridge({ type: 'tool_use', toolName: 'Read', input: { path: '/x', limit: 10 } })
      const history = getHistory(RUN_ID).filter((e) => e.type === 'tool_use')
      expect(history[0]).toMatchObject({ type: 'tool_use' })
      const summary = (history[0] as { argsSummary: string }).argsSummary
      expect(summary).toContain('path=')
      expect(summary).toContain('limit=')
    })

    it('phase=scenario 与 phase=fix 各自独立计数并传播 phase', () => {
      const bScenario = createOnMessageBridge(RUN_ID, 'scenario')
      const bFix = createOnMessageBridge(RUN_ID, 'fix')
      bScenario({ type: 'tool_use', toolName: 'A', input: {} })
      bFix({ type: 'tool_use', toolName: 'B', input: {} })
      bScenario({ type: 'tool_use', toolName: 'C', input: {} })
      const tools = getHistory(RUN_ID).filter((e) => e.type === 'tool_use') as Array<
        Extract<ReturnType<typeof getHistory>[number], { type: 'tool_use' }>
      >
      expect(tools.map((e) => ({ phase: e.phase, step: e.step, toolName: e.toolName }))).toEqual([
        { phase: 'scenario', step: 1, toolName: 'A' },
        { phase: 'fix', step: 1, toolName: 'B' },
        { phase: 'scenario', step: 2, toolName: 'C' },
      ])
    })
  })

  describe('createOnMessageBridge — assistant', () => {
    it('text 超过 1024 字符截断且末尾 …', () => {
      const bridge = createOnMessageBridge(RUN_ID, 'scenario')
      const longText = 'x'.repeat(2000)
      bridge({ type: 'assistant', text: longText })
      const history = getHistory(RUN_ID).filter((e) => e.type === 'assistant_text') as Array<
        Extract<ReturnType<typeof getHistory>[number], { type: 'assistant_text' }>
      >
      expect(history.length).toBe(1)
      expect(history[0].text.length).toBe(1024)
      expect(history[0].text.endsWith('…')).toBe(true)
      expect(history[0].phase).toBe('scenario')
    })

    it('text 为空 / undefined 时不 emit', () => {
      const bridge = createOnMessageBridge(RUN_ID, 'scenario')
      bridge({ type: 'assistant', text: '' })
      bridge({ type: 'assistant' })
      const history = getHistory(RUN_ID).filter((e) => e.type === 'assistant_text')
      expect(history.length).toBe(0)
    })
  })

  describe('createOnMessageBridge — error', () => {
    it('error 桥接为 agent_error 事件', () => {
      const bridge = createOnMessageBridge(RUN_ID, 'fix')
      bridge({ type: 'error', message: 'something exploded' })
      const history = getHistory(RUN_ID).filter((e) => e.type === 'agent_error') as Array<
        Extract<ReturnType<typeof getHistory>[number], { type: 'agent_error' }>
      >
      expect(history.length).toBe(1)
      expect(history[0]).toMatchObject({
        type: 'agent_error',
        phase: 'fix',
        message: 'something exploded',
      })
    })

    it('error message 超长截断到 1024 + …', () => {
      const bridge = createOnMessageBridge(RUN_ID, 'scenario')
      bridge({ type: 'error', message: 'e'.repeat(5000) })
      const history = getHistory(RUN_ID).filter((e) => e.type === 'agent_error') as Array<
        Extract<ReturnType<typeof getHistory>[number], { type: 'agent_error' }>
      >
      expect(history[0].message.length).toBe(1024)
      expect(history[0].message.endsWith('…')).toBe(true)
    })

    it('error 无 message 时不 emit', () => {
      const bridge = createOnMessageBridge(RUN_ID, 'scenario')
      bridge({ type: 'error' })
      bridge({ type: 'error', message: '' })
      const history = getHistory(RUN_ID).filter((e) => e.type === 'agent_error')
      expect(history.length).toBe(0)
    })
  })

  describe('createOnMessageBridge — 其他类型', () => {
    it('未知类型 ignore', () => {
      const bridge = createOnMessageBridge(RUN_ID, 'scenario')
      bridge({ type: 'system', text: 'init' })
      bridge({ type: 'result', text: 'done' })
      bridge({ type: 'progress' } as never)
      expect(getHistory(RUN_ID).length).toBe(0)
    })
  })

  describe('summarizeArgs', () => {
    it('null / undefined / 数字 / string 不抛错', () => {
      expect(() => summarizeArgs(null)).not.toThrow()
      expect(() => summarizeArgs(undefined)).not.toThrow()
      expect(() => summarizeArgs(42)).not.toThrow()
      expect(() => summarizeArgs('hello')).not.toThrow()
      expect(summarizeArgs(42)).toBe('42')
      expect(summarizeArgs('hello')).toBe('hello')
    })

    it('循环引用对象不抛错', () => {
      const o: any = { name: 'foo' }
      o.self = o
      let result = ''
      expect(() => {
        result = summarizeArgs(o)
      }).not.toThrow()
      // 至少包含 name= 或 self= 之一（不要求精确格式，只验证不爆炸）
      expect(typeof result).toBe('string')
    })

    it('对象 entries 每个 value 截断到 120', () => {
      const longVal = 'a'.repeat(500)
      const summary = summarizeArgs({ key: longVal })
      // 单个 value 部分（含 key= 前缀）应该不超过 240（全文 cap），并且 value 段被截到 120
      // 我们检查 summary 包含 'key=' 且包含 '…'（截断标志）
      expect(summary.startsWith('key=')).toBe(true)
      expect(summary.includes('…')).toBe(true)
      // 全文 cap 240
      expect(summary.length).toBeLessThanOrEqual(240)
    })

    it('多 entry 全文超过 240 时仍被整体截断', () => {
      const obj: Record<string, string> = {}
      for (let i = 0; i < 20; i++) obj['k' + i] = 'v'.repeat(50)
      const summary = summarizeArgs(obj)
      expect(summary.length).toBeLessThanOrEqual(240)
    })

    it('BigInt 值不抛错', () => {
      const obj = { id: 123n }
      let result = ''
      expect(() => {
        result = summarizeArgs(obj)
      }).not.toThrow()
      expect(typeof result).toBe('string')
      expect(result.startsWith('id=')).toBe(true)
    })
  })

  describe('truncate', () => {
    it('s.length === max 返回原值', () => {
      const s = 'a'.repeat(10)
      expect(truncate(s, 10)).toBe(s)
    })

    it('s.length === max + 1 返回截断后（长度 max，末尾 …）', () => {
      const s = 'a'.repeat(11)
      const out = truncate(s, 10)
      expect(out.length).toBe(10)
      expect(out.endsWith('…')).toBe(true)
      // 前 9 个字符是原始 'a'
      expect(out.slice(0, 9)).toBe('a'.repeat(9))
    })

    it('s.length < max 返回原值', () => {
      expect(truncate('abc', 100)).toBe('abc')
    })

    it('s.length 远超 max 时正确截断', () => {
      const s = 'a'.repeat(2000)
      const out = truncate(s, 100)
      expect(out.length).toBe(100)
      expect(out.endsWith('…')).toBe(true)
    })
  })
})
