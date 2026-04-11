import { getPool } from '../client.js'

export interface ToolPermission {
  id: number
  productLineId: number | null
  toolName: string
  minRole: 'developer' | 'ops' | 'admin'
}

function mapRow(r: Record<string, unknown>): ToolPermission {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number | null,
    toolName: r.tool_name as string,
    minRole: r.min_role as 'developer' | 'ops' | 'admin',
  }
}

export async function getToolPermissions(productLineId?: number): Promise<ToolPermission[]> {
  const pool = getPool()
  if (productLineId !== undefined) {
    const { rows } = await pool.query(
      'SELECT * FROM tool_permissions WHERE product_line_id = $1 ORDER BY tool_name',
      [productLineId]
    )
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM tool_permissions ORDER BY product_line_id, tool_name')
  return rows.map(mapRow)
}

export async function batchSetToolPermissions(
  productLineId: number,
  permissions: Array<{ toolName: string; minRole: 'developer' | 'ops' | 'admin' }>
): Promise<ToolPermission[]> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM tool_permissions WHERE product_line_id = $1', [productLineId])
    const results: ToolPermission[] = []
    for (const p of permissions) {
      const { rows } = await client.query(
        `INSERT INTO tool_permissions (product_line_id, tool_name, min_role)
         VALUES ($1, $2, $3) RETURNING *`,
        [productLineId, p.toolName, p.minRole]
      )
      results.push(mapRow(rows[0]))
    }
    await client.query('COMMIT')
    return results
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
