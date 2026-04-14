import { getPool } from '../client.js'

export interface StageOperation {
  id: number
  key: string
  displayName: string
  description: string
  category: string
  toolNames: string[]
  paramSchema: Record<string, unknown>
  playbook: unknown[]
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): StageOperation {
  return {
    id: r.id as number,
    key: r.key as string,
    displayName: r.display_name as string,
    description: r.description as string,
    category: r.category as string,
    toolNames: r.tool_names as string[],
    paramSchema: (r.param_schema ?? {}) as Record<string, unknown>,
    playbook: (r.playbook ?? []) as unknown[],
    createdAt: r.created_at as Date,
  }
}

export async function listStageOperations(): Promise<StageOperation[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM stage_operations ORDER BY category, id')
  return rows.map(mapRow)
}

export async function getStageOperationByKey(key: string): Promise<StageOperation | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM stage_operations WHERE key = $1', [key])
  return rows[0] ? mapRow(rows[0]) : null
}
