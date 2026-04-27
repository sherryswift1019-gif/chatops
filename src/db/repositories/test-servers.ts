import { getPool } from '../client.js'

export interface TestServer {
  id: number
  productLineId: number
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  credential: string
  role: string
  status: 'idle' | 'in_use' | 'offline'
  tags: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): TestServer {
  return {
    id: r.id as number, productLineId: r.product_line_id as number,
    name: r.name as string, host: r.host as string, port: r.port as number,
    username: r.username as string, authType: r.auth_type as 'password' | 'key',
    credential: r.credential as string, role: r.role as string,
    status: r.status as 'idle' | 'in_use' | 'offline',
    tags: (r.tags ?? {}) as Record<string, unknown>,
    createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
  }
}

export async function listTestServers(productLineId?: number): Promise<TestServer[]> {
  const pool = getPool()
  if (productLineId) {
    const { rows } = await pool.query('SELECT * FROM test_servers WHERE product_line_id = $1 ORDER BY id', [productLineId])
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM test_servers ORDER BY id')
  return rows.map(mapRow)
}

export async function getTestServerById(id: number): Promise<TestServer | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM test_servers WHERE id = $1', [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function createTestServer(data: {
  productLineId: number; name: string; host: string; port?: number
  username: string; authType?: 'password' | 'key'; credential: string; role: string
  tags?: Record<string, unknown>
}): Promise<TestServer> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO test_servers (product_line_id, name, host, port, username, auth_type, credential, role, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [data.productLineId, data.name, data.host, data.port ?? 22, data.username,
     data.authType ?? 'password', data.credential, data.role, JSON.stringify(data.tags ?? {})]
  )
  return mapRow(rows[0])
}

export async function updateTestServer(id: number, data: Partial<{
  name: string; host: string; port: number; username: string
  authType: 'password' | 'key'; credential: string; role: string
  status: 'idle' | 'in_use' | 'offline'; tags: Record<string, unknown>
}>): Promise<TestServer | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE test_servers SET
       name = COALESCE($2, name), host = COALESCE($3, host), port = COALESCE($4, port),
       username = COALESCE($5, username), auth_type = COALESCE($6, auth_type),
       credential = COALESCE($7, credential), role = COALESCE($8, role),
       status = COALESCE($9, status), tags = COALESCE($10, tags),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.host ?? null, data.port ?? null,
     data.username ?? null, data.authType ?? null, data.credential ?? null,
     data.role ?? null, data.status ?? null, data.tags ? JSON.stringify(data.tags) : null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function deleteTestServer(id: number): Promise<boolean> {
  const pool = getPool()
  const { rowCount } = await pool.query('DELETE FROM test_servers WHERE id = $1', [id])
  return (rowCount ?? 0) > 0
}

export async function setServerStatus(id: number, status: 'idle' | 'in_use' | 'offline'): Promise<void> {
  const pool = getPool()
  await pool.query('UPDATE test_servers SET status = $2, updated_at = NOW() WHERE id = $1', [id, status])
}

export async function listTestServersByIds(ids: number[]): Promise<TestServer[]> {
  if (ids.length === 0) return []
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT * FROM test_servers WHERE id = ANY($1::int[])`,
    [ids],
  )
  return rows.map(mapRow)
}

export async function bulkSetServerStatus(ids: number[], status: 'idle' | 'in_use' | 'offline'): Promise<void> {
  if (ids.length === 0) return
  const pool = getPool()
  await pool.query('UPDATE test_servers SET status = $2, updated_at = NOW() WHERE id = ANY($1)', [ids, status])
}
