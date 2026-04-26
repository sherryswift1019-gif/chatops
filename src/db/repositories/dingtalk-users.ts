import { getPool } from '../client.js'

export interface DingTalkUser {
  userId: string
  name: string
  avatar: string
  department: string
  email: string | null
  syncedAt: Date
}

function mapRow(r: Record<string, unknown>): DingTalkUser {
  return {
    userId: r.user_id as string, name: r.name as string,
    avatar: r.avatar as string, department: r.department as string,
    email: (r.email as string | null) ?? null,
    syncedAt: r.synced_at as Date,
  }
}

export async function listDingTalkUsers(keyword?: string): Promise<DingTalkUser[]> {
  const pool = getPool()
  if (keyword) {
    const { rows } = await pool.query(
      `SELECT * FROM dingtalk_users WHERE name ILIKE $1 OR user_id ILIKE $1 OR department ILIKE $1
       ORDER BY name LIMIT 50`,
      [`%${keyword}%`]
    )
    return rows.map(mapRow)
  }
  const { rows } = await pool.query('SELECT * FROM dingtalk_users ORDER BY name LIMIT 200')
  return rows.map(mapRow)
}

export async function upsertDingTalkUser(
  data: Pick<DingTalkUser, 'userId' | 'name'> & Partial<Pick<DingTalkUser, 'avatar' | 'department'>> & { email?: string }
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO dingtalk_users (user_id, name, avatar, department, email, synced_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       name = $2, avatar = $3, department = $4,
       email = COALESCE($5, dingtalk_users.email),
       synced_at = NOW()`,
    [data.userId, data.name, data.avatar ?? '', data.department ?? '', data.email ?? null]
  )
}

export async function getDingTalkUserById(userId: string): Promise<DingTalkUser | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM dingtalk_users WHERE user_id = $1', [userId])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getDingTalkUsersByIds(userIds: string[]): Promise<Map<string, DingTalkUser>> {
  if (userIds.length === 0) return new Map()
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM dingtalk_users WHERE user_id = ANY($1)', [userIds])
  const map = new Map<string, DingTalkUser>()
  for (const r of rows) {
    const u = mapRow(r)
    map.set(u.userId, u)
  }
  return map
}

export async function getDingTalkUserCount(): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT COUNT(*) AS count FROM dingtalk_users')
  return parseInt(rows[0].count, 10)
}

export async function listDingTalkUsersPaged(
  keyword: string | null,
  page: number,
  limit: number
): Promise<{ data: DingTalkUser[]; total: number }> {
  const pool = getPool()
  const offset = (page - 1) * limit
  const kw = keyword || null

  const [dataResult, countResult] = await Promise.all([
    pool.query(
      `SELECT * FROM dingtalk_users
       WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR user_id ILIKE '%' || $1 || '%' OR department ILIKE '%' || $1 || '%')
       ORDER BY name, user_id
       LIMIT $2 OFFSET $3`,
      [kw, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(*) AS count FROM dingtalk_users
       WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%' OR user_id ILIKE '%' || $1 || '%' OR department ILIKE '%' || $1 || '%')`,
      [kw]
    ),
  ])

  return {
    data: dataResult.rows.map(mapRow),
    total: parseInt(countResult.rows[0].count, 10),
  }
}
