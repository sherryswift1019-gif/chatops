import { getPool } from '../client.js'

export type PrdStatus =
  | 'drafting'
  | 'reviewing'
  | 'review_blocked'
  | 'draft'
  | 'approved'
  | 'archived'

export interface PrdReviewFinding {
  id: string
  dimension: string
  severity: 'blocker' | 'major' | 'minor'
  location: string
  description: string
  suggestion?: string
  canAutoFix: boolean
  autoFixBlockedReason?: string
  ownership?: 'pm' | 'admin' | 'business'
  recommendation?: {
    action: 'approve' | 'approve_with_edits' | 'reject'
    reason: string
  }
}

export interface PrdReviewResult {
  status: 'passed' | 'blocked'
  round: number
  findings: PrdReviewFinding[]
  recommendation?: {
    action: 'approve' | 'approve_with_edits' | 'reject'
    reason: string
  }
  reviewedAt: string
}

export interface PrdReviewHistoryEntry {
  round: number
  result: PrdReviewResult
  repairedAt?: string
  repairSummary?: string
}

export interface PrdDocument {
  id: number
  productLineId: number
  title: string
  version: number
  status: PrdStatus
  contentMarkdown: string
  contentJson: Record<string, unknown>
  reviewResult: PrdReviewResult | null
  reviewHistory: PrdReviewHistoryEntry[]
  createdBy: string
  groupId: string | null
  platform: string | null
  agentSessionId: string | null
  tags: string[]
  metadata: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): PrdDocument {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    title: r.title as string,
    version: r.version as number,
    status: r.status as PrdStatus,
    contentMarkdown: r.content_markdown as string,
    contentJson: (r.content_json ?? {}) as Record<string, unknown>,
    reviewResult: r.review_result as PrdReviewResult | null,
    reviewHistory: (r.review_history ?? []) as PrdReviewHistoryEntry[],
    createdBy: r.created_by as string,
    groupId: r.group_id as string | null,
    platform: r.platform as string | null,
    agentSessionId: r.agent_session_id as string | null,
    tags: (r.tags ?? []) as string[],
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function createPrdDocument(data: {
  productLineId: number
  title: string
  contentMarkdown: string
  contentJson?: Record<string, unknown>
  createdBy: string
  groupId?: string | null
  platform?: string | null
  agentSessionId?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
}): Promise<PrdDocument> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO prd_documents
       (product_line_id, title, content_markdown, content_json,
        created_by, group_id, platform, agent_session_id, tags, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      data.productLineId,
      data.title,
      data.contentMarkdown,
      JSON.stringify(data.contentJson ?? {}),
      data.createdBy,
      data.groupId ?? null,
      data.platform ?? null,
      data.agentSessionId ?? null,
      JSON.stringify(data.tags ?? []),
      JSON.stringify(data.metadata ?? {}),
    ]
  )
  return mapRow(rows[0])
}

export async function getPrdDocumentById(id: number): Promise<PrdDocument | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM prd_documents WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updatePrdContent(
  id: number,
  data: {
    title?: string
    contentMarkdown?: string
    contentJson?: Record<string, unknown>
    tags?: string[]
    agentSessionId?: string | null
    expectedVersion?: number
  }
): Promise<PrdDocument | null> {
  const pool = getPool()
  const sets: string[] = []
  const values: unknown[] = [id]
  let idx = 2

  if (data.title !== undefined) {
    sets.push(`title = $${idx++}`)
    values.push(data.title)
  }
  if (data.contentMarkdown !== undefined) {
    sets.push(`content_markdown = $${idx++}`)
    values.push(data.contentMarkdown)
  }
  if (data.contentJson !== undefined) {
    sets.push(`content_json = $${idx++}`)
    values.push(JSON.stringify(data.contentJson))
  }
  if (data.tags !== undefined) {
    sets.push(`tags = $${idx++}`)
    values.push(JSON.stringify(data.tags))
  }
  if (data.agentSessionId !== undefined) {
    sets.push(`agent_session_id = $${idx++}`)
    values.push(data.agentSessionId)
  }

  sets.push('version = version + 1')
  sets.push('updated_at = NOW()')

  let whereClause = 'WHERE id = $1'
  if (data.expectedVersion !== undefined) {
    whereClause += ` AND version = $${idx++}`
    values.push(data.expectedVersion)
  }

  const { rows } = await pool.query(
    `UPDATE prd_documents SET ${sets.join(', ')} ${whereClause} RETURNING *`,
    values
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updatePrdStatus(id: number, status: PrdStatus): Promise<PrdDocument | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE prd_documents SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, status]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updatePrdReviewResult(
  id: number,
  reviewResult: PrdReviewResult,
  nextStatus?: PrdStatus
): Promise<PrdDocument | null> {
  const pool = getPool()
  if (nextStatus) {
    const { rows } = await pool.query(
      `UPDATE prd_documents
         SET review_result = $2, status = $3, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(reviewResult), nextStatus]
    )
    return rows[0] ? mapRow(rows[0]) : null
  }
  const { rows } = await pool.query(
    `UPDATE prd_documents
       SET review_result = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(reviewResult)]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function appendReviewHistory(
  id: number,
  entry: PrdReviewHistoryEntry
): Promise<PrdDocument | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE prd_documents
       SET review_history = review_history || $2::jsonb,
           updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, JSON.stringify([entry])]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listPrdDocuments(filter: {
  productLineId?: number
  status?: PrdStatus
  createdBy?: string
  limit?: number
  offset?: number
}): Promise<PrdDocument[]> {
  const pool = getPool()
  const conds: string[] = []
  const values: unknown[] = []
  let idx = 1

  if (filter.productLineId !== undefined) {
    conds.push(`product_line_id = $${idx++}`)
    values.push(filter.productLineId)
  }
  if (filter.status !== undefined) {
    conds.push(`status = $${idx++}`)
    values.push(filter.status)
  }
  if (filter.createdBy !== undefined) {
    conds.push(`created_by = $${idx++}`)
    values.push(filter.createdBy)
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const limit = filter.limit ?? 50
  const offset = filter.offset ?? 0

  const { rows } = await pool.query(
    `SELECT * FROM prd_documents ${where}
     ORDER BY updated_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...values, limit, offset]
  )
  return rows.map(mapRow)
}

export async function searchPrdDocuments(
  query: string,
  filter: { productLineId?: number; limit?: number } = {}
): Promise<PrdDocument[]> {
  const pool = getPool()
  const conds: string[] = [`(title ILIKE $1 OR content_markdown ILIKE $1)`]
  const values: unknown[] = [`%${query}%`]
  let idx = 2

  if (filter.productLineId !== undefined) {
    conds.push(`product_line_id = $${idx++}`)
    values.push(filter.productLineId)
  }

  const limit = filter.limit ?? 20
  const { rows } = await pool.query(
    `SELECT * FROM prd_documents WHERE ${conds.join(' AND ')}
     ORDER BY updated_at DESC LIMIT $${idx}`,
    [...values, limit]
  )
  return rows.map(mapRow)
}

export async function deletePrdDocument(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM prd_documents WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}

// =============================================================================
// V2.0 baseline metrics 埋点写回（schema-v18 的 metrics JSONB 列）
//
// 约定：
//   - llmCallsDelta 是加法（存量 + delta），用于 create/review/repair 计数增量。
//   - reviewDurationMs / rulesVersion 是覆盖写。
//   - 单写者前提：save_prd 单次调用 + runPrdReview 每个 PRD 串行，冲突面极小。
//     为稳妥仍走 SELECT FOR UPDATE 事务，避免并发重试时丢计数。
// =============================================================================

export interface PrdMetricsPatch {
  llmCallsDelta?: { create?: number; review?: number; repair?: number }
  reviewDurationMs?: number
  rulesVersion?: string
}

/**
 * 纯函数：对现有 metrics JSON 应用 patch，返回新 metrics。
 * 单独导出以便单测，不碰 DB。
 */
export function computeMergedMetrics(
  existing: Record<string, unknown>,
  patch: PrdMetricsPatch
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing }
  if (patch.llmCallsDelta) {
    const cur = (existing.llmCalls ?? {}) as Record<string, unknown>
    const next: Record<string, number> = {}
    for (const k of ['create', 'review', 'repair'] as const) {
      const curVal = typeof cur[k] === 'number' ? (cur[k] as number) : 0
      const delta = patch.llmCallsDelta[k]
      if (delta !== undefined || curVal !== 0) {
        next[k] = curVal + (delta ?? 0)
      }
    }
    if (Object.keys(next).length > 0) merged.llmCalls = next
  }
  if (patch.reviewDurationMs !== undefined) {
    merged.reviewDurationMs = patch.reviewDurationMs
  }
  if (patch.rulesVersion !== undefined) {
    merged.rulesVersion = patch.rulesVersion
  }
  return merged
}

/**
 * SELECT FOR UPDATE → JS 合并 → UPDATE。
 * 写入失败只打 log、不抛，避免埋点毛刺阻塞主流程。
 */
export async function mergePrdMetrics(
  id: number,
  patch: PrdMetricsPatch
): Promise<void> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const cur = await client.query<{ metrics: Record<string, unknown> }>(
      'SELECT metrics FROM prd_documents WHERE id = $1 FOR UPDATE',
      [id]
    )
    if (cur.rowCount === 0) {
      await client.query('ROLLBACK')
      return
    }
    const existing = (cur.rows[0].metrics ?? {}) as Record<string, unknown>
    const merged = computeMergedMetrics(existing, patch)
    await client.query(
      'UPDATE prd_documents SET metrics = $2::jsonb, updated_at = NOW() WHERE id = $1',
      [id, JSON.stringify(merged)]
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(`[prd-repo] mergePrdMetrics(${id}) 失败:`, e)
  } finally {
    client.release()
  }
}
