import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  setMockResponse,
  popMockResponse,
  popMockResponseValidated,
  resetMockResponses,
  recordSentMessage,
  getSentMessages,
  clearSentMessages,
  isE2EMode,
  isClaudeMock,
} from '../../agent/mocks/e2e-store.js'

describe('e2e-store', () => {
  beforeEach(() => {
    resetMockResponses()
    clearSentMessages()
  })

  describe('mock responses', () => {
    it('setMockResponse + popMockResponse 按 FIFO 顺序返回', () => {
      setMockResponse('analyze_bug-filter', { a: 1 })
      setMockResponse('analyze_bug-filter', { a: 2 })
      setMockResponse('analyze_bug-filter', { a: 3 })

      expect(popMockResponse('analyze_bug-filter')).toEqual({ a: 1 })
      expect(popMockResponse('analyze_bug-filter')).toEqual({ a: 2 })
      expect(popMockResponse('analyze_bug-filter')).toEqual({ a: 3 })
    })

    it('popMockResponse 空队列返回 undefined', () => {
      expect(popMockResponse('analyze_bug-filter')).toBeUndefined()
    })

    it('不同 key 的队列互相独立', () => {
      setMockResponse('key-a', 'alpha')
      setMockResponse('key-b', 'beta')

      expect(popMockResponse('key-a')).toBe('alpha')
      expect(popMockResponse('key-b')).toBe('beta')
      expect(popMockResponse('key-a')).toBeUndefined()
    })

    it('resetMockResponses 清空所有 key', () => {
      setMockResponse('k1', 1)
      setMockResponse('k2', 2)
      resetMockResponses()
      expect(popMockResponse('k1')).toBeUndefined()
      expect(popMockResponse('k2')).toBeUndefined()
    })
  })

  describe('popMockResponseValidated', () => {
    type Shape = { branch: string; testPassed: boolean }

    it('必需字段齐全 → 正常返回', () => {
      setMockResponse('fix-foo', { branch: 'fix/1', testPassed: true })
      const r = popMockResponseValidated<Shape>('fix-foo', ['branch', 'testPassed'])
      expect(r.branch).toBe('fix/1')
    })

    it('队列为空 → 抛包含 key 的错误', () => {
      expect(() => popMockResponseValidated<Shape>('fix-foo', ['branch'])).toThrow(
        /no mock response queued for fix-foo/,
      )
    })

    it('响应非对象 → 抛明确错误', () => {
      setMockResponse('fix-foo', 'some string')
      expect(() => popMockResponseValidated<Shape>('fix-foo', ['branch'])).toThrow(
        /must be object, got string/,
      )
    })

    it('响应为 null → 抛明确错误', () => {
      setMockResponse('fix-foo', null)
      expect(() => popMockResponseValidated<Shape>('fix-foo', ['branch'])).toThrow(
        /must be object, got object/,
      )
    })

    it('缺必需字段 → 抛含字段名的错误', () => {
      setMockResponse('fix-foo', { branch: 'fix/1' })
      expect(() =>
        popMockResponseValidated<Shape>('fix-foo', ['branch', 'testPassed']),
      ).toThrow(/missing required field "testPassed"/)
    })
  })

  describe('recorded messages', () => {
    it('recordSentMessage 写入并可被 getSentMessages 读出', () => {
      recordSentMessage({ kind: 'group', to: 'g1', text: 'hello' })
      const msgs = getSentMessages()
      expect(msgs).toHaveLength(1)
      expect(msgs[0].kind).toBe('group')
      expect(msgs[0].to).toBe('g1')
      expect(msgs[0].text).toBe('hello')
      expect(typeof msgs[0].timestamp).toBe('number')
    })

    it('getSentMessages 支持按 kind 过滤', () => {
      recordSentMessage({ kind: 'group', to: 'g1', text: '1' })
      recordSentMessage({ kind: 'direct', to: 'u1', text: '2' })
      recordSentMessage({ kind: 'card', to: 'g2', card: { title: 'x' } })

      const direct = getSentMessages({ kind: 'direct' })
      expect(direct).toHaveLength(1)
      expect(direct[0].to).toBe('u1')
    })

    it('getSentMessages 支持按 to 过滤', () => {
      recordSentMessage({ kind: 'group', to: 'g1', text: '1' })
      recordSentMessage({ kind: 'group', to: 'g2', text: '2' })
      recordSentMessage({ kind: 'direct', to: 'g1', text: '3' })

      const toG1 = getSentMessages({ to: 'g1' })
      expect(toG1).toHaveLength(2)
    })

    it('getSentMessages 支持组合过滤 kind + to', () => {
      recordSentMessage({ kind: 'group', to: 'g1', text: '1' })
      recordSentMessage({ kind: 'direct', to: 'g1', text: '2' })
      recordSentMessage({ kind: 'group', to: 'g2', text: '3' })

      const res = getSentMessages({ kind: 'group', to: 'g1' })
      expect(res).toHaveLength(1)
      expect(res[0].text).toBe('1')
    })

    it('clearSentMessages 清空', () => {
      recordSentMessage({ kind: 'group', to: 'g1', text: '1' })
      clearSentMessages()
      expect(getSentMessages()).toHaveLength(0)
    })
  })

  describe('env flags', () => {
    const saved = { e2e: process.env.E2E_MODE, mock: process.env.CLAUDE_MOCK }

    afterEach(() => {
      if (saved.e2e === undefined) delete process.env.E2E_MODE
      else process.env.E2E_MODE = saved.e2e
      if (saved.mock === undefined) delete process.env.CLAUDE_MOCK
      else process.env.CLAUDE_MOCK = saved.mock
    })

    it('isE2EMode 读 process.env.E2E_MODE', () => {
      delete process.env.E2E_MODE
      expect(isE2EMode()).toBe(false)
      process.env.E2E_MODE = '1'
      expect(isE2EMode()).toBe(true)
      process.env.E2E_MODE = '0'
      expect(isE2EMode()).toBe(false)
    })

    it('isClaudeMock 读 process.env.CLAUDE_MOCK', () => {
      delete process.env.CLAUDE_MOCK
      expect(isClaudeMock()).toBe(false)
      process.env.CLAUDE_MOCK = '1'
      expect(isClaudeMock()).toBe(true)
      process.env.CLAUDE_MOCK = '0'
      expect(isClaudeMock()).toBe(false)
    })
  })
})
