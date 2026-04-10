import { getPool } from '../client.js'

export interface ApprovalRule {
  id: number
  action: string
  env: string
  primaryApprovers: string[]
  backupApprovers: string[]
  primaryTimeoutMin: number
  totalTimeoutMin: number
}

export async function getApprovalRules(): Promise<ApprovalRule[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM approval_rules ORDER BY id')
  return rows.map(r => ({
    id: r.id,
    action: r.action,
    env: r.env,
    primaryApprovers: r.primary_approvers,
    backupApprovers: r.backup_approvers,
    primaryTimeoutMin: r.primary_timeout_min,
    totalTimeoutMin: r.total_timeout_min,
  }))
}

export async function insertApprovalRule(rule: Omit<ApprovalRule, 'id'>): Promise<ApprovalRule> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO approval_rules
       (action, env, primary_approvers, backup_approvers, primary_timeout_min, total_timeout_min)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [rule.action, rule.env,
     JSON.stringify(rule.primaryApprovers), JSON.stringify(rule.backupApprovers),
     rule.primaryTimeoutMin, rule.totalTimeoutMin]
  )
  return {
    id: rows[0].id,
    action: rows[0].action,
    env: rows[0].env,
    primaryApprovers: rows[0].primary_approvers,
    backupApprovers: rows[0].backup_approvers,
    primaryTimeoutMin: rows[0].primary_timeout_min,
    totalTimeoutMin: rows[0].total_timeout_min,
  }
}
