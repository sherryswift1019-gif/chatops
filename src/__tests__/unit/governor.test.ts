// src/__tests__/unit/governor.test.ts
import { describe, it, expect } from 'vitest'
import { governorCheck, isScenarioOverBudget } from '../../e2e/pipeline-b/governor.js'
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
