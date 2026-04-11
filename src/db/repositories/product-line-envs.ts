import { getPool } from '../client.js'

export interface DockerConnectionConfig {
  host: string
  port?: number
  username?: string
  password?: string
}

export interface K8sConnectionConfig {
  namespace: string
}

export type ConnectionConfig = DockerConnectionConfig | K8sConnectionConfig | Record<string, unknown>

export interface ProductLineEnv {
  id: number
  productLineId: number
  envId: number
  runtime: 'kubernetes' | 'docker'
  namespace: string
  enabled: boolean
  connectionConfig: ConnectionConfig
}

function mapRow(r: Record<string, unknown>): ProductLineEnv {
  return {
    id: r.id as number,
    productLineId: r.product_line_id as number,
    envId: r.env_id as number,
    runtime: r.runtime as 'kubernetes' | 'docker',
    namespace: r.namespace as string,
    enabled: r.enabled as boolean,
    connectionConfig: (r.connection_config ?? {}) as ConnectionConfig,
  }
}

export async function listProductLineEnvs(productLineId: number): Promise<ProductLineEnv[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    'SELECT * FROM product_line_envs WHERE product_line_id = $1 ORDER BY id', [productLineId]
  )
  return rows.map(mapRow)
}

export async function upsertProductLineEnv(
  data: Pick<ProductLineEnv, 'productLineId' | 'envId' | 'runtime'> &
    Partial<Pick<ProductLineEnv, 'namespace' | 'enabled' | 'connectionConfig'>>
): Promise<ProductLineEnv> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO product_line_envs (product_line_id, env_id, runtime, namespace, enabled, connection_config)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (product_line_id, env_id) DO UPDATE
     SET runtime = $3, namespace = $4, enabled = $5, connection_config = $6
     RETURNING *`,
    [data.productLineId, data.envId, data.runtime, data.namespace ?? '',
     data.enabled ?? true, JSON.stringify(data.connectionConfig ?? {})]
  )
  return mapRow(rows[0])
}

export async function batchSetProductLineEnvs(
  productLineId: number,
  envs: Array<Pick<ProductLineEnv, 'envId' | 'runtime'> &
    Partial<Pick<ProductLineEnv, 'namespace' | 'enabled' | 'connectionConfig'>>>
): Promise<ProductLineEnv[]> {
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM product_line_envs WHERE product_line_id = $1', [productLineId])
    const results: ProductLineEnv[] = []
    for (const env of envs) {
      const { rows } = await client.query(
        `INSERT INTO product_line_envs (product_line_id, env_id, runtime, namespace, enabled, connection_config)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [productLineId, env.envId, env.runtime, env.namespace ?? '',
         env.enabled ?? true, JSON.stringify(env.connectionConfig ?? {})]
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

export async function deleteProductLineEnv(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM product_line_envs WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}
