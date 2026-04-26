import { getPool } from '../client.js'

export interface ProductLineIMTrigger {
  id: number
  productLineId: number
  imTriggerKey: string
  envName: string
  enabled: boolean
  allowedRoles: string[]
  triggerSources: string[]
  approvalRuleId: number | null
}

function mapRow(r: Record<string, unknown>): ProductLineIMTrigger {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    imTriggerKey: r.im_trigger_key as string,
    envName: r.env_name as string,
    enabled: r.enabled as boolean,
    allowedRoles: (r.allowed_roles ?? []) as string[],
    triggerSources: (r.trigger_sources ?? ['im','web']) as string[],
    approvalRuleId: (r.approval_rule_id ?? null) as number | null,
  }
}

export async function listProductLineIMTriggers(productLineId: number): Promise<ProductLineIMTrigger[]> {
  const { rows } = await getPool().query(
    'SELECT * FROM product_line_im_triggers WHERE product_line_id = $1 ORDER BY im_trigger_key, env_name',
    [productLineId],
  )
  return rows.map(mapRow)
}

export interface AccessCheck {
  allowed: boolean
  reason?: 'not-configured' | 'disabled' | 'role-not-allowed' | 'source-blocked'
}

export async function checkIMTriggerAccess(
  productLineId: number,
  imTriggerKey: string,
  envName: string,
  role: string,
  source: 'im' | 'web' = 'im',
): Promise<AccessCheck> {
  const { rows } = await getPool().query(
    `SELECT * FROM product_line_im_triggers
      WHERE product_line_id = $1 AND im_trigger_key = $2 AND env_name IN ($3, '*')
      ORDER BY (env_name = $3) DESC LIMIT 1`,
    [productLineId, imTriggerKey, envName],
  )
  if (rows.length === 0) return { allowed: false, reason: 'not-configured' }
  const r = mapRow(rows[0])
  if (!r.enabled) return { allowed: false, reason: 'disabled' }
  if (!r.allowedRoles.includes(role)) return { allowed: false, reason: 'role-not-allowed' }
  if (!r.triggerSources.includes(source)) return { allowed: false, reason: 'source-blocked' }
  return { allowed: true }
}

export interface SetIMTriggerInput {
  imTriggerKey: string
  envName: string
  enabled: boolean
  allowedRoles: string[]
  triggerSources?: string[]
  approvalRuleId?: number | null
}

export async function batchSetProductLineIMTriggers(productLineId: number, items: SetIMTriggerInput[]): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    for (const it of items) {
      await client.query(
        `INSERT INTO product_line_im_triggers
           (product_line_id, im_trigger_key, env_name, enabled, allowed_roles, trigger_sources, approval_rule_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         ON CONFLICT (product_line_id, im_trigger_key, env_name) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           allowed_roles = EXCLUDED.allowed_roles,
           trigger_sources = EXCLUDED.trigger_sources,
           approval_rule_id = EXCLUDED.approval_rule_id`,
        [productLineId, it.imTriggerKey, it.envName, it.enabled,
         JSON.stringify(it.allowedRoles), JSON.stringify(it.triggerSources ?? ['im','web']),
         it.approvalRuleId ?? null],
      )
    }
    await client.query('COMMIT')
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}
