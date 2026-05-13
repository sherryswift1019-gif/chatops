import { describe, it, expect } from 'vitest'
import { advanceBrainstormState, type BrainstormState } from '../../pipeline/node-types/llm-brainstorm.js'

const validQuestion = `
## 已查证的现状
- 项目无登录页
## 这一轮要决定
- 选择存储方式
## 选项（带我的推荐）
**A. localStorage** ← 推荐
**B. cookie**
## 我替你做的默认（如果你不否决就走）
- 复选框默认不勾选
## 你怎么回？
- A / B
`

const baseState: BrainstormState = {
  round: 1, history: [], enrichedInput: {}, readyForSpec: false,
  earlyDone: false, partial: false, failedQualityRounds: 0,
}

describe('brainstorm failover scenarios', () => {
  it('user /done sets earlyDone=true and readyForSpec=true', () => {
    const next = advanceBrainstormState(baseState, {
      llmOutput: { decision: 'ask', round: 1, question: validQuestion },
      userAnswer: { freeText: '/done' }, source: 'web',
    })
    expect(next.earlyDone).toBe(true)
    expect(next.readyForSpec).toBe(true)
  })

  it('user "结束" sets earlyDone=true', () => {
    const next = advanceBrainstormState(baseState, {
      llmOutput: { decision: 'ask', round: 1, question: validQuestion },
      userAnswer: { freeText: '结束' }, source: 'web',
    })
    expect(next.earlyDone).toBe(true)
    expect(next.readyForSpec).toBe(true)
  })

  it('user "够了" sets earlyDone=true', () => {
    const next = advanceBrainstormState(baseState, {
      llmOutput: { decision: 'ask', round: 1, question: validQuestion },
      userAnswer: { freeText: '够了' }, source: 'web',
    })
    expect(next.earlyDone).toBe(true)
  })

  it('user "stop" sets earlyDone=true', () => {
    const next = advanceBrainstormState(baseState, {
      llmOutput: { decision: 'ask', round: 1, question: validQuestion },
      userAnswer: { freeText: 'stop' }, source: 'web',
    })
    expect(next.earlyDone).toBe(true)
  })

  it('consecutive 2x quality fail → partial=true + readyForSpec', () => {
    let state = baseState
    state = advanceBrainstormState(state, {
      llmOutput: { decision: 'ask', round: 1, question: '## 仅一段' },
      userAnswer: null, source: 'web',
    })
    expect(state.failedQualityRounds).toBe(1)
    expect(state.readyForSpec).toBe(false)

    state = advanceBrainstormState(state, {
      llmOutput: { decision: 'ask', round: 1, question: '## 仅一段' },
      userAnswer: null, source: 'web',
    })
    expect(state.failedQualityRounds).toBe(2)
    expect(state.partial).toBe(true)
    expect(state.readyForSpec).toBe(true)
  })

  it('priority: quality fail > round cap (state at round=5 with 1 prior fail)', () => {
    const at5fail1: BrainstormState = { ...baseState, round: 5, failedQualityRounds: 1 }
    const next = advanceBrainstormState(at5fail1, {
      llmOutput: { decision: 'ask', round: 5, question: '## 仅一段' },
      userAnswer: null, source: 'web',
    })
    expect(next.failedQualityRounds).toBe(2)
    expect(next.partial).toBe(true)
    expect(next.readyForSpec).toBe(true)
    expect(next.round).toBe(5)  // round did not advance (quality fail wins)
  })

  it('normal user answer (not /done) does not set earlyDone', () => {
    const next = advanceBrainstormState(baseState, {
      llmOutput: { decision: 'ask', round: 1, question: validQuestion },
      userAnswer: { freeText: 'A' }, source: 'web',
    })
    expect(next.earlyDone).toBe(false)
    expect(next.round).toBe(2)
  })
})
