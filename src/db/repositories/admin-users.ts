import { getPool } from '../client.js'

export interface AdminUser {
  id: number
  username: string
  passwordHash: string
  mustChangePassword: boolean
  lastLoginAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function mapRow(r: Record<string, unknown>): AdminUser {
  return {
    id: r.id as number,
    username: r.username as string,
    passwordHash: r.password_hash as string,
    mustChangePassword: r.must_change_password as boolean,
    lastLoginAt: (r.last_login_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  }
}

export async function getAdminUserByUsername(username: string): Promise<AdminUser | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updateAdminPassword(username: string, newHash: string): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE admin_users
       SET password_hash = $2,
           must_change_password = FALSE,
           updated_at = NOW()
     WHERE username = $1`,
    [username, newHash]
  )
}

export async function updateAdminLastLogin(username: string): Promise<void> {
  const pool = getPool()
  await pool.query(
    `UPDATE admin_users SET last_login_at = NOW(), updated_at = NOW() WHERE username = $1`,
    [username]
  )
}
