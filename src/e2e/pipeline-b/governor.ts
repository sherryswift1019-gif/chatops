// src/e2e/pipeline-b/governor.ts
import type { GovernorState } from './types.js'

export type GovernorDecision = 'continue' | 'over_budget'

export const DEFAULT_GOVERNOR_LIMITS = {
  maxPerScenarioAttempts: 3,
  maxRunHours: 4,
  maxTotalAttempts: 30,
  maxQueuedRuns: 2,
} as const

export function buildInitialGovernorState(overrides?: {
  maxPerScenarioAttempts?: number
  maxRunHours?: number
  maxTotalAttempts?: number
}): GovernorState {
  return {
    runStartedAt: Date.now(),
    totalAttempts: 0,
    totalElapsedMs: 0,
    perScenarioAttempts: {},
    limits: { ...DEFAULT_GOVERNOR_LIMITS, ...overrides },
  }
}

export function governorCheck(state: GovernorState): GovernorDecision {
  if (Date.now() - state.runStartedAt > state.limits.maxRunHours * 3600 * 1000) {
    return 'over_budget'
  }
  if (state.totalAttempts >= state.limits.maxTotalAttempts) {
    return 'over_budget'
  }
  return 'continue'
}

export function isScenarioOverBudget(scenarioId: string, state: GovernorState): boolean {
  return (state.perScenarioAttempts[scenarioId] ?? 0) >= state.limits.maxPerScenarioAttempts
}
