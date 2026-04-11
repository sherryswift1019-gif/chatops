import { getPool } from '../client.js'

export interface SystemConfigEntry {
  key: string
  value: Record<string, unknown>
  updatedAt: Date
}

export async function getConfig(key: string): Promise<SystemConfigEntry | null> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM system_config WHERE key = $1', [key])
  if (!rows[0]) return null
  return { key: rows[0].key, value: rows[0].value, updatedAt: rows[0].updated_at }
}

export async function setConfig(key: string, value: Record<string, unknown>): Promise<SystemConfigEntry> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW() RETURNING *`,
    [key, JSON.stringify(value)]
  )
  return { key: rows[0].key, value: rows[0].value, updatedAt: rows[0].updated_at }
}

export async function getAllConfig(): Promise<SystemConfigEntry[]> {
  const pool = getPool()
  const { rows } = await pool.query('SELECT * FROM system_config ORDER BY key')
  return rows.map(r => ({ key: r.key, value: r.value, updatedAt: r.updated_at }))
}
