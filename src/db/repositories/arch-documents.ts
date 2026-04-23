import { getPool } from '../client.js'

export interface ArchDocument {
  id: number
  productLineId: number
  sourcePrdId: number | null
  title: string
  version: number
  status: 'drafting' | 'review_blocked' | 'draft' | 'approved' | 'archived'
  contentMarkdown: string
  contentJson: Record<string, unknown>
  reviewResult: unknown | null
  reviewHistory: unknown[]
  createdBy: string
  agentSessionId: string | null
  createdAt: Date
  updatedAt: Date
}

function mapRow(row: Record<string, unknown>): ArchDocument {
  return {
    id: row.id as number,
    productLineId: row.product_line_id as number,
    sourcePrdId: row.source_prd_id as number | null,
    title: row.title as string,
    version: row.version as number,
    status: row.status as ArchDocument['status'],
    contentMarkdown: (row.content_markdown as string) ?? '',
    contentJson: (row.content_json as Record<string, unknown>) ?? {},
    reviewResult: row.review_result ?? null,
    reviewHistory: (row.review_history as unknown[]) ?? [],
    createdBy: row.created_by as string,
    agentSessionId: row.agent_session_id as string | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  }
}

export async function createArchDocument(params: {
  productLineId: number
  sourcePrdId?: number | null
  title: string
  contentMarkdown: string
  contentJson: Record<string, unknown>
  createdBy: string
  agentSessionId?: string
}): Promise<ArchDocument> {
  const result = await getPool().query(
    `INSERT INTO arch_documents
       (product_line_id, source_prd_id, title, content_markdown, content_json, created_by, agent_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      params.productLineId,
      params.sourcePrdId ?? null,
      params.title,
      params.contentMarkdown,
      params.contentJson,
      params.createdBy,
      params.agentSessionId ?? null,
    ]
  )
  return mapRow(result.rows[0])
}

export async function getArchDocumentById(id: number): Promise<ArchDocument | null> {
  const result = await getPool().query('SELECT * FROM arch_documents WHERE id = $1', [id])
  return result.rows[0] ? mapRow(result.rows[0]) : null
}

export async function listArchDocuments(params: {
  productLineId?: number
  status?: string
  limit?: number
  offset?: number
}): Promise<{ items: ArchDocument[]; total: number }> {
  const conditions: string[] = []
  const values: unknown[] = []
  let idx = 1

  if (params.productLineId != null) {
    conditions.push(`product_line_id = $${idx++}`)
    values.push(params.productLineId)
  }
  if (params.status) {
    conditions.push(`status = $${idx++}`)
    values.push(params.status)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = params.limit ?? 20
  const offset = params.offset ?? 0

  const [dataResult, countResult] = await Promise.all([
    getPool().query(
      `SELECT * FROM arch_documents ${where} ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx}`,
      [...values, limit, offset]
    ),
    getPool().query(`SELECT COUNT(*) FROM arch_documents ${where}`, values),
  ])

  return {
    items: dataResult.rows.map(mapRow),
    total: Number(countResult.rows[0].count),
  }
}

export async function updateArchDocument(
  id: number,
  params: {
    title?: string
    status?: string
    contentMarkdown?: string
    contentJson?: Record<string, unknown>
    reviewResult?: unknown
    reviewHistory?: unknown[]
    agentSessionId?: string
    version?: number
  }
): Promise<ArchDocument | null> {
  const sets: string[] = []
  const values: unknown[] = []
  let idx = 1

  if (params.title !== undefined) { sets.push(`title = $${idx++}`); values.push(params.title) }
  if (params.status !== undefined) { sets.push(`status = $${idx++}`); values.push(params.status) }
  if (params.contentMarkdown !== undefined) { sets.push(`content_markdown = $${idx++}`); values.push(params.contentMarkdown) }
  if (params.contentJson !== undefined) { sets.push(`content_json = $${idx++}`); values.push(params.contentJson) }
  if (params.reviewResult !== undefined) { sets.push(`review_result = $${idx++}`); values.push(params.reviewResult) }
  if (params.reviewHistory !== undefined) { sets.push(`review_history = $${idx++}`); values.push(params.reviewHistory) }
  if (params.agentSessionId !== undefined) { sets.push(`agent_session_id = $${idx++}`); values.push(params.agentSessionId) }
  if (params.version !== undefined) { sets.push(`version = $${idx++}`); values.push(params.version) }

  if (sets.length === 0) return getArchDocumentById(id)

  sets.push(`updated_at = NOW()`)
  values.push(id)

  const result = await getPool().query(
    `UPDATE arch_documents SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  )
  return result.rows[0] ? mapRow(result.rows[0]) : null
}

export async function searchArchDocuments(params: {
  productLineId?: number
  keyword: string
  limit?: number
}): Promise<ArchDocument[]> {
  const limit = params.limit ?? 5
  if (params.productLineId != null) {
    const result = await getPool().query(
      `SELECT * FROM arch_documents
       WHERE product_line_id = $1
         AND (title ILIKE $2 OR content_markdown ILIKE $2)
       ORDER BY updated_at DESC
       LIMIT $3`,
      [params.productLineId, `%${params.keyword}%`, limit]
    )
    return result.rows.map(mapRow)
  }
  const result = await getPool().query(
    `SELECT * FROM arch_documents
     WHERE (title ILIKE $1 OR content_markdown ILIKE $1)
     ORDER BY updated_at DESC
     LIMIT $2`,
    [`%${params.keyword}%`, limit]
  )
  return result.rows.map(mapRow)
}
