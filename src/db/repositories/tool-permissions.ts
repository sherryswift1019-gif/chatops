import { getPool } from '../client.js'

export interface ToolPermission {
  id: number
  productLineId: number
  toolName: string
  envName: string
  allowedRoles: string[]
}

function mapRow(r: Record<string, unknown>): ToolPermission {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    toolName: r.tool_name as string,
    envName: r.env_name as string,
    allowedRoles: r.allowed_roles as string[],
  }
}

export async function getToolPermissions(productLineId: number): Promise<ToolPermission[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM tool_permissions WHERE product_line_id = $1 ORDER BY tool_name, env_name',
    [productLineId]
  )
  return rows.map(mapRow)
}

export async function setToolPermission(
  productLineId: number,
  toolName: string,
  envName: string,
  allowedRoles: string[]
): Promise<ToolPermission> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO tool_permissions (product_line_id, tool_name, env_name, allowed_roles)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (product_line_id, tool_name, env_name)
     DO UPDATE SET allowed_roles = $4
     RETURNING *`,
    [productLineId, toolName, envName, JSON.stringify(allowedRoles)]
  )
  return mapRow(rows[0])
}

export async function batchSetToolPermissions(
  productLineId: number,
  permissions: Array<{ toolName: string; envName: string; allowedRoles: string[] }>
): Promise<ToolPermission[]> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM tool_permissions WHERE product_line_id = $1', [productLineId])
    const results: ToolPermission[] = []
    for (const p of permissions) {
      const { rows } = await client.query(
        `INSERT INTO tool_permissions (product_line_id, tool_name, env_name, allowed_roles)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [productLineId, p.toolName, p.envName, JSON.stringify(p.allowedRoles)]
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

export async function deleteToolPermission(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM tool_permissions WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
