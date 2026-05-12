import { getPool } from '../client.js'

/**
 * Quick-Impl 需求索引表（git 分支为主存，本表只索引）
 * Schema: src/db/schema-v60.sql
 * 设计：docs/prds/prd-quick-impl.md §4.1 / §3.3
 */

export type RequirementStatus =
  | 'draft'
  | 'queued'
  | 'spec_review'
  | 'planning'
  | 'developing'
  | 'reviewing'
  | 'testing'
  | 'mr_pending'
  | 'mr_open'
  | 'merged'
  | 'aborting'
  | 'aborted'
  | 'failed'

export type RequirementSource = 'web' | 'im' | 'api'

export interface Requirement {
  id: number
  title: string
  rawInput: string
  status: RequirementStatus
  branch: string | null
  baseBranch: string
  gitlabProject: string
  worktreePath: string | null
  pipelineRunId: number | null
  currentStage: string | null
  specPath: string | null
  planPath: string | null
  specContent: string | null
  planContent: string | null
  mrUrl: string | null
  abortReason: string | null
  retryCounters: Record<string, unknown>
  source: RequirementSource
  createdBy: string | null
  skipE2E: boolean
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

export interface CreateRequirementInput {
  title: string
  rawInput: string
  gitlabProject: string
  baseBranch?: string
  source?: RequirementSource
  createdBy?: string
  status?: RequirementStatus
  skipE2E?: boolean
}

const TERMINAL_STATUSES: ReadonlySet<RequirementStatus> = new Set([
  'merged',
  'aborted',
  'failed',
])

function mapRow(r: Record<string, unknown>): Requirement {
  return {
    id: r.id as number,
    title: r.title as string,
    rawInput: r.raw_input as string,
    status: r.status as RequirementStatus,
    branch: (r.branch as string | null) ?? null,
    baseBranch: r.base_branch as string,
    gitlabProject: r.gitlab_project as string,
    worktreePath: (r.worktree_path as string | null) ?? null,
    pipelineRunId: (r.pipeline_run_id as number | null) ?? null,
    currentStage: (r.current_stage as string | null) ?? null,
    specPath: (r.spec_path as string | null) ?? null,
    planPath: (r.plan_path as string | null) ?? null,
    specContent: (r.spec_content as string | null) ?? null,
    planContent: (r.plan_content as string | null) ?? null,
    mrUrl: (r.mr_url as string | null) ?? null,
    abortReason: (r.abort_reason as string | null) ?? null,
    retryCounters: (r.retry_counters as Record<string, unknown>) ?? {},
    source: r.source as RequirementSource,
    createdBy: (r.created_by as string | null) ?? null,
    skipE2E: (r.skip_e2e as boolean | null) ?? false,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    completedAt: (r.completed_at as Date | null) ?? null,
  }
}

export async function createRequirement(
  input: CreateRequirementInput,
): Promise<Requirement> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO requirements
       (title, raw_input, gitlab_project, base_branch, source, created_by, status, skip_e2e)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.title,
      input.rawInput,
      input.gitlabProject,
      input.baseBranch ?? 'main',
      input.source ?? 'web',
      input.createdBy ?? null,
      input.status ?? 'draft',
      input.skipE2E ?? false,
    ],
  )
  return mapRow(rows[0])
}

export async function updateRequirement(
  id: number,
  input: Partial<{ title: string; rawInput: string; gitlabProject: string; baseBranch: string; skipE2E: boolean }>,
): Promise<Requirement | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE requirements
     SET title          = COALESCE($2, title),
         raw_input      = COALESCE($3, raw_input),
         gitlab_project = COALESCE($4, gitlab_project),
         base_branch    = COALESCE($5, base_branch),
         skip_e2e       = COALESCE($6, skip_e2e),
         updated_at     = NOW()
     WHERE id = $1 AND status = 'draft'
     RETURNING *`,
    [id, input.title ?? null, input.rawInput ?? null, input.gitlabProject ?? null, input.baseBranch ?? null, input.skipE2E ?? null],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteRequirement(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query(
    `DELETE FROM requirements WHERE id = $1 AND status IN ('draft', 'queued')`,
    [id],
  )
  return (rowCount ?? 0) > 0
}

export async function getRequirementById(id: number): Promise<Requirement | null> {
  const pool = getPool()
  const { rows } = await pool.query(`SELECT * FROM requirements WHERE id = $1`, [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export interface ListRequirementsOptions {
  status?: RequirementStatus | RequirementStatus[]
  page?: number
  size?: number
}

export interface ListRequirementsResult {
  items: Requirement[]
  total: number
}

export async function listRequirements(
  opts: ListRequirementsOptions = {},
): Promise<ListRequirementsResult> {
  const pool = getPool()
  const where: string[] = []
  const args: unknown[] = []

  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status]
    if (statuses.length > 0) {
      args.push(statuses)
      where.push(`status = ANY($${args.length}::TEXT[])`)
    }
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const size = Math.min(Math.max(opts.size ?? 20, 1), 200)
  const page = Math.max(opts.page ?? 1, 1)
  const offset = (page - 1) * size

  const countResult = await pool.query(
    `SELECT COUNT(*)::INT AS n FROM requirements ${whereSql}`,
    args,
  )
  const total = countResult.rows[0]?.n ?? 0

  args.push(size)
  args.push(offset)
  const itemsResult = await pool.query(
    `SELECT * FROM requirements ${whereSql}
       ORDER BY id DESC
       LIMIT $${args.length - 1} OFFSET $${args.length}`,
    args,
  )

  return { items: itemsResult.rows.map(mapRow), total }
}

/**
 * 状态机推进（PRD §3.3）。终态（merged/aborted/failed）不被覆盖：
 * 防止 abort 流程中节点继续推进时把 'aborted' 改回 'developing' 之类。
 */
export async function setRequirementStatus(
  id: number,
  newStatus: RequirementStatus,
  currentStage?: string | null,
): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query(
    `UPDATE requirements
        SET status = $2,
            current_stage = COALESCE($3, current_stage),
            updated_at = NOW(),
            completed_at = CASE
              WHEN $2 IN ('merged','aborted','failed') THEN NOW()
              ELSE completed_at
            END
      WHERE id = $1
        AND status NOT IN ('merged','aborted','failed')`,
    [id, newStatus, currentStage ?? null],
  )
  return (rowCount ?? 0) > 0
}

/**
 * 强制写状态（用于 abort 流程：'aborting' → 'aborted' 的最终落库）。
 * 谨慎使用：不受终态保护。
 */
export async function forceSetRequirementStatus(
  id: number,
  newStatus: RequirementStatus,
  abortReason?: string,
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE requirements
        SET status = $2,
            abort_reason = COALESCE($3, abort_reason),
            updated_at = NOW(),
            completed_at = CASE
              WHEN $2 IN ('merged','aborted','failed') THEN NOW()
              ELSE completed_at
            END
      WHERE id = $1`,
    [id, newStatus, abortReason ?? null],
  )
}

export async function setBranchAndWorktree(
  id: number,
  branch: string,
  worktreePath: string,
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE requirements
        SET branch = $2, worktree_path = $3, updated_at = NOW()
      WHERE id = $1`,
    [id, branch, worktreePath],
  )
}

export async function setPipelineRunId(id: number, pipelineRunId: number): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE requirements
        SET pipeline_run_id = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, pipelineRunId],
  )
}

export async function setMrUrl(id: number, mrUrl: string): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE requirements
        SET mr_url = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, mrUrl],
  )
}

export async function setSpecPlanContent(
  id: number,
  specContent: string | null,
  planContent: string | null,
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE requirements
        SET spec_content = COALESCE($2, spec_content),
            plan_content = COALESCE($3, plan_content),
            updated_at = NOW()
      WHERE id = $1`,
    [id, specContent, planContent],
  )
}

/**
 * 原子更新 retry_counters 中某个键的值（dev_completed_tasks 等）。
 * 用 jsonb_set 避免读改写竞态。
 */
export async function setRetryCounter(
  id: number,
  key: string,
  value: unknown,
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE requirements
        SET retry_counters = jsonb_set(
              COALESCE(retry_counters, '{}'::jsonb),
              ARRAY[$2],
              $3::jsonb,
              TRUE
            ),
            updated_at = NOW()
      WHERE id = $1`,
    [id, key, JSON.stringify(value)],
  )
}

/**
 * 把数组追加到 retry_counters[key]（用于 dev_completed_tasks dense 累加）。
 * dev-loop skill 报告 task_index 时调用：handler 把单个 index push 到数组。
 */
export async function appendRetryCounterArray(
  id: number,
  key: string,
  value: number,
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE requirements
        SET retry_counters = jsonb_set(
              COALESCE(retry_counters, '{}'::jsonb),
              ARRAY[$2],
              COALESCE(retry_counters->$2, '[]'::jsonb) || to_jsonb($3::int),
              TRUE
            ),
            updated_at = NOW()
      WHERE id = $1`,
    [id, key, value],
  )
}

/**
 * 当前活跃需求数量（用于 concurrency 检查）。
 * 活跃 = status NOT IN 终态 / queued。
 */
export async function countActiveRequirements(): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT COUNT(*)::INT AS n FROM requirements
      WHERE status NOT IN ('draft','queued','merged','aborted','failed')`,
  )
  return rows[0]?.n ?? 0
}

export function isTerminalStatus(status: RequirementStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export async function forceDeleteRequirement(id: number): Promise<void> {
  const pool = getPool()
  await pool.query(`DELETE FROM requirements WHERE id = $1`, [id])
}

/** 单节点最大 retry 次数上限（防无限 retry 失败节点）。 */
export const NODE_RETRY_CAP = 3

/**
 * 原子递增 retry_counters.node_retry_counts[nodeId]。
 * 路径不存在时从 1 开始，避免读改写竞态。
 *
 * jsonb_set create_missing 仅创建末层键，不递归创建中间节点，
 * 所以先用内层 jsonb_set 确保 node_retry_counts 对象存在，
 * 外层再设置 nodeId。
 */
export async function incrementNodeRetryCount(
  requirementId: number,
  nodeId: string,
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE requirements
     SET retry_counters = jsonb_set(
       jsonb_set(
         COALESCE(retry_counters, '{}'::jsonb),
         '{node_retry_counts}'::text[],
         COALESCE(COALESCE(retry_counters, '{}'::jsonb) -> 'node_retry_counts', '{}'::jsonb),
         true
       ),
       ARRAY['node_retry_counts'::text, $2::text]::text[],
       COALESCE(
         (COALESCE(retry_counters, '{}'::jsonb) #> ARRAY['node_retry_counts'::text, $2::text]::text[])::int + 1,
         1
       )::text::jsonb,
       true
     ),
     updated_at = NOW()
     WHERE id = $1`,
    [requirementId, nodeId],
  )
}

/**
 * 读取 retry_counters.node_retry_counts[nodeId]，不存在时返回 0。
 */
export async function getNodeRetryCount(
  requirementId: number,
  nodeId: string,
): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query<{ count: number | null }>(
    `SELECT (COALESCE(retry_counters, '{}'::jsonb) #> ARRAY['node_retry_counts'::text, $2::text]::text[])::int AS count
     FROM requirements WHERE id = $1`,
    [requirementId, nodeId],
  )
  return rows[0]?.count ?? 0
}

/**
 * 通过 pipeline_run_id 反查需求记录（用于 retry cap check）。
 */
export async function getRequirementByPipelineRunId(
  pipelineRunId: number,
): Promise<Requirement | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM requirements WHERE pipeline_run_id = $1 LIMIT 1`,
    [pipelineRunId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/**
 * 读 retry_counters.reject_counts[humanGateNodeId]，默认 0。
 * 用于 *_human_gate 节点判断 reject 是否达 cap。
 */
export async function getRejectCount(
  requirementId: number,
  humanGateNodeId: string,
): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query<{ count: number | null }>(
    `SELECT (retry_counters->'reject_counts'->>$2)::int AS count
     FROM requirements WHERE id = $1`,
    [requirementId, humanGateNodeId],
  )
  return rows[0]?.count ?? 0
}

/**
 * 原子累加 reject_counts[humanGateNodeId]++ 同时写入 last_reject_reasons[authorNodeId]。
 * 用 jsonb_set 嵌套 4 层单事务保证一致。
 *
 * jsonb_set create_missing 仅创建末层键，所以先各自 ensure 中间对象存在
 * （reject_counts / last_reject_reasons），再写叶子键。同 incrementNodeRetryCount 套路。
 */
export async function incrementRejectCount(args: {
  requirementId: number
  humanGateNodeId: string
  authorNodeId: string
  rejectReason: string
}): Promise<{ newCount: number }> {
  const { requirementId, humanGateNodeId, authorNodeId, rejectReason } = args
  const pool = getPool()
  const { rows } = await pool.query<{ count: number }>(
    `UPDATE requirements
     SET retry_counters = jsonb_set(
       jsonb_set(
         jsonb_set(
           jsonb_set(
             COALESCE(retry_counters, '{}'::jsonb),
             '{reject_counts}'::text[],
             COALESCE(COALESCE(retry_counters, '{}'::jsonb) -> 'reject_counts', '{}'::jsonb),
             true
           ),
           '{last_reject_reasons}'::text[],
           COALESCE(COALESCE(retry_counters, '{}'::jsonb) -> 'last_reject_reasons', '{}'::jsonb),
           true
         ),
         ARRAY['reject_counts'::text, $2::text],
         to_jsonb(COALESCE((COALESCE(retry_counters, '{}'::jsonb) #>> ARRAY['reject_counts'::text, $2::text]::text[])::int, 0) + 1),
         true
       ),
       ARRAY['last_reject_reasons'::text, $3::text],
       to_jsonb($4::text),
       true
     ),
     updated_at = NOW()
     WHERE id = $1
     RETURNING (retry_counters #>> ARRAY['reject_counts'::text, $2::text]::text[])::int AS count`,
    [requirementId, humanGateNodeId, authorNodeId, rejectReason],
  )
  return { newCount: rows[0]?.count ?? 0 }
}

/**
 * 读 retry_counters.last_reject_reasons[authorNodeId]，不存在返回 null。
 * 用于 buildLlmAuthorNode 注入 previousRound.rejectReason。
 */
export async function getLastRejectReason(
  requirementId: number,
  authorNodeId: string,
): Promise<string | null> {
  const pool = getPool()
  const { rows } = await pool.query<{ reason: string | null }>(
    `SELECT retry_counters->'last_reject_reasons'->>$2 AS reason
     FROM requirements WHERE id = $1`,
    [requirementId, authorNodeId],
  )
  return rows[0]?.reason ?? null
}

/**
 * 读 retry_counters.ai_review_rounds[reviewNodeId]，默认 0。
 * 用于 *_ai_review 节点判断 AI review 是否达 cap。
 */
export async function getAiReviewRound(
  requirementId: number,
  reviewNodeId: string,
): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query<{ count: number | null }>(
    `SELECT (retry_counters->'ai_review_rounds'->>$2)::int AS count
     FROM requirements WHERE id = $1`,
    [requirementId, reviewNodeId],
  )
  return rows[0]?.count ?? 0
}

/**
 * 原子累加 ai_review_rounds[reviewNodeId]++ 同时写入 last_ai_review_notes[authorNodeId]。
 * 结构与 incrementRejectCount 对称。
 */
export async function incrementAiReviewRound(args: {
  requirementId: number
  reviewNodeId: string
  authorNodeId: string
  reviewNotes: Array<{ severity: string; msg: string; file?: string }>
}): Promise<{ newCount: number }> {
  const { requirementId, reviewNodeId, authorNodeId, reviewNotes } = args
  const pool = getPool()
  const { rows } = await pool.query<{ count: number }>(
    `UPDATE requirements
     SET retry_counters = jsonb_set(
       jsonb_set(
         jsonb_set(
           jsonb_set(
             COALESCE(retry_counters, '{}'::jsonb),
             '{ai_review_rounds}'::text[],
             COALESCE(COALESCE(retry_counters, '{}'::jsonb) -> 'ai_review_rounds', '{}'::jsonb),
             true
           ),
           '{last_ai_review_notes}'::text[],
           COALESCE(COALESCE(retry_counters, '{}'::jsonb) -> 'last_ai_review_notes', '{}'::jsonb),
           true
         ),
         ARRAY['ai_review_rounds'::text, $2::text],
         to_jsonb(COALESCE((COALESCE(retry_counters, '{}'::jsonb) #>> ARRAY['ai_review_rounds'::text, $2::text]::text[])::int, 0) + 1),
         true
       ),
       ARRAY['last_ai_review_notes'::text, $3::text],
       $4::jsonb,
       true
     ),
     updated_at = NOW()
     WHERE id = $1
     RETURNING (retry_counters #>> ARRAY['ai_review_rounds'::text, $2::text]::text[])::int AS count`,
    [requirementId, reviewNodeId, authorNodeId, JSON.stringify(reviewNotes)],
  )
  return { newCount: rows[0]?.count ?? 0 }
}

/**
 * 读 retry_counters.last_ai_review_notes[authorNodeId]，不存在返回空数组。
 * 用于 buildLlmReviewNode round 2+ 注入 previousReviewNotes（T10 消费）。
 */
export async function getLastAiReviewNotes(
  requirementId: number,
  authorNodeId: string,
): Promise<Array<{ severity: string; msg: string; file?: string }>> {
  const pool = getPool()
  const { rows } = await pool.query<{ notes: unknown }>(
    `SELECT retry_counters->'last_ai_review_notes'->$2 AS notes
     FROM requirements WHERE id = $1`,
    [requirementId, authorNodeId],
  )
  const v = rows[0]?.notes
  return (Array.isArray(v) ? v : []) as Array<{ severity: string; msg: string; file?: string }>
}
