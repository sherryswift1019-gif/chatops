/**
 * Integration: plan_escalation 字段级反馈持久化（PRD §7 step 6 验证）
 *
 * 验证：
 *   1. schema-v63 已应用，requirement_approval_waiters 含 target_task_id / cited_ai_notes 列
 *   2. claimWaiter 把 ClaimDecisionInput 的 targetTaskId / citedAiNotes 写入 DB
 *   3. mapRow 从 DB 读出 → RequirementApprovalWaiter.targetTaskId / citedAiNotes 正确
 *   4. plan_escalation decisionSet 的 waiter 可创建且 claim 含字段级反馈
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { getPool } from '../../db/client.js'
import { createRequirement } from '../../db/repositories/requirements.js'
import {
  createWaiter,
  claimWaiter,
  getWaiterById,
} from '../../db/repositories/requirement-approval-waiters.js'

describe('plan-escalation feedback (PRD §7 step 6)', () => {
  beforeAll(async () => {
    const pool = getPool()
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'requirement_approval_waiters'
          AND column_name IN ('target_task_id', 'cited_ai_notes')`,
    )
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
      'cited_ai_notes',
      'target_task_id',
    ])
  })

  afterEach(async () => {
    const pool = getPool()
    await pool.query(`DELETE FROM requirement_approval_waiters`)
    await pool.query(`DELETE FROM requirements`)
  })

  async function setupRequirement(): Promise<number> {
    const r = await createRequirement({
      title: 'plan_escalation 测试',
      rawInput: 'test',
      gitlabProject: 'g/r',
    })
    return r.id
  }

  it('plan_escalation waiter 持久化字段级反馈（rejected_plan + targetTaskId + citedAiNotes）', async () => {
    const reqId = await setupRequirement()
    const waiter = await createWaiter({
      requirementId: reqId,
      pipelineRunId: 1,
      nodeId: 'plan_human_escalation',
      approvalKind: 'plan',
      round: 1,
      decisionSet: 'plan_escalation',
      contextSummary: 'plan body',
    })
    expect(waiter.targetTaskId).toBeNull()
    expect(waiter.citedAiNotes).toBeNull()

    const result = await claimWaiter(waiter.id, 'web', {
      decision: 'rejected_plan',
      rejectReason: 'T2 doneWhen 太空泛',
      targetTaskId: 'T2',
      citedAiNotes: ['T2 doneWhen[1] 含空洞断言', 'T2.coverAC 缺 AC-3'],
      decidedBy: 'reviewer-a',
    })
    expect(result.claimed).toBe(true)
    expect(result.waiter?.decision).toBe('rejected_plan')
    expect(result.waiter?.targetTaskId).toBe('T2')
    expect(result.waiter?.citedAiNotes).toEqual([
      'T2 doneWhen[1] 含空洞断言',
      'T2.coverAC 缺 AC-3',
    ])

    // 二次读：mapRow 从 DB 真读出 JSONB 数组
    const reread = await getWaiterById(waiter.id)
    expect(reread?.decision).toBe('rejected_plan')
    expect(reread?.targetTaskId).toBe('T2')
    expect(reread?.citedAiNotes).toEqual([
      'T2 doneWhen[1] 含空洞断言',
      'T2.coverAC 缺 AC-3',
    ])
  })

  it('approved 决策不带字段级反馈：targetTaskId / citedAiNotes 留 null', async () => {
    const reqId = await setupRequirement()
    const waiter = await createWaiter({
      requirementId: reqId,
      pipelineRunId: 1,
      nodeId: 'plan_human_escalation',
      approvalKind: 'plan',
      round: 1,
      decisionSet: 'plan_escalation',
      contextSummary: 'plan body',
    })

    const result = await claimWaiter(waiter.id, 'web', {
      decision: 'approved',
      decidedBy: 'reviewer-a',
    })
    expect(result.claimed).toBe(true)
    expect(result.waiter?.targetTaskId).toBeNull()
    expect(result.waiter?.citedAiNotes).toBeNull()
  })

  it('rejected_spec 决策（spec 锅，暂等于 abort）：保留人 reason，不带字段级反馈', async () => {
    const reqId = await setupRequirement()
    const waiter = await createWaiter({
      requirementId: reqId,
      pipelineRunId: 1,
      nodeId: 'plan_human_escalation',
      approvalKind: 'plan',
      round: 1,
      decisionSet: 'plan_escalation',
      contextSummary: 'plan body',
    })

    const result = await claimWaiter(waiter.id, 'web', {
      decision: 'rejected_spec',
      rejectReason: 'spec §3 与 §9 矛盾',
      decidedBy: 'reviewer-a',
    })
    expect(result.claimed).toBe(true)
    expect(result.waiter?.decision).toBe('rejected_spec')
    expect(result.waiter?.rejectReason).toBe('spec §3 与 §9 矛盾')
    expect(result.waiter?.targetTaskId).toBeNull()
    expect(result.waiter?.citedAiNotes).toBeNull()
  })
})
