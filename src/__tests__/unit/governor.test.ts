// src/__tests__/unit/governor.test.ts
import { describe, it, expect } from 'vitest'
import {
  governorCheck,
  isScenarioOverBudget,
  buildInitialGovernorState,
  DEFAULT_GOVERNOR_LIMITS,
} from '../../e2e/pipeline-b/governor.js'
import type { GovernorState } from '../../e2e/pipeline-b/types.js'

function makeGovernorState(overrides: Partial<GovernorState> = {}): GovernorState {
  return {
    runStartedAt: Date.now() - 1000,
    totalAttempts: 0,
    totalElapsedMs: 0,
    perScenarioAttempts: {},
    limits: {
      maxPerScenarioAttempts: 3,
      maxRunHours: 4,
      maxTotalAttempts: 30,
      maxQueuedRuns: 2,
    },
    ...overrides,
  }
}

describe('governorCheck', () => {
  it('新 run 返回 continue', () => {
    const state = makeGovernorState()
    expect(governorCheck(state)).toBe('continue')
  })

  it('totalAttempts 等于上限 → over_budget', () => {
    const state = makeGovernorState({ totalAttempts: 30 })
    expect(governorCheck(state)).toBe('over_budget')
  })

  it('totalAttempts 超过上限 → over_budget', () => {
    const state = makeGovernorState({ totalAttempts: 31 })
    expect(governorCheck(state)).toBe('over_budget')
  })

  it('totalAttempts 低于上限 → continue', () => {
    const state = makeGovernorState({ totalAttempts: 29 })
    expect(governorCheck(state)).toBe('continue')
  })

  it('run 超 maxRunHours → over_budget', () => {
    const state = makeGovernorState({
      runStartedAt: Date.now() - 4 * 3600 * 1000 - 1,
    })
    expect(governorCheck(state)).toBe('over_budget')
  })

  it('run 未超 maxRunHours → continue', () => {
    const state = makeGovernorState({
      runStartedAt: Date.now() - 3600 * 1000,
    })
    expect(governorCheck(state)).toBe('continue')
  })

  it('自定义 maxTotalAttempts 生效', () => {
    const state = makeGovernorState({
      totalAttempts: 5,
      limits: {
        maxPerScenarioAttempts: 3,
        maxRunHours: 4,
        maxTotalAttempts: 5,
        maxQueuedRuns: 2,
      },
    })
    expect(governorCheck(state)).toBe('over_budget')
  })
})

describe('isScenarioOverBudget', () => {
  it('无记录 → false', () => {
    const state = makeGovernorState()
    expect(isScenarioOverBudget('s1', state)).toBe(false)
  })

  it('attempts 低于上限 → false', () => {
    const state = makeGovernorState({ perScenarioAttempts: { s1: 2 } })
    expect(isScenarioOverBudget('s1', state)).toBe(false)
  })

  it('attempts 等于上限 → true', () => {
    const state = makeGovernorState({ perScenarioAttempts: { s1: 3 } })
    expect(isScenarioOverBudget('s1', state)).toBe(true)
  })

  it('attempts 超过上限 → true', () => {
    const state = makeGovernorState({ perScenarioAttempts: { s1: 4 } })
    expect(isScenarioOverBudget('s1', state)).toBe(true)
  })

  it('自定义 maxPerScenarioAttempts 生效', () => {
    const state = makeGovernorState({
      perScenarioAttempts: { s1: 2 },
      limits: {
        maxPerScenarioAttempts: 2,
        maxRunHours: 4,
        maxTotalAttempts: 30,
        maxQueuedRuns: 2,
      },
    })
    expect(isScenarioOverBudget('s1', state)).toBe(true)
  })
})

describe('buildInitialGovernorState', () => {
  it('无 overrides → 默认 limits + 零计数器', () => {
    const before = Date.now()
    const state = buildInitialGovernorState()
    const after = Date.now()

    expect(state.limits.maxTotalAttempts).toBe(30)
    expect(state.limits.maxRunHours).toBe(4)
    expect(state.limits.maxPerScenarioAttempts).toBe(3)
    expect(state.limits.maxQueuedRuns).toBe(2)
    expect(state.totalAttempts).toBe(0)
    expect(state.totalElapsedMs).toBe(0)
    expect(state.perScenarioAttempts).toEqual({})
    expect(state.runStartedAt).toBeGreaterThanOrEqual(before)
    expect(state.runStartedAt).toBeLessThanOrEqual(after)
  })

  it('overrides 单字段 → 仅该字段被覆盖，其余保持默认', () => {
    const state = buildInitialGovernorState({ maxRunHours: 1 })
    expect(state.limits.maxRunHours).toBe(1)
    expect(state.limits.maxTotalAttempts).toBe(30)
    expect(state.limits.maxPerScenarioAttempts).toBe(3)
  })

  it('DEFAULT_GOVERNOR_LIMITS 导出可被外部直接读取', () => {
    expect(DEFAULT_GOVERNOR_LIMITS.maxTotalAttempts).toBe(30)
    expect(DEFAULT_GOVERNOR_LIMITS.maxRunHours).toBe(4)
    expect(DEFAULT_GOVERNOR_LIMITS.maxPerScenarioAttempts).toBe(3)
    expect(DEFAULT_GOVERNOR_LIMITS.maxQueuedRuns).toBe(2)
  })
})
