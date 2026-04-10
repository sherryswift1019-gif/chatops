import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

let testPool: Pool | null = null

export function getTestPool(): Pool {
  if (!testPool) {
    testPool = new Pool({ connectionString: process.env.DATABASE_URL })
  }
  return testPool
}

export async function resetTestDb(): Promise<void> {
  const pool = getTestPool()
  const schema = readFileSync(join(process.cwd(), 'src/db/schema.sql'), 'utf8')
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await pool.query(schema)
}
