import { getPool } from '../client.js'

export interface ProductLineCapability {
  id: number
  productLineId: number
  capabilityKey: string
  envName: string
  enabled: boolean
  allowedRoles: string[]
  triggerSources: string[]
}

function mapRow(r: Record<string, unknown>): ProductLineCapability {
  const rawSources = r.trigger_sources
  const triggerSources: string[] = Array.isArray(rawSources)
    ? (rawSources as unknown[]).map(String)
    : ['im', 'web']
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    capabilityKey: r.capability_key as string,
    envName: r.env_name as string,
    enabled: r.enabled as boolean,
    allowedRoles: r.allowed_roles as string[],
    triggerSources,
  }
}

export async function getProductLineCapabilities(productLineId: number): Promise<ProductLineCapability[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM product_line_capabilities WHERE product_line_id = $1 ORDER BY capability_key, env_name',
    [productLineId]
  )
  return rows.map(mapRow)
}

export async function checkCapabilityAccess(
  productLineId: number,
  capabilityKey: string,
  envName: string,
  userRole: string,
  source: 'im' | 'web' = 'im'
): Promise<{ allowed: boolean; reason?: string }> {
  const pool = getPool()

  // Check specific env first, then wildcard
  const { rows } = await pool.query(
    `SELECT * FROM product_line_capabilities
     WHERE product_line_id = $1 AND capability_key = $2 AND env_name IN ($3, '*')
     ORDER BY CASE WHEN env_name = $3 THEN 0 ELSE 1 END
     LIMIT 1`,
    [productLineId, capabilityKey, envName]
  )

  if (rows.length === 0) {
    // No config = not enabled for this product line
    return { allowed: false, reason: '该产线未配置此能力' }
  }

  const config = mapRow(rows[0])
  if (!config.enabled) {
    return { allowed: false, reason: '该能力在此环境未开放' }
  }
  if (!config.allowedRoles.includes(userRole)) {
    return { allowed: false, reason: '您的角色无权使用此能力' }
  }
  if (!config.triggerSources.includes(source)) {
    return { allowed: false, reason: 'source-blocked' }
  }

  return { allowed: true }
}

export async function batchSetProductLineCapabilities(
  productLineId: number,
  capabilities: Array<{
    capabilityKey: string
    envName: string
    enabled: boolean
    allowedRoles: string[]
    triggerSources?: string[]
  }>
): Promise<ProductLineCapability[]> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM product_line_capabilities WHERE product_line_id = $1', [productLineId])
    const results: ProductLineCapability[] = []
    for (const c of capabilities) {
      const sources = c.triggerSources ?? ['im', 'web']
      const { rows } = await client.query(
        `INSERT INTO product_line_capabilities
           (product_line_id, capability_key, env_name, enabled, allowed_roles, trigger_sources)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [productLineId, c.capabilityKey, c.envName, c.enabled, JSON.stringify(c.allowedRoles), JSON.stringify(sources)]
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
