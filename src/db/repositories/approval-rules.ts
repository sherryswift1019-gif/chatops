import { getPool } from '../client.js'

export interface ApprovalRule {
  id: number
  productLineId: number | null
  imTriggerKey: string  // schema-v32: action → im_trigger_key
  env: string
  primaryApprovers: string[]
  backupApprovers: string[]
  primaryTimeoutMin: number
  totalTimeoutMin: number
}

function mapRow(r: Record<string, unknown>): ApprovalRule {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number | null,
    imTriggerKey: r.im_trigger_key as string,
    env: r.env as string,
    primaryApprovers: r.primary_approvers as string[],
    backupApprovers: r.backup_approvers as string[],
    primaryTimeoutMin: r.primary_timeout_min as number,
    totalTimeoutMin: r.total_timeout_min as number,
  }
}

export async function getApprovalRules(productLineId?: number): Promise<ApprovalRule[]> {
  const pool = getPool()
  if (productLineId !== undefined) {
    const { rows } = await pool.query(
      'SELECT * FROM approval_rules WHERE product_line_id = $1 ORDER BY id',
      [productLineId]
    )
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM approval_rules ORDER BY id')
  return rows.map(mapRow)
}

export async function insertApprovalRule(
  rule: Omit<ApprovalRule, 'id'>
): Promise<ApprovalRule> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO approval_rules
       (product_line_id, im_trigger_key, env, primary_approvers, backup_approvers, primary_timeout_min, total_timeout_min)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      rule.productLineId ?? null, rule.imTriggerKey, rule.env,
      JSON.stringify(rule.primaryApprovers), JSON.stringify(rule.backupApprovers),
      rule.primaryTimeoutMin, rule.totalTimeoutMin,
    ]
  )
  return mapRow(rows[0])
}

export async function updateApprovalRule(
  id: number,
  data: Partial<Omit<ApprovalRule, 'id'>>
): Promise<ApprovalRule | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE approval_rules SET
       product_line_id = COALESCE($2, product_line_id),
       im_trigger_key = COALESCE($3, im_trigger_key),
       env = COALESCE($4, env),
       primary_approvers = COALESCE($5, primary_approvers),
       backup_approvers = COALESCE($6, backup_approvers),
       primary_timeout_min = COALESCE($7, primary_timeout_min),
       total_timeout_min = COALESCE($8, total_timeout_min)
     WHERE id = $1 RETURNING *`,
    [
      id,
      data.productLineId ?? null,
      data.imTriggerKey ?? null,
      data.env ?? null,
      data.primaryApprovers ? JSON.stringify(data.primaryApprovers) : null,
      data.backupApprovers ? JSON.stringify(data.backupApprovers) : null,
      data.primaryTimeoutMin ?? null,
      data.totalTimeoutMin ?? null,
    ]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteApprovalRule(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM approval_rules WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
