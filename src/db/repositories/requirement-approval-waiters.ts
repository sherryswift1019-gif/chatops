import { getPool } from '../client.js'

/**
 * Quick-Impl 双端审批等待表。
 * 用于 skill_with_approval 节点内部循环：每一轮 INSERT 一新行；旧行作历史保留。
 *
 * Race-claim 机制：IM / Web 两端任一先到，UPDATE 影响行数 1 = claim 成功，0 = 已被另一端 claim。
 *
 * Schema: src/db/schema-v60.sql
 * 设计：docs/prds/prd-quick-impl.md §4.2 / §6.2 / §7（IM 卡片与 Web 面板）
 */

export type ApprovalKind = 'spec' | 'plan' | 'final' | 'escalation'
export type DecisionSet = 'binary' | 'escalation' | 'qi_e2e_intervention' | 'qi_sandbox_failed' | 'plan_escalation' | 'human_gate'
export type ClaimSource = 'im' | 'web' | 'retry' | 'abort'
export type ApprovalDecision =
  | 'approved'
  | 'rejected'
  | 'rejected_plan'
  | 'rejected_spec'
  | 'force_passed'
  | 'budget_extended'
  | 'aborted'
  | 'fix'

export interface RequirementApprovalWaiter {
  id: number
  requirementId: number
  pipelineRunId: number
  nodeId: string
  approvalKind: ApprovalKind
  round: number
  decisionSet: DecisionSet
  imPlatform: string | null
  imGroupId: string | null
  contextSummary: string | null
  claimedBy: ClaimSource | null
  claimedAt: Date | null
  decision: ApprovalDecision | null
  rejectReason: string | null
  budgetDelta: number | null
  decidedBy: string | null
  /** PRD §7 step 6：人审反馈定位的 task id（'T1'/'T2'/null=全局问题）。仅 plan_escalation 使用。 */
  targetTaskId: string | null
  /** PRD §7 step 6：人审从 AI reviewer notes 中勾选的 msg 子集。仅 plan_escalation 使用。 */
  citedAiNotes: string[] | null
  createdAt: Date
}

export interface CreateWaiterInput {
  requirementId: number
  pipelineRunId: number
  nodeId: string
  approvalKind: ApprovalKind
  round: number
  decisionSet: DecisionSet
  imPlatform?: string | null
  imGroupId?: string | null
  contextSummary?: string | null
}

export interface ClaimResult {
  claimed: boolean
  by?: ClaimSource
  waiter?: RequirementApprovalWaiter
}

function mapRow(r: Record<string, unknown>): RequirementApprovalWaiter {
  return {
    id: r.id as number,
    requirementId: r.requirement_id as number,
    pipelineRunId: r.pipeline_run_id as number,
    nodeId: r.node_id as string,
    approvalKind: r.approval_kind as ApprovalKind,
    round: r.round as number,
    decisionSet: r.decision_set as DecisionSet,
    imPlatform: (r.im_platform as string | null) ?? null,
    imGroupId: (r.im_group_id as string | null) ?? null,
    contextSummary: (r.context_summary as string | null) ?? null,
    claimedBy: (r.claimed_by as ClaimSource | null) ?? null,
    claimedAt: (r.claimed_at as Date | null) ?? null,
    decision: (r.decision as ApprovalDecision | null) ?? null,
    rejectReason: (r.reject_reason as string | null) ?? null,
    budgetDelta: (r.budget_delta as number | null) ?? null,
    decidedBy: (r.decided_by as string | null) ?? null,
    targetTaskId: (r.target_task_id as string | null) ?? null,
    citedAiNotes: (r.cited_ai_notes as string[] | null) ?? null,
    createdAt: r.created_at as Date,
  }
}

/**
 * 创建一个新 waiter。同一 (requirement_id, node_id) 已有未 claim 的 waiter
 * 时会因 UNIQUE INDEX 抛错——调用方应保证只在前一轮已结算后再开新轮。
 */
export async function createWaiter(
  input: CreateWaiterInput,
): Promise<RequirementApprovalWaiter> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO requirement_approval_waiters
       (requirement_id, pipeline_run_id, node_id, approval_kind,
        round, decision_set, im_platform, im_group_id, context_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.requirementId,
      input.pipelineRunId,
      input.nodeId,
      input.approvalKind,
      input.round,
      input.decisionSet,
      input.imPlatform ?? null,
      input.imGroupId ?? null,
      input.contextSummary ?? null,
    ],
  )
  return mapRow(rows[0])
}

export async function getWaiterById(id: number): Promise<RequirementApprovalWaiter | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM requirement_approval_waiters WHERE id = $1`,
    [id],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/**
 * 当前未 claim 的 waiter（最多一个，由 UNIQUE INDEX 保证）。
 */
export async function getActiveWaiter(
  requirementId: number,
  nodeId: string,
): Promise<RequirementApprovalWaiter | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM requirement_approval_waiters
      WHERE requirement_id = $1 AND node_id = $2 AND claimed_by IS NULL`,
    [requirementId, nodeId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/**
 * 历史 waiter（按时间正序），用于详情页 timeline。
 */
export async function listWaitersByRequirement(
  requirementId: number,
): Promise<RequirementApprovalWaiter[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM requirement_approval_waiters
      WHERE requirement_id = $1
      ORDER BY created_at ASC, id ASC`,
    [requirementId],
  )
  return rows.map(mapRow)
}

export interface ClaimDecisionInput {
  decision: ApprovalDecision
  rejectReason?: string | null
  budgetDelta?: number | null
  decidedBy?: string | null
  /** PRD §7 step 6：定位反馈到具体 task（仅 plan_escalation rejected_plan 时填）。 */
  targetTaskId?: string | null
  /** PRD §7 step 6：人审勾选的 AI notes msg 子集（仅 plan_escalation rejected_plan 时填）。 */
  citedAiNotes?: string[] | null
}

/**
 * Race-winner claim：仅当 waiter 还未被 claim 时才写入决策；否则返回幂等失败。
 *
 * 返回 claimed=true 时附带 waiter；claimed=false 时附带 by 表示被谁先 claim 了。
 */
export async function claimWaiter(
  waiterId: number,
  source: ClaimSource,
  decision: ClaimDecisionInput,
): Promise<ClaimResult> {
  const pool = getPool()

  const update = await pool.query(
    `UPDATE requirement_approval_waiters
        SET claimed_by = $2,
            claimed_at = NOW(),
            decision = $3,
            reject_reason = $4,
            budget_delta = $5,
            decided_by = $6,
            target_task_id = $7,
            cited_ai_notes = $8
      WHERE id = $1 AND claimed_by IS NULL
      RETURNING *`,
    [
      waiterId,
      source,
      decision.decision,
      decision.rejectReason ?? null,
      decision.budgetDelta ?? null,
      decision.decidedBy ?? null,
      decision.targetTaskId ?? null,
      decision.citedAiNotes ? JSON.stringify(decision.citedAiNotes) : null,
    ],
  )

  if (update.rowCount === 1) {
    return { claimed: true, waiter: mapRow(update.rows[0]) }
  }

  // 没 claim 到：读一下当前状态告诉调用方谁先到了
  const { rows } = await pool.query(
    `SELECT claimed_by FROM requirement_approval_waiters WHERE id = $1`,
    [waiterId],
  )
  const by = (rows[0]?.claimed_by as ClaimSource | null) ?? undefined
  return { claimed: false, by }
}

/**
 * 按 requirement_id + pipeline_run_id + node_id + round 查单行。
 * skill_with_approval 节点用此判断同一次 run 中某轮是否已创建 waiter（决定是否跳过生成器）。
 * 必须按 pipeline_run_id 过滤，防止历史 run 的 waiter 干扰重放判断。
 * 包含所有 approval_kind（含 escalation），确保重放时不会重复创建 waiter。
 */
export async function getWaiterByNodeAndRound(
  requirementId: number,
  nodeId: string,
  round: number,
  pipelineRunId?: number,
): Promise<RequirementApprovalWaiter | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM requirement_approval_waiters
      WHERE requirement_id = $1
        AND node_id = $2
        AND round = $3
        ${pipelineRunId !== undefined ? 'AND pipeline_run_id = $4' : ''}
      ORDER BY id ASC
      LIMIT 1`,
    pipelineRunId !== undefined
      ? [requirementId, nodeId, round, pipelineRunId]
      : [requirementId, nodeId, round],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/**
 * 强制把所有未 claim 的 waiter 置为 claimed_by=source（abort/retry 用）。
 * 解 UNIQUE INDEX 让后续新 round 不会冲突。
 */
export async function forceClaimAllPending(
  requirementId: number,
  source: ClaimSource,
  decision: ApprovalDecision = 'aborted',
): Promise<number> {
  const pool = getPool()
  const { rowCount } = await pool.query(
    `UPDATE requirement_approval_waiters
        SET claimed_by = $2,
            claimed_at = NOW(),
            decision = $3
      WHERE requirement_id = $1 AND claimed_by IS NULL`,
    [requirementId, source, decision],
  )
  return rowCount ?? 0
}
