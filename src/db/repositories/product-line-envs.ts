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

export interface ServerRefConnectionConfig {
  serverIds: number[]
}

export type ConnectionConfig = DockerConnectionConfig | K8sConnectionConfig | ServerRefConnectionConfig | Record<string, unknown>

export interface ProductLineEnv {
  id: number
  productLineId: number
  envId: number
  runtime: 'kubernetes' | 'docker'
  namespace: string
  enabled: boolean
  connectionConfig: ConnectionConfig
  defaultBranch: string
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
    defaultBranch: (r.default_branch ?? '') as string,
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
    Partial<Pick<ProductLineEnv, 'namespace' | 'enabled' | 'connectionConfig' | 'defaultBranch'>>
): Promise<ProductLineEnv> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO product_line_envs (product_line_id, env_id, runtime, namespace, enabled, connection_config, default_branch)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (product_line_id, env_id) DO UPDATE
     SET runtime = $3, namespace = $4, enabled = $5, connection_config = $6, default_branch = $7
     RETURNING *`,
    [data.productLineId, data.envId, data.runtime, data.namespace ?? '',
     data.enabled ?? true, JSON.stringify(data.connectionConfig ?? {}),
     data.defaultBranch ?? '']
  )
  return mapRow(rows[0])
}

export async function batchSetProductLineEnvs(
  productLineId: number,
  envs: Array<Pick<ProductLineEnv, 'envId' | 'runtime'> &
    Partial<Pick<ProductLineEnv, 'namespace' | 'enabled' | 'connectionConfig' | 'defaultBranch'>>>
): Promise<ProductLineEnv[]> {
  // 校验：同一产线内 Docker 模式环境不能共享服务器
  const serverEnvMap = new Map<number, number[]>()
  for (const env of envs) {
    if (env.runtime !== 'docker') continue
    const cfg = env.connectionConfig as Record<string, unknown> | undefined
    const ids = Array.isArray(cfg?.serverIds) ? (cfg.serverIds as number[]) : []
    for (const sid of ids) {
      if (!serverEnvMap.has(sid)) serverEnvMap.set(sid, [])
      serverEnvMap.get(sid)!.push(env.envId)
    }
  }
  const duplicates = [...serverEnvMap.entries()].filter(([, envIds]) => envIds.length > 1)
  if (duplicates.length > 0) {
    const err = new Error('服务器不能同时分配给多个环境') as Error & { statusCode: number; duplicates: Array<[number, number[]]> }
    err.statusCode = 400
    err.duplicates = duplicates
    throw err
  }

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM product_line_envs WHERE product_line_id = $1', [productLineId])
    const results: ProductLineEnv[] = []
    for (const env of envs) {
      const { rows } = await client.query(
        `INSERT INTO product_line_envs (product_line_id, env_id, runtime, namespace, enabled, connection_config, default_branch)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [productLineId, env.envId, env.runtime, env.namespace ?? '',
         env.enabled ?? true, JSON.stringify(env.connectionConfig ?? {}),
         env.defaultBranch ?? '']
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
