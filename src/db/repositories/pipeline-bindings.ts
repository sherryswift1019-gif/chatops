import { getPool } from '../client.js'

export interface PipelineBinding {
  productLineId: number
  refKey: string
  pipelineId: number
  serverRoleAssignments: Record<string, string[]>
  description: string
  createdAt: Date
  updatedAt: Date
}

interface DbRow {
  product_line_id: number
  ref_key: string
  pipeline_id: number
  server_role_assignments: Record<string, string[]>
  description: string
  created_at: Date
  updated_at: Date
}

function mapRow(r: DbRow): PipelineBinding {
  return {
    productLineId: r.product_line_id,
    refKey: r.ref_key,
    pipelineId: r.pipeline_id,
    serverRoleAssignments: r.server_role_assignments ?? {},
    description: r.description ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export async function getPipelineBinding(
  productLineId: number,
  refKey: string,
): Promise<PipelineBinding | null> {
  const { rows } = await getPool().query<DbRow>(
    `SELECT * FROM pipeline_bindings WHERE product_line_id = $1 AND ref_key = $2`,
    [productLineId, refKey],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listPipelineBindings(filter?: {
  productLineId?: number
  pipelineId?: number
}): Promise<PipelineBinding[]> {
  const conds: string[] = []
  const params: unknown[] = []
  if (filter?.productLineId !== undefined) {
    params.push(filter.productLineId)
    conds.push(`product_line_id = $${params.length}`)
  }
  if (filter?.pipelineId !== undefined) {
    params.push(filter.pipelineId)
    conds.push(`pipeline_id = $${params.length}`)
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''
  const { rows } = await getPool().query<DbRow>(
    `SELECT * FROM pipeline_bindings ${where} ORDER BY product_line_id, ref_key`,
    params,
  )
  return rows.map(mapRow)
}

export async function upsertPipelineBinding(
  b: Omit<PipelineBinding, 'createdAt' | 'updatedAt'>,
): Promise<PipelineBinding> {
  const { rows } = await getPool().query<DbRow>(
    `INSERT INTO pipeline_bindings
       (product_line_id, ref_key, pipeline_id, server_role_assignments, description)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (product_line_id, ref_key) DO UPDATE SET
       pipeline_id = EXCLUDED.pipeline_id,
       server_role_assignments = EXCLUDED.server_role_assignments,
       description = EXCLUDED.description,
       updated_at = NOW()
     RETURNING *`,
    [b.productLineId, b.refKey, b.pipelineId, JSON.stringify(b.serverRoleAssignments), b.description],
  )
  return mapRow(rows[0])
}

export async function deletePipelineBinding(productLineId: number, refKey: string): Promise<void> {
  await getPool().query(
    `DELETE FROM pipeline_bindings WHERE product_line_id = $1 AND ref_key = $2`,
    [productLineId, refKey],
  )
}

export async function resolvePipelineForTrigger(
  productLineId: number,
  refKey: string,
): Promise<{ pipelineId: number; serverRoleAssignments: Record<string, string[]> } | null> {
  const { rows } = await getPool().query<DbRow>(
    `SELECT pipeline_id, server_role_assignments FROM pipeline_bindings
     WHERE product_line_id = $1 AND ref_key = $2`,
    [productLineId, refKey],
  )
  if (!rows[0]) return null
  return {
    pipelineId: rows[0].pipeline_id,
    serverRoleAssignments: rows[0].server_role_assignments ?? {},
  }
}
