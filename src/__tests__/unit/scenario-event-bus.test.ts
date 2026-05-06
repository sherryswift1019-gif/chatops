import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  emit,
  subscribe,
  ensureRun,
  getHistory,
  clearRun,
  __resetForTesting,
  type ScenarioEvent,
} from '../../e2e/pipeline-b/scenario-event-bus.js'

const runId = 42n

function makeEvent(step: number): ScenarioEvent {
  return {
    type: 'tool_use',
    runId: runId.toString(),
    phase: 'scenario',
    step,
    toolName: `tool_${step}`,
    argsSummary: `args_${step}`,
    ts: Date.now(),
  }
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('scenario-event-bus', () => {
  beforeEach(() => {
    __resetForTesting()
  })

  describe('subscribe + emit', () => {
    it('listener 收到 emit 之后的事件', () => {
      ensureRun(runId)
      const received: ScenarioEvent[] = []
      subscribe(runId, (e) => received.push(e))
      emit(runId, makeEvent(1))
      emit(runId, makeEvent(2))
      expect(received).toHaveLength(2)
      expect(received[0].type).toBe('tool_use')
      expect((received[1] as { step: number }).step).toBe(2)
    })

    it('多订阅者都收到同一事件', () => {
      ensureRun(runId)
      const a: ScenarioEvent[] = []
      const b: ScenarioEvent[] = []
      subscribe(runId, (e) => a.push(e))
      subscribe(runId, (e) => b.push(e))
      emit(runId, makeEvent(1))
      expect(a).toHaveLength(1)
      expect(b).toHaveLength(1)
    })

    it('unsubscribe 后不再收到事件', () => {
      ensureRun(runId)
      const received: ScenarioEvent[] = []
      const unsub = subscribe(runId, (e) => received.push(e))
      emit(runId, makeEvent(1))
      unsub()
      emit(runId, makeEvent(2))
      expect(received).toHaveLength(1)
    })

    it('listener 抛错不影响其他 listener', () => {
      ensureRun(runId)
      const a: ScenarioEvent[] = []
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ })
      subscribe(runId, () => { throw new Error('listener boom') })
      subscribe(runId, (e) => a.push(e))
      emit(runId, makeEvent(1))
      expect(a).toHaveLength(1)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })

    it('emit 中 listener 调 unsubscribe 不引发迭代异常（snapshot 验证）', () => {
      ensureRun(runId)
      const received: ScenarioEvent[] = []
      let unsubA = (): void => { /* placeholder */ }
      unsubA = subscribe(runId, (e) => {
        received.push(e)
        unsubA()  // 在 listener 内删除自己
      })
      subscribe(runId, (e) => received.push(e))
      emit(runId, makeEvent(1))
      // 第一个 listener 自删后第二个仍能收到事件
      expect(received).toHaveLength(2)
    })
  })

  describe('history replay', () => {
    it('subscribe 之前 emit 的事件能从 getHistory 取到', () => {
      emit(runId, makeEvent(1))
      emit(runId, makeEvent(2))
      const history = getHistory(runId)
      expect(history).toHaveLength(2)
      expect((history[0] as { step: number }).step).toBe(1)
    })

    it('history 上限 MAX_HISTORY=1000，超过 shift 旧事件', () => {
      for (let i = 0; i < 1005; i++) emit(runId, makeEvent(i))
      const history = getHistory(runId)
      expect(history).toHaveLength(1000)
      // 最旧 5 条应被 shift 掉
      expect((history[0] as { step: number }).step).toBe(5)
      expect((history[999] as { step: number }).step).toBe(1004)
    })

    it('getHistory 返回快照副本，外部修改不影响内部 history', () => {
      emit(runId, makeEvent(1))
      const h = getHistory(runId)
      h.push(makeEvent(99))
      expect(getHistory(runId)).toHaveLength(1)
    })
  })

  describe('subscribe 不存在的 runId', () => {
    it('立即（next tick）fire closed 给 cb，返回的 unsubscribe 是 noop 不抛', async () => {
      const received: ScenarioEvent[] = []
      const unsub = subscribe(runId, (e) => received.push(e))
      // synchronous 阶段 cb 还没被调
      expect(received).toHaveLength(0)
      await nextTick()
      expect(received).toHaveLength(1)
      expect(received[0].type).toBe('closed')
      expect((received[0] as { runId: string }).runId).toBe(runId.toString())
      // unsubscribe noop 不抛
      expect(() => unsub()).not.toThrow()
    })

    it('clearRun 后再 subscribe 也立即 fire closed', async () => {
      ensureRun(runId)
      emit(runId, makeEvent(1))
      clearRun(runId)
      const received: ScenarioEvent[] = []
      subscribe(runId, (e) => received.push(e))
      await nextTick()
      expect(received).toHaveLength(1)
      expect(received[0].type).toBe('closed')
    })
  })

  describe('runId 防御', () => {
    it('emit(0n, ...) 不存也不抛', () => {
      expect(() => emit(0n, makeEvent(1))).not.toThrow()
      expect(getHistory(0n)).toEqual([])
    })

    it('ensureRun(0n) 是 noop', () => {
      ensureRun(0n)
      expect(getHistory(0n)).toEqual([])
    })

    it('subscribe(0n, cb) 立即 fire closed', async () => {
      const received: ScenarioEvent[] = []
      subscribe(0n, (e) => received.push(e))
      await nextTick()
      expect(received).toHaveLength(1)
      expect(received[0].type).toBe('closed')
    })
  })

  describe('clearRun', () => {
    it('clearRun 后 history 空、subscribe 重新触发 closed 而非 emit', async () => {
      ensureRun(runId)
      emit(runId, makeEvent(1))
      expect(getHistory(runId)).toHaveLength(1)
      clearRun(runId)
      expect(getHistory(runId)).toEqual([])

      const received: ScenarioEvent[] = []
      subscribe(runId, (e) => received.push(e))
      await nextTick()
      expect(received[0].type).toBe('closed')
    })

    it('clearRun 后再 ensureRun 重新建空 bus，可以正常订阅 + emit', () => {
      ensureRun(runId)
      emit(runId, makeEvent(1))
      clearRun(runId)
      ensureRun(runId)

      const received: ScenarioEvent[] = []
      subscribe(runId, (e) => received.push(e))
      emit(runId, makeEvent(2))
      expect(received).toHaveLength(1)
      expect((received[0] as { step: number }).step).toBe(2)
    })
  })

  describe('ensureRun', () => {
    it('ensureRun 后 subscribe 不会立即 fire closed', () => {
      ensureRun(runId)
      const received: ScenarioEvent[] = []
      subscribe(runId, (e) => received.push(e))
      // synchronous + setImmediate 后都不应有 closed
      return nextTick().then(() => {
        expect(received).toHaveLength(0)
      })
    })

    it('ensureRun 幂等：多次调用不重置 history', () => {
      ensureRun(runId)
      emit(runId, makeEvent(1))
      ensureRun(runId)
      ensureRun(runId)
      expect(getHistory(runId)).toHaveLength(1)
    })
  })
})
