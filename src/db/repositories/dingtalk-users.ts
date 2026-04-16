import { getPool } from '../client.js'

export interface DingTalkUser {
  userId: string
  name: string
  avatar: string
  department: string
  syncedAt: Date
}

function mapRow(r: Record<string, unknown>): DingTalkUser {
  return {
    userId: r.user_id as string, name: r.name as string,
    avatar: r.avatar as string, department: r.department as string,
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
  data: Pick<DingTalkUser, 'userId' | 'name'> & Partial<Pick<DingTalkUser, 'avatar' | 'department'>>
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO dingtalk_users (user_id, name, avatar, department, synced_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO UPDATE SET name = $2, avatar = $3, department = $4, synced_at = NOW()`,
    [data.userId, data.name, data.avatar ?? '', data.department ?? '']
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

export interface DingTalkUserPagedResult {
  items: DingTalkUser[]
  total: number
}

export async function listDingTalkUsersPaged(opts: {
  keyword?: string
  page?: number
  pageSize?: number
}): Promise<DingTalkUserPagedResult> {
  const pool = getPool()
  const page = Math.max(1, opts.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 20))
  const offset = (page - 1) * pageSize

  const whereParts: string[] = []
  const params: unknown[] = []

  if (opts.keyword) {
    params.push(`%${opts.keyword}%`)
    whereParts.push(`(name ILIKE $${params.length} OR user_id ILIKE $${params.length} OR department ILIKE $${params.length})`)
  }

  const where = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : ''

  const countResult = await pool.query(
    `SELECT COUNT(*) AS count FROM dingtalk_users ${where}`,
    params
  )
  const total = parseInt(countResult.rows[0].count, 10)

  params.push(pageSize)
  params.push(offset)
  const { rows } = await pool.query(
    `SELECT * FROM dingtalk_users ${where} ORDER BY name LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  )

  return { items: rows.map(mapRow), total }
}
