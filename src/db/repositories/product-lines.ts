import { getPool } from '../client.js'

export interface ProductLine {
  id: number
  name: string
  displayName: string
  description: string
  dingtalkGroupId: string
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): ProductLine {
  return {
    id: r.id as number, name: r.name as string,
    displayName: r.display_name as string, description: r.description as string,
    dingtalkGroupId: (r.dingtalk_group_id ?? '') as string,
    createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
  }
}

export async function listProductLines(): Promise<ProductLine[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM product_lines ORDER BY id')
  return rows.map(mapRow)
}

export async function getProductLineById(id: number): Promise<ProductLine | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM product_lines WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createProductLine(
  data: Pick<ProductLine, 'name' | 'displayName' | 'description'>
): Promise<ProductLine> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description) VALUES ($1, $2, $3) RETURNING *`,
    [data.name, data.displayName, data.description ?? '']
  )
  return mapRow(rows[0])
}

export async function updateProductLine(
  id: number, data: Partial<Pick<ProductLine, 'name' | 'displayName' | 'description' | 'dingtalkGroupId'>>
): Promise<ProductLine | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE product_lines SET name = COALESCE($2, name), display_name = COALESCE($3, display_name),
     description = COALESCE($4, description), dingtalk_group_id = COALESCE($5, dingtalk_group_id),
     updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.displayName ?? null, data.description ?? null, data.dingtalkGroupId ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getProductLineByGroupId(groupId: string): Promise<ProductLine | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM product_lines WHERE dingtalk_group_id = $1', [groupId])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteProductLine(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM product_lines WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
