import { getPool } from '../client.js'

export interface Capability {
  id: number
  key: string
  displayName: string
  description: string
  category: 'query' | 'action' | 'admin'
  toolNames: string[]
  needsApproval: boolean
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): Capability {
  return {
    id: r.id as number,
    key: r.key as string,
    displayName: r.display_name as string,
    description: r.description as string,
    category: r.category as 'query' | 'action' | 'admin',
    toolNames: r.tool_names as string[],
    needsApproval: r.needs_approval as boolean,
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
  data: Pick<Capability, 'key' | 'displayName' | 'description' | 'category' | 'toolNames' | 'needsApproval'>
): Promise<Capability> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [data.key, data.displayName, data.description ?? '', data.category, JSON.stringify(data.toolNames), data.needsApproval]
  )
  return mapRow(rows[0])
}

export async function updateCapability(
  id: number,
  data: Partial<Pick<Capability, 'displayName' | 'description' | 'category' | 'toolNames' | 'needsApproval'>>
): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE capabilities SET
       display_name = COALESCE($2, display_name),
       description = COALESCE($3, description),
       category = COALESCE($4, category),
       tool_names = COALESCE($5, tool_names),
       needs_approval = COALESCE($6, needs_approval)
     WHERE id = $1 RETURNING *`,
    [id, data.displayName ?? null, data.description ?? null, data.category ?? null,
     data.toolNames ? JSON.stringify(data.toolNames) : null, data.needsApproval ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}
