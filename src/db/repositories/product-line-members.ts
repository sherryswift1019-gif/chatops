import { getPool } from '../client.js'

export interface ProductLineMember {
  id: number
  productLineId: number
  userId: string
  userName: string
  role: 'developer' | 'tester' | 'ops' | 'admin'
  createdAt: Date
}

function mapRow(r: Record<string, unknown>): ProductLineMember {
  return {
    id: r.id as number, productLineId: r.product_line_id as number,
    userId: r.user_id as string, userName: r.user_name as string,
    role: r.role as 'developer' | 'tester' | 'ops' | 'admin', createdAt: r.created_at as Date,
  }
}

export async function listMembers(productLineId: number): Promise<ProductLineMember[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM product_line_members WHERE product_line_id = $1 ORDER BY id', [productLineId]
  )
  return rows.map(mapRow)
}

export async function addMember(
  data: Pick<ProductLineMember, 'productLineId' | 'userId' | 'userName' | 'role'>
): Promise<ProductLineMember> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO product_line_members (product_line_id, user_id, user_name, role)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [data.productLineId, data.userId, data.userName, data.role]
  )
  return mapRow(rows[0])
}

export async function updateMemberRole(id: number, role: 'developer' | 'tester' | 'ops' | 'admin'): Promise<ProductLineMember | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    'UPDATE product_line_members SET role = $2 WHERE id = $1 RETURNING *', [id, role]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function removeMember(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM product_line_members WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}

export async function getMembershipsByUserId(userId: string): Promise<ProductLineMember[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM product_line_members WHERE user_id = $1 ORDER BY product_line_id', [userId]
  )
  return rows.map(mapRow)
}
