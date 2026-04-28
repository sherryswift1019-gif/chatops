import { getPool } from '../client.js'

export interface Capability {
  id: number
  key: string
  displayName: string
  description: string
  toolNames: string[]
  isSystem: boolean
  systemPrompt: string | null
  defaultSystemPrompt: string | null
  // ── phase 1 新增（spec §3.4 / plan §B） ─────────────────────────
  maxTurns: number
  timeoutMs: number
  requiresWorktree: boolean
  requiresDeployLock: boolean
  // ───────────────────────────────────────────────────────────────
  category: string | null
  updatedAt: Date | null
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): Capability {
  return {
    id: r.id as number,
    key: r.key as string,
    displayName: r.display_name as string,
    description: r.description as string,
    toolNames: r.tool_names as string[],
    isSystem: (r.is_system ?? true) as boolean,
    systemPrompt: (r.system_prompt ?? null) as string | null,
    defaultSystemPrompt: (r.default_system_prompt ?? null) as string | null,
    maxTurns: (r.max_turns ?? 30) as number,
    timeoutMs: (r.timeout_ms ?? 1200000) as number,
    requiresWorktree: (r.requires_worktree ?? false) as boolean,
    requiresDeployLock: (r.requires_deploy_lock ?? false) as boolean,
    category: (r.category ?? null) as string | null,
    updatedAt: r.updated_at as Date | null,
    createdAt: r.created_at as Date,
  }
}

export async function listCapabilities(): Promise<Capability[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM capabilities ORDER BY id')
  return rows.map(mapRow)
}

export async function getCapabilityByKey(key: string): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM capabilities WHERE key = $1', [key])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createCapability(
  data: Pick<Capability, 'key' | 'displayName' | 'description' | 'toolNames'> & { category?: string | null }
): Promise<Capability> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO capabilities (key, display_name, description, tool_names, category)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [data.key, data.displayName, data.description ?? '', JSON.stringify(data.toolNames), data.category ?? null]
  )
  return mapRow(rows[0])
}

export async function updateCapability(
  id: number,
  data: Partial<Pick<Capability, 'displayName' | 'description' | 'toolNames' | 'category'>>
): Promise<Capability | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE capabilities SET
       display_name = COALESCE($2, display_name),
       description = COALESCE($3, description),
       tool_names = COALESCE($4, tool_names),
       category = COALESCE($5, category),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.displayName ?? null, data.description ?? null,
     data.toolNames ? JSON.stringify(data.toolNames) : null,
     data.category ?? null]
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
