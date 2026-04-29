import { getPool } from '../client.js'

export interface TestPipeline {
  id: number
  productLineId: number  // 0 表示未绑定产线（DB 列 nullable，mapRow 把 null 映射为 0）
  name: string
  description: string
  stages: unknown[]
  serverRoles: Record<string, { count: number }>
  enabled: boolean
  triggerParams: Record<string, unknown>
  variables: Record<string, string>
  artifactInputs: unknown[]
  graph: unknown | null
  containerImage: string | null
  paramSchema: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): TestPipeline {
  return {
    id: r.id as number, productLineId: (r.product_line_id ?? 0) as number,
    name: r.name as string, description: (r.description ?? '') as string,
    stages: (r.stages ?? []) as unknown[], serverRoles: (r.server_roles ?? {}) as Record<string, { count: number }>,
    enabled: r.enabled as boolean,
    triggerParams: (r.trigger_params ?? {}) as Record<string, unknown>,
    variables: (r.variables ?? {}) as Record<string, string>,
    artifactInputs: (r.artifact_inputs ?? []) as unknown[],
    graph: (r.graph ?? null) as unknown,
    containerImage: (r.container_image ?? null) as string | null,
    paramSchema: (r.param_schema ?? null) as Record<string, unknown> | null,
    createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
  }
}

export async function listTestPipelines(productLineId?: number): Promise<TestPipeline[]> {
  const pool = getPool()
  if (productLineId) {
    const { rows } = await pool.query('SELECT * FROM test_pipelines WHERE product_line_id = $1 ORDER BY id', [productLineId])
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM test_pipelines ORDER BY id')
  return rows.map(mapRow)
}

export async function getTestPipelineById(id: number): Promise<TestPipeline | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM test_pipelines WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getTestPipelineByName(name: string): Promise<TestPipeline | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM test_pipelines WHERE name = $1 AND enabled = true LIMIT 1', [name])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createTestPipeline(data: {
  productLineId?: number | null; name: string; description?: string
  stages?: unknown[]; serverRoles?: Record<string, { count: number }>
  enabled?: boolean; triggerParams?: Record<string, unknown>
  variables?: Record<string, string>
  artifactInputs?: unknown[]
  graph?: unknown
  containerImage?: string | null
}): Promise<TestPipeline> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, enabled, trigger_params, variables, artifact_inputs, graph, container_image)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [data.productLineId ?? null, data.name, data.description ?? '', JSON.stringify(data.stages ?? []),
     JSON.stringify(data.serverRoles ?? {}), data.enabled ?? true,
     JSON.stringify(data.triggerParams ?? {}), JSON.stringify(data.variables ?? {}),
     JSON.stringify(data.artifactInputs ?? []),
     data.graph !== undefined ? JSON.stringify(data.graph) : null,
     data.containerImage ?? null]
  )
  return mapRow(rows[0])
}

export async function updateTestPipeline(id: number, data: Partial<{
  name: string; description: string; stages: unknown[]
  serverRoles: Record<string, { count: number }>; enabled: boolean
  triggerParams: Record<string, unknown>; variables: Record<string, string>
  artifactInputs: unknown[]
  graph: unknown | null
  containerImage?: string | null
}>): Promise<TestPipeline | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE test_pipelines SET
       name = COALESCE($2, name), description = COALESCE($3, description),
       stages = COALESCE($4, stages), server_roles = COALESCE($5, server_roles),
       enabled = COALESCE($6, enabled),
       trigger_params = COALESCE($7, trigger_params),
       variables = COALESCE($8, variables),
       artifact_inputs = COALESCE($9, artifact_inputs),
       graph = COALESCE($10, graph),
       container_image = COALESCE($11, container_image),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.description ?? null,
     data.stages ? JSON.stringify(data.stages) : null,
     data.serverRoles ? JSON.stringify(data.serverRoles) : null,
     data.enabled ?? null,
     data.triggerParams ? JSON.stringify(data.triggerParams) : null,
     data.variables ? JSON.stringify(data.variables) : null,
     data.artifactInputs ? JSON.stringify(data.artifactInputs) : null,
     data.graph !== undefined ? (data.graph === null ? null : JSON.stringify(data.graph)) : null,
     data.containerImage ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

/**
 * 画布保存专用：直接覆写 graph 列（不影响 stages）。
 * 传 null 可清空 graph，让 runtime fallback 到 stages。
 */
export async function setPipelineGraph(id: number, graph: unknown | null): Promise<TestPipeline | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE test_pipelines SET graph = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, graph === null ? null : JSON.stringify(graph)]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteTestPipeline(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM test_pipelines WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
