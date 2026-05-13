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

describe('advanceBrainstormState', () => {
  it('appends turn to history and increments round (ask + user answer)', () => {
    const next = advanceBrainstormState(baseState, {
      llmOutput: { decision: 'ask', round: 1, question: validQuestion },
      userAnswer: { freeText: 'A' },
      source: 'web',
    })
    expect(next.round).toBe(2)
    expect(next.history).toHaveLength(1)
    expect(next.history[0]?.answer).toBe('A')
  })

  it('sets readyForSpec=true when LLM signals ready', () => {
    const next = advanceBrainstormState(baseState, {
      llmOutput: { decision: 'ready', round: 1 },
      userAnswer: null, source: 'web',
    })
    expect(next.readyForSpec).toBe(true)
  })

  it('sets partial=true + readyForSpec when decision=fail', () => {
    const next = advanceBrainstormState(baseState, {
      llmOutput: { decision: 'fail', round: 1 },
      userAnswer: null, source: 'web',
    })
    expect(next.partial).toBe(true)
    expect(next.readyForSpec).toBe(true)
  })

  it('failedQualityRounds += 1 when 5-section parse fails (decision=ask + invalid markdown)', () => {
    const next = advanceBrainstormState(baseState, {
      llmOutput: { decision: 'ask', round: 1, question: '## 只有一段' },
      userAnswer: null, source: 'web',
    })
    expect(next.failedQualityRounds).toBe(1)
    expect(next.round).toBe(1)  // round did not advance
    expect(next.history).toHaveLength(0)
  })

  it('merges enrichedInputDelta into state.enrichedInput', () => {
    const next = advanceBrainstormState(baseState, {
      llmOutput: {
        decision: 'ask', round: 1, question: validQuestion,
        enrichedInputDelta: { objective: { successSignal: 'login redirects' } },
      },
      userAnswer: { freeText: 'A' },
      source: 'web',
    })
    expect((next.enrichedInput as any).objective.successSignal).toBe('login redirects')
  })

  it('forces partial=true when round > 5 cap', () => {
    const at5: BrainstormState = { ...baseState, round: 5 }
    // round=5 triggers history-reference check; include a history keyword to pass validation
    const questionWithHistory = `
## 已查证的现状
- 上一轮确认了存储方式为 localStorage
## 这一轮要决定
- 选择认证方案
## 选项（带我的推荐）
**A. JWT** ← 推荐
**B. Session**
## 我替你做的默认（如果你不否决就走）
- 默认选 A
## 你怎么回？
- A / B
`
    const next = advanceBrainstormState(at5, {
      llmOutput: { decision: 'ask', round: 5, question: questionWithHistory },
      userAnswer: { freeText: 'A' },
      source: 'web',
    })
    expect(next.round).toBe(6)
    expect(next.partial).toBe(true)
    expect(next.readyForSpec).toBe(true)
  })
})
