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

const SCHEMA_FILES = [
  'schema.sql',
  'schema-v2.sql',
  'schema-v3.sql',
  'schema-v4.sql',
  'schema-v5.sql',
  'schema-v6.sql',
  'schema-v7.sql',
  'schema-v8.sql',
  'schema-v9.sql',
  'schema-v11.sql',
  'schema-v12.sql',
]

export async function resetTestDb(): Promise<void> {
  const pool = getTestPool()
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  for (const file of SCHEMA_FILES) {
    const sql = readFileSync(join(process.cwd(), 'src/db', file), 'utf8')
    await pool.query(sql)
  }
}
