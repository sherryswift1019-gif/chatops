import { getPool } from '../client.js'

export type CapabilityCategory = 'query' | 'action' | 'admin' | 'env_prep' | 'verify' | 'testing' | 'result'

export interface Capability {
  id: number
  key: string
  displayName: string
  description: string
  category: CapabilityCategory
  toolNames: string[]
  needsApproval: boolean
  paramSchema: Record<string, unknown>
  playbook: unknown[]
  isSystem: boolean
  systemPrompt: string | null
  defaultSystemPrompt: string | null
  updatedAt: Date | null
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): Capability {
  return {
    id: r.id as number,
    key: r.key as string,
    displayName: r.display_name as string,
    description: r.description as string,
    category: r.category as CapabilityCategory,
    toolNames: r.tool_names as string[],
    needsApproval: r.needs_approval as boolean,
    paramSchema: (r.param_schema ?? {}) as Record<string, unknown>,
    playbook: (r.playbook ?? []) as unknown[],
    isSystem: (r.is_system ?? true) as boolean,
    systemPrompt: (r.system_prompt ?? null) as string | null,
    defaultSystemPrompt: (r.default_system_prompt ?? null) as string | null,
    updatedAt: r.updated_at as Date | null,
    createdAt: r.created_at as Date,
  }
}

export async function listCapabilities(): Promise<Capability[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM capabilities ORDER BY category, id')
  return rows.map(mapRow)
}

export async function getCapabilityByKey(key: string): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM capabilities WHERE key = $1', [key])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createCapability(
  data: Pick<Capability, 'key' | 'displayName' | 'description' | 'category' | 'toolNames' | 'needsApproval'> & { paramSchema?: Record<string, unknown> }
): Promise<Capability> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, param_schema)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [data.key, data.displayName, data.description ?? '', data.category,
     JSON.stringify(data.toolNames), data.needsApproval, JSON.stringify(data.paramSchema ?? {})]
  )
  return mapRow(rows[0])
}

export async function updateCapability(
  id: number,
  data: Partial<Pick<Capability, 'displayName' | 'description' | 'category' | 'toolNames' | 'needsApproval' | 'paramSchema'>>
): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE capabilities SET
       display_name = COALESCE($2, display_name),
       description = COALESCE($3, description),
       category = COALESCE($4, category),
       tool_names = COALESCE($5, tool_names),
       needs_approval = COALESCE($6, needs_approval),
       param_schema = COALESCE($7, param_schema),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.displayName ?? null, data.description ?? null, data.category ?? null,
     data.toolNames ? JSON.stringify(data.toolNames) : null, data.needsApproval ?? null,
     data.paramSchema ? JSON.stringify(data.paramSchema) : null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updateCapabilitySystemPrompt(id: number, systemPrompt: string): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE capabilities SET system_prompt = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, systemPrompt]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function resetCapabilitySystemPrompt(id: number): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE capabilities SET system_prompt = default_system_prompt, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  )
  return rows[0] ? mapRow(rows[0]) : null
}
