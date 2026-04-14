import { getPool } from '../client.js'

export interface PipelineTool {
  id: number
  key: string
  displayName: string
  description: string
  paramSchema: Record<string, unknown>
  isSystem: boolean
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): PipelineTool {
  return {
    id: r.id as number,
    key: r.key as string,
    displayName: r.display_name as string,
    description: r.description as string,
    paramSchema: (r.param_schema ?? {}) as Record<string, unknown>,
    isSystem: (r.is_system ?? true) as boolean,
    createdAt: r.created_at as Date,
  }
}

export async function listPipelineTools(): Promise<PipelineTool[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM pipeline_tools ORDER BY id')
  return rows.map(mapRow)
}
