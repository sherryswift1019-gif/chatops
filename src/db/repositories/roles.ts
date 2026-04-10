import { getPool } from '../client.js'

export type Role = 'developer' | 'ops' | 'admin'

export interface UserRole {
  id: number
  platform: string
  userId: string
  userName: string
  role: Role
  groupId: string
  createdBy: string
  createdAt: Date
}

export async function upsertRole(data: Omit<UserRole, 'id' | 'createdAt'>): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO user_roles (platform, user_id, user_name, role, group_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (platform, user_id, group_id) DO UPDATE
     SET role=$4, user_name=$3, created_by=$6`,
    [data.platform, data.userId, data.userName, data.role, data.groupId, data.createdBy]
  )
}

export async function getUserRole(platform: string, userId: string, groupId: string): Promise<Role | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT role FROM user_roles WHERE platform=$1 AND user_id=$2 AND group_id=$3`,
    [platform, userId, groupId]
  )
  return rows[0]?.role ?? null
}
