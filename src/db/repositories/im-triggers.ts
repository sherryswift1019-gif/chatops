import { getPool } from '../client.js'

export type IMTriggerCategory = 'info' | 'ops' | 'bug' | 'feature'

export interface IMTrigger {
  id: number
  key: string
  displayName: string
  description: string
  category: IMTriggerCategory
  pipelineId: number | null
  capabilityKey: string | null
  intentHints: string
  examples: string[]
  failureMessages: Record<string, string>
  defaultApprovalRuleId: number | null
  isSystem: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): IMTrigger {
  return {
    id: r.id as number,
    key: r.key as string,
    displayName: r.display_name as string,
    description: (r.description ?? '') as string,
    category: ((r.category as string) || 'ops') as IMTriggerCategory,
    pipelineId: (r.pipeline_id ?? null) as number | null,
    capabilityKey: (r.capability_key ?? null) as string | null,
    intentHints: (r.intent_hints ?? '') as string,
    examples: (r.examples ?? []) as string[],
    failureMessages: (r.failure_messages ?? {}) as Record<string, string>,
    defaultApprovalRuleId: (r.default_approval_rule_id ?? null) as number | null,
    isSystem: r.is_system as boolean,
    enabled: r.enabled as boolean,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function listIMTriggers(): Promise<IMTrigger[]> {
  const { rows } = await getPool().query('SELECT * FROM im_triggers ORDER BY key')
  return rows.map(mapRow)
}

export async function getIMTrigger(key: string): Promise<IMTrigger | null> {
  const { rows } = await getPool().query('SELECT * FROM im_triggers WHERE key = $1', [key])
  return rows[0] ? mapRow(rows[0]) : null
}

export interface CreateIMTriggerInput {
  key: string
  displayName: string
  description?: string
  category?: IMTriggerCategory
  pipelineId?: number | null
  capabilityKey?: string | null
  intentHints?: string
  examples?: string[]
  failureMessages?: Record<string, string>
  defaultApprovalRuleId?: number | null
  isSystem?: boolean
  enabled?: boolean
}

export async function createIMTrigger(input: CreateIMTriggerInput): Promise<IMTrigger> {
  const { rows } = await getPool().query(
    `INSERT INTO im_triggers
       (key, display_name, description, category, pipeline_id, capability_key, intent_hints, examples,
        failure_messages, default_approval_rule_id, is_system, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
     RETURNING *`,
    [
      input.key, input.displayName, input.description ?? '',
      input.category ?? 'ops',
      input.pipelineId ?? null, input.capabilityKey ?? null,
      input.intentHints ?? '',
      JSON.stringify(input.examples ?? []),
      JSON.stringify(input.failureMessages ?? {}),
      input.defaultApprovalRuleId ?? null,
      input.isSystem ?? false, input.enabled ?? true,
    ],
  )
  return mapRow(rows[0])
}

export async function updateIMTrigger(id: number, patch: Partial<CreateIMTriggerInput>): Promise<IMTrigger | null> {
  const fields: string[] = []
  const values: unknown[] = []
  let idx = 1
  if (patch.displayName !== undefined) { fields.push(`display_name = $${idx++}`); values.push(patch.displayName) }
  if (patch.description !== undefined) { fields.push(`description = $${idx++}`); values.push(patch.description) }
  if (patch.category !== undefined) { fields.push(`category = $${idx++}`); values.push(patch.category) }
  if (patch.pipelineId !== undefined) { fields.push(`pipeline_id = $${idx++}`); values.push(patch.pipelineId) }
  if (patch.capabilityKey !== undefined) { fields.push(`capability_key = $${idx++}`); values.push(patch.capabilityKey) }
  if (patch.intentHints !== undefined) { fields.push(`intent_hints = $${idx++}`); values.push(patch.intentHints) }
  if (patch.examples !== undefined) { fields.push(`examples = $${idx++}::jsonb`); values.push(JSON.stringify(patch.examples)) }
  if (patch.failureMessages !== undefined) { fields.push(`failure_messages = $${idx++}::jsonb`); values.push(JSON.stringify(patch.failureMessages)) }
  if (patch.defaultApprovalRuleId !== undefined) { fields.push(`default_approval_rule_id = $${idx++}`); values.push(patch.defaultApprovalRuleId) }
  if (patch.enabled !== undefined) { fields.push(`enabled = $${idx++}`); values.push(patch.enabled) }
  if (fields.length === 0) return getIMTriggerById(id)
  fields.push(`updated_at = NOW()`)
  values.push(id)
  const { rows } = await getPool().query(
    `UPDATE im_triggers SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getIMTriggerById(id: number): Promise<IMTrigger | null> {
  const { rows } = await getPool().query('SELECT * FROM im_triggers WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteIMTrigger(id: number): Promise<void> {
  await getPool().query('DELETE FROM im_triggers WHERE id = $1', [id])
}
