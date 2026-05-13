import { getPool } from '../client.js'

/**
 * brainstorm_waiters — multi-round LLM brainstorm 持久化（spec_brainstorm 节点用）。
 *
 * 每轮一行 waiter，存：5-section question + parsed options + BrainstormState 快照（enriched_input + history + failedQualityRounds）+ 用户答复。
 * UNIQUE (pipeline_run_id, node_id, round) 保证 replay 安全。
 *
 * Schema: src/db/schema-v1016.sql
 */

export type BrainstormWaiterStatus = 'pending' | 'answered' | 'expired'
export type BrainstormSource = 'web' | 'im'

export interface BrainstormOption {
  id: string
  label: string
}

export interface BrainstormHistoryTurn {
  round: number
  question: string
  answer: string
  source: BrainstormSource
  answeredAt: string
}

export interface BrainstormWaiter {
  id: number
  requirementId: number
  pipelineRunId: number
  threadId: string
  nodeId: string
  round: number
  questionMd: string
  options: BrainstormOption[]
  enrichedInput: Record<string, unknown>
  history: BrainstormHistoryTurn[]
  failedQualityRounds: number
  readyForSpec: boolean
  status: BrainstormWaiterStatus
  source: BrainstormSource | null
  chosenOption: string | null
  freeText: string | null
  answeredAt: Date | null
  expiresAt: Date
  createdAt: Date
}

export interface CreateBrainstormWaiterInput {
  requirementId: number
  pipelineRunId: number
  threadId: string
  nodeId: string
  round: number
  questionMd: string
  options: BrainstormOption[]
  enrichedInput: Record<string, unknown>
  history: BrainstormHistoryTurn[]
  failedQualityRounds: number
  readyForSpec: boolean
  expiresAt: string
}

export interface AnswerBrainstormInput {
  source: BrainstormSource
  chosenOption?: string | null
  freeText?: string | null
}

function mapRow(r: Record<string, unknown>): BrainstormWaiter {
  return {
    id: r.id as number,
    requirementId: r.requirement_id as number,
    pipelineRunId: r.pipeline_run_id as number,
    threadId: r.thread_id as string,
    nodeId: r.node_id as string,
    round: r.round as number,
    questionMd: r.question_md as string,
    options: (r.options as BrainstormOption[]) ?? [],
    enrichedInput: (r.enriched_input as Record<string, unknown>) ?? {},
    history: (r.history as BrainstormHistoryTurn[]) ?? [],
    failedQualityRounds: r.failed_quality_rounds as number,
    readyForSpec: r.ready_for_spec as boolean,
    status: r.status as BrainstormWaiterStatus,
    source: (r.source as BrainstormSource | null) ?? null,
    chosenOption: (r.chosen_option as string | null) ?? null,
    freeText: (r.free_text as string | null) ?? null,
    answeredAt: r.answered_at ? new Date(r.answered_at as string) : null,
    expiresAt: new Date(r.expires_at as string),
    createdAt: new Date(r.created_at as string),
  }
}

export async function createBrainstormWaiter(
  input: CreateBrainstormWaiterInput,
): Promise<BrainstormWaiter> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO brainstorm_waiters
       (requirement_id, pipeline_run_id, thread_id, node_id, round,
        question_md, options, enriched_input, history,
        failed_quality_rounds, ready_for_spec, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, 'pending', $12)
     RETURNING *`,
    [
      input.requirementId,
      input.pipelineRunId,
      input.threadId,
      input.nodeId,
      input.round,
      input.questionMd,
      JSON.stringify(input.options),
      JSON.stringify(input.enrichedInput),
      JSON.stringify(input.history),
      input.failedQualityRounds,
      input.readyForSpec,
      input.expiresAt,
    ],
  )
  return mapRow(rows[0])
}

export async function getBrainstormWaiterById(id: number): Promise<BrainstormWaiter | null> {
  const pool = getPool()
  const { rows } = await pool.query(`SELECT * FROM brainstorm_waiters WHERE id = $1`, [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getBrainstormWaiterByRound(
  pipelineRunId: number,
  nodeId: string,
  round: number,
): Promise<BrainstormWaiter | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM brainstorm_waiters
     WHERE pipeline_run_id = $1 AND node_id = $2 AND round = $3`,
    [pipelineRunId, nodeId, round],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listBrainstormWaitersForRun(
  pipelineRunId: number,
  nodeId: string,
): Promise<BrainstormWaiter[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM brainstorm_waiters
     WHERE pipeline_run_id = $1 AND node_id = $2
     ORDER BY round ASC`,
    [pipelineRunId, nodeId],
  )
  return rows.map(mapRow)
}

export async function listBrainstormWaitersForRequirement(
  requirementId: number,
): Promise<BrainstormWaiter[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM brainstorm_waiters
     WHERE requirement_id = $1
     ORDER BY round ASC, created_at ASC`,
    [requirementId],
  )
  return rows.map(mapRow)
}

export async function getActiveBrainstormWaiterForRequirement(
  requirementId: number,
): Promise<BrainstormWaiter | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM brainstorm_waiters
     WHERE requirement_id = $1 AND status = 'pending'
     ORDER BY round DESC
     LIMIT 1`,
    [requirementId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/**
 * 防并发竞态：UPDATE...WHERE status='pending' RETURNING *。
 * 第二个并发请求 RETURNING 0 行 → 返 null → 上层报 409 already_answered。
 * requirement_id 在 WHERE 中防 IDOR。
 */
export async function answerBrainstormWaiter(
  waiterId: number,
  requirementId: number,
  input: AnswerBrainstormInput,
): Promise<BrainstormWaiter | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE brainstorm_waiters
     SET status = 'answered',
         source = $3,
         chosen_option = $4,
         free_text = $5,
         answered_at = now()
     WHERE id = $1
       AND requirement_id = $2
       AND status = 'pending'
     RETURNING *`,
    [
      waiterId,
      requirementId,
      input.source,
      input.chosenOption ?? null,
      input.freeText ?? null,
    ],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/**
 * 24h 超时 reaper：把 expired 的 pending waiter 标 expired。
 * 仅返回真正被本次调用更新的行（用于触发 markRequirementAborted）。
 */
export async function markBrainstormExpired(id: number): Promise<BrainstormWaiter | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE brainstorm_waiters
     SET status = 'expired'
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/**
 * 进程启动时调用：扫所有 expires_at < now() 且 status='pending' 的 waiter，批量 expire。
 * 返回被 expired 的 waiter 列表，供 caller 对每个 requirement 调 markRequirementAborted。
 */
export async function reapExpiredBrainstormWaiters(): Promise<BrainstormWaiter[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE brainstorm_waiters
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < now()
     RETURNING *`,
  )
  return rows.map(mapRow)
}

export async function deleteBrainstormWaitersForRequirement(
  requirementId: number,
): Promise<number> {
  const pool = getPool()
  const { rowCount } = await pool.query(
    `DELETE FROM brainstorm_waiters WHERE requirement_id = $1`,
    [requirementId],
  )
  return rowCount ?? 0
}
