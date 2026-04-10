import { Pool } from 'pg'
import { config } from '../config.js'

let pool: Pool | null = null

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.DATABASE_URL })
  }
  return pool
}
