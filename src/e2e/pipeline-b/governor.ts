// src/e2e/pipeline-b/governor.ts
import type { GovernorState } from './types.js'

export type GovernorDecision = 'continue' | 'over_budget'

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
