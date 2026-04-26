import { getPool } from '../client.js'

export interface PipelineNodeType {
  key: string
  displayName: string
  description: string
  category: 'general' | 'flow' | 'llm' | 'specialized'
  paramSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  isSystem: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): PipelineNodeType {
  return {
    key: r.key as string,
    displayName: r.display_name as string,
    description: (r.description ?? '') as string,
    category: r.category as PipelineNodeType['category'],
    paramSchema: (r.param_schema ?? {}) as Record<string, unknown>,
    outputSchema: (r.output_schema ?? {}) as Record<string, unknown>,
    isSystem: r.is_system as boolean,
    enabled: r.enabled as boolean,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function listNodeTypes(): Promise<PipelineNodeType[]> {
  const { rows } = await getPool().query('SELECT * FROM pipeline_node_types ORDER BY category, key')
  return rows.map(mapRow)
}

export async function getNodeType(key: string): Promise<PipelineNodeType | null> {
  const { rows } = await getPool().query('SELECT * FROM pipeline_node_types WHERE key = $1', [key])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listEnabledNodeTypeKeys(): Promise<Set<string>> {
  const { rows } = await getPool().query('SELECT key FROM pipeline_node_types WHERE enabled = true')
  return new Set(rows.map(r => r.key as string))
}
