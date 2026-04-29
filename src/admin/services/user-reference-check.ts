import { getPool } from '../../db/client.js'

export interface ReferenceEntry {
  table: string
  label: string
  count: number
}

export interface UserReferenceResult {
  blocked: boolean
  references: ReferenceEntry[]
}

export async function checkUserActiveReferences(userId: string): Promise<UserReferenceResult> {
  const pool = getPool()

  const checks = await Promise.all([
    pool.query(
      'SELECT COUNT(*) AS count FROM user_roles WHERE user_id = $1',
      [userId]
    ).then(r => ({ table: 'user_roles', label: '角色分配', count: parseInt(r.rows[0].count, 10) })),

    pool.query(
      'SELECT COUNT(*) AS count FROM product_line_members WHERE user_id = $1',
      [userId]
    ).then(r => ({ table: 'product_line_members', label: '产品线成员', count: parseInt(r.rows[0].count, 10) })),

    pool.query(
      "SELECT COUNT(*) AS count FROM projects WHERE owner_id = $1 AND owner_id != ''",
      [userId]
    ).then(r => ({ table: 'projects', label: '项目负责人', count: parseInt(r.rows[0].count, 10) })),

    pool.query(
      `SELECT COUNT(*) AS count FROM approval_rules
       WHERE primary_approvers @> jsonb_build_array($1::text)
          OR backup_approvers @> jsonb_build_array($1::text)`,
      [userId]
    ).then(r => ({ table: 'approval_rules', label: '审批规则', count: parseInt(r.rows[0].count, 10) })),
  ])

  const references = checks.filter(c => c.count > 0)
  return { blocked: references.length > 0, references }
}
