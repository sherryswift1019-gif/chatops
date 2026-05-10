/**
 * Phase 4: RequirementsPage helpers 单测。
 * - findStageForWaiter 通过 nodeId 匹配
 * - shouldWarnPlanRework 弹窗触发条件
 *
 * 设计参考：docs/prds/quick-impl-roles-v2/01-roles.md / 02-data-flow.md §6
 */
import { describe, it, expect } from 'vitest'
import { findStageForWaiter, shouldWarnPlanRework } from './requirements-helpers'
import type { ApprovalWaiterDTO, V2StageResult } from '../api/requirements'

const baseWaiter: ApprovalWaiterDTO = {
  id: 1,
  requirementId: 7,
  pipelineRunId: 100,
  nodeId: 'spec_review_loop',
  approvalKind: 'spec',
  round: 1,
  decisionSet: 'binary',
  imPlatform: null,
  imGroupId: null,
  contextSummary: null,
  claimedBy: null,
  claimedAt: null,
  decision: null,
  rejectReason: null,
  budgetDelta: null,
  decidedBy: null,
  createdAt: '2026-05-08T10:00:00Z',
}

const stage = (name: string): V2StageResult => ({
  name, type: 'skill_with_approval', status: 'success',
})

// =============================================================================
// findStageForWaiter
// =============================================================================

describe('findStageForWaiter', () => {
  it('returns undefined when stageResults is null', () => {
    expect(findStageForWaiter(null, baseWaiter)).toBeUndefined()
  })

  it('returns undefined when waiter is null', () => {
    expect(findStageForWaiter([stage('spec_review_loop')], null)).toBeUndefined()
  })

  it('matches by nodeId', () => {
    const stages = [stage('init_branch'), stage('spec_review_loop'), stage('plan_author')]
    const found = findStageForWaiter(stages, baseWaiter)
    expect(found?.name).toBe('spec_review_loop')
  })

  it('returns undefined if no stage with matching name', () => {
    const stages = [stage('init_branch'), stage('plan_author')]
    expect(findStageForWaiter(stages, baseWaiter)).toBeUndefined()
  })

  it('matches final_approval waiter to final_approval stage', () => {
    const finalWaiter = { ...baseWaiter, nodeId: 'final_approval', approvalKind: 'final' as const }
    const stages = [stage('spec_review_loop'), stage('final_approval')]
    expect(findStageForWaiter(stages, finalWaiter)?.name).toBe('final_approval')
  })
})

// =============================================================================
// shouldWarnPlanRework
// =============================================================================

describe('shouldWarnPlanRework', () => {
  describe('应该弹（true）', () => {
    it('spec + round=2 + rejected → true', () => {
      const w = { ...baseWaiter, round: 2 }
      expect(shouldWarnPlanRework(w, 'rejected')).toBe(true)
    })

    it('spec + round=5 + rejected → true', () => {
      const w = { ...baseWaiter, round: 5 }
      expect(shouldWarnPlanRework(w, 'rejected')).toBe(true)
    })
  })

  describe('不应该弹（false）', () => {
    it('round=1 不弹（首次 reject 不会引发 plan 重做，没有 acDiff 比对）', () => {
      const w = { ...baseWaiter, round: 1 }
      expect(shouldWarnPlanRework(w, 'rejected')).toBe(false)
    })

    it('approved 不弹', () => {
      const w = { ...baseWaiter, round: 2 }
      expect(shouldWarnPlanRework(w, 'approved')).toBe(false)
    })

    it('aborted 不弹', () => {
      const w = { ...baseWaiter, round: 2 }
      expect(shouldWarnPlanRework(w, 'aborted')).toBe(false)
    })

    it('budget_extended 不弹', () => {
      const w = { ...baseWaiter, round: 2 }
      expect(shouldWarnPlanRework(w, 'budget_extended')).toBe(false)
    })

    it('force_passed 不弹', () => {
      const w = { ...baseWaiter, round: 2 }
      expect(shouldWarnPlanRework(w, 'force_passed')).toBe(false)
    })

    it('final approvalKind 即使 round>=2 也不弹（final 不会触发 plan）', () => {
      const w = { ...baseWaiter, approvalKind: 'final' as const, round: 2 }
      expect(shouldWarnPlanRework(w, 'rejected')).toBe(false)
    })

    it('escalation approvalKind 不弹', () => {
      const w = { ...baseWaiter, approvalKind: 'escalation' as const, round: 2 }
      expect(shouldWarnPlanRework(w, 'rejected')).toBe(false)
    })

    it('waiter null → false', () => {
      expect(shouldWarnPlanRework(null, 'rejected')).toBe(false)
    })

    it('decision null → false', () => {
      const w = { ...baseWaiter, round: 2 }
      expect(shouldWarnPlanRework(w, null)).toBe(false)
    })

    it('两者都 null → false', () => {
      expect(shouldWarnPlanRework(null, null)).toBe(false)
    })
  })
})
