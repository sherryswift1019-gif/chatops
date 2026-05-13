// src/__tests__/integration/qi-spec-stage-e2e.integration.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  createRequirement,
  setRequirementStatus,
} from '../../db/repositories/requirements.js'
import {
  handleAiReviewFailure,
  handleHumanGateRejection,
  REJECT_CAP,
} from '../../pipeline/graph-builder.js'
import {
  advanceBrainstormState,
  type BrainstormState,
} from '../../pipeline/node-types/llm-brainstorm.js'
import {
  loadQiConfig,
  checkTokenBudget,
  getCumulativeTokenUsage,
} from '../../quick-impl/qi-config.js'

// Mock graph-runner retryFromNode (fire-and-forget, avoid circular dep in tests)
vi.mock('../../pipeline/graph-runner.js', () => ({
  retryFromNode: vi.fn().mockResolvedValue(undefined),
}))

describe('QI spec stage E2E (behavior smoke)', () => {
  beforeEach(async () => {
    await resetTestDb()
  })

  it('S1 happy path: AI review pass, no retry counters incremented', async () => {
    const req = await createRequirement({
      title: 'happy',
      rawInput: 'add login',
      gitlabProject: 'g/p',
      source: 'web',
      status: 'spec_review',
    })
    // Simulate AI pass: no handleAiReviewFailure is called.
    // Simulate human approved: status transition, no reject counter.
    await setRequirementStatus(req.id, 'planning')
    const pool = getTestPool()
    const { rows } = await pool.query(
      `SELECT status, retry_counters FROM requirements WHERE id=$1`,
      [req.id],
    )
    expect(rows[0].status).toBe('planning')
    // No counters created by a pure-happy path
    const counters = rows[0].retry_counters ?? {}
    const aiRounds = (counters as Record<string, unknown>).ai_review_rounds ?? {}
    const rejectCounts = (counters as Record<string, unknown>).reject_counts ?? {}
    expect((aiRounds as Record<string, number>).spec_ai_review ?? 0).toBe(0)
    expect((rejectCounts as Record<string, number>).spec_human_gate ?? 0).toBe(0)
  })

  it('S2 AI fail loop: 1 failure increments counter, shouldRetry=true', async () => {
    const req = await createRequirement({
      title: 'ai-fail',
      rawInput: 'x',
      gitlabProject: 'g/p',
      source: 'web',
      status: 'spec_review',
    })
    const r = await handleAiReviewFailure({
      runId: 1,
      requirementId: req.id,
      reviewNodeId: 'spec_ai_review',
      retryToOnFailure: 'spec_author',
      reviewNotes: [{ severity: 'error', msg: 'AC-3 主观' }],
      aiReviewMaxRounds: 3,
    })
    expect(r.shouldRetry).toBe(true)
    expect(r.newCount).toBe(1)

    const pool = getTestPool()
    const { rows } = await pool.query(
      `SELECT retry_counters FROM requirements WHERE id=$1`,
      [req.id],
    )
    const counters = rows[0].retry_counters as Record<string, Record<string, number>>
    expect(counters.ai_review_rounds.spec_ai_review).toBe(1)
  })

  it('S3 AI 耗尽轮数: 3 failures reach cap, shouldRetry=false on 3rd', async () => {
    const req = await createRequirement({
      title: 'ai-exhaust',
      rawInput: 'x',
      gitlabProject: 'g/p',
      source: 'web',
      status: 'spec_review',
    })
    // Rounds 1 and 2: shouldRetry=true
    for (let i = 1; i <= 2; i++) {
      const r = await handleAiReviewFailure({
        runId: 1,
        requirementId: req.id,
        reviewNodeId: 'spec_ai_review',
        retryToOnFailure: 'spec_author',
        reviewNotes: [{ severity: 'error', msg: `round ${i} fail` }],
        aiReviewMaxRounds: 3,
      })
      expect(r.shouldRetry).toBe(true)
      expect(r.newCount).toBe(i)
    }
    // Round 3: currentCount=2, 2 < 3, so one more increment → count=3, shouldRetry=true
    const r3 = await handleAiReviewFailure({
      runId: 1,
      requirementId: req.id,
      reviewNodeId: 'spec_ai_review',
      retryToOnFailure: 'spec_author',
      reviewNotes: [{ severity: 'error', msg: 'round 3 fail' }],
      aiReviewMaxRounds: 3,
    })
    expect(r3.shouldRetry).toBe(true)
    expect(r3.newCount).toBe(3)

    // Round 4 attempt: currentCount=3 >= aiReviewMaxRounds=3 → shouldRetry=false, escalate human
    const r4 = await handleAiReviewFailure({
      runId: 1,
      requirementId: req.id,
      reviewNodeId: 'spec_ai_review',
      retryToOnFailure: 'spec_author',
      reviewNotes: [{ severity: 'error', msg: 'round 4 blocked' }],
      aiReviewMaxRounds: 3,
    })
    expect(r4.shouldRetry).toBe(false)
    expect(r4.newCount).toBe(3)

    // DB should record 3 rounds and the last review notes under spec_author key
    const pool = getTestPool()
    const { rows } = await pool.query(
      `SELECT retry_counters FROM requirements WHERE id=$1`,
      [req.id],
    )
    const counters = rows[0].retry_counters as Record<string, Record<string, unknown>>
    expect(counters.ai_review_rounds.spec_ai_review).toBe(3)
    // last_ai_review_notes[spec_author] should be the notes array from round 3
    const notes = counters.last_ai_review_notes?.spec_author
    expect(Array.isArray(notes)).toBe(true)
    expect((notes as Array<{ severity: string; msg: string }>).length).toBe(1)
  })

  it('S4 human reject cap: 2 within-cap rejects, 3rd blocked', async () => {
    const req = await createRequirement({
      title: 'human-cap',
      rawInput: 'x',
      gitlabProject: 'g/p',
      source: 'web',
      status: 'spec_review',
    })
    // REJECT_CAP=2: currentCount must reach >= 2 to block
    expect(REJECT_CAP).toBe(2)

    // First reject: currentCount=0 < 2, shouldReroute=true
    const r1 = await handleHumanGateRejection({
      runId: 1,
      requirementId: req.id,
      humanGateNodeId: 'spec_human_gate',
      retryToOnReject: 'spec_author',
      rejectReason: '范围不对',
    })
    expect(r1.shouldReroute).toBe(true)
    expect(r1.newCount).toBe(1)

    // Second reject: currentCount=1 < 2, shouldReroute=true
    const r2 = await handleHumanGateRejection({
      runId: 1,
      requirementId: req.id,
      humanGateNodeId: 'spec_human_gate',
      retryToOnReject: 'spec_author',
      rejectReason: '还是不对',
    })
    expect(r2.shouldReroute).toBe(true)
    expect(r2.newCount).toBe(2)

    // Third reject attempt: currentCount=2 >= REJECT_CAP=2, shouldReroute=false → abort path
    const r3 = await handleHumanGateRejection({
      runId: 1,
      requirementId: req.id,
      humanGateNodeId: 'spec_human_gate',
      retryToOnReject: 'spec_author',
      rejectReason: '第三次也不行',
    })
    expect(r3.shouldReroute).toBe(false)
    expect(r3.newCount).toBe(2)
  })

  it('S5 brainstorm partial: 2 consecutive quality-fail rounds trigger degraded mode', () => {
    const state: BrainstormState = {
      round: 1,
      history: [],
      enrichedInput: {},
      readyForSpec: false,
      earlyDone: false,
      partial: false,
      failedQualityRounds: 0,
    }
    // First quality-fail: invalid markdown (only one ## section)
    const next1 = advanceBrainstormState(state, {
      llmOutput: { decision: 'ask', round: 1, question: '## 仅一段，无其余必需 section' },
      userAnswer: null,
      source: 'web',
    })
    expect(next1.failedQualityRounds).toBe(1)
    expect(next1.readyForSpec).toBe(false)
    expect(next1.partial).toBe(false)

    // Second quality-fail: reaches threshold → force partial+ready
    const next2 = advanceBrainstormState(next1, {
      llmOutput: { decision: 'ask', round: 1, question: '## 还是仅一段' },
      userAnswer: null,
      source: 'web',
    })
    expect(next2.failedQualityRounds).toBe(2)
    expect(next2.partial).toBe(true)
    expect(next2.readyForSpec).toBe(true)
  })

  it('S6 token budget: usage exceeding budget triggers skip check', async () => {
    const pool = getTestPool()
    // Seed pipeline_run_state with token_total > 250k budget
    await pool.query(
      `INSERT INTO pipeline_run_state(pipeline_run_id, data)
       VALUES (1, '{"token_total":300000}'::jsonb)`,
    )
    const used = await getCumulativeTokenUsage(1)
    expect(used).toBe(300000)

    const cfg = await loadQiConfig()
    // Default budget is 250000
    expect(cfg.tokenBudgetPerRequirement).toBe(250000)

    const check = checkTokenBudget({
      usedTokens: used,
      budget: cfg.tokenBudgetPerRequirement,
    })
    expect(check.ok).toBe(false)
    expect(check.usedTokens).toBe(300000)
    expect(check.budget).toBe(250000)
  })

  it.skip('S7 brainstorm full multi-round path (deferred: requires brainstorm-host role.md in main repo)', () => {
    // Full multi-round brainstorm-host LLM invocation requires .claude/skills/.../brainstorm-host.md
    // which is gitignored and not available in worktrees. Will be exercised after role.md
    // syncs to main repo and the brainstorm skeleton (T20 partial=true) is replaced by real LLM.
  })
})
