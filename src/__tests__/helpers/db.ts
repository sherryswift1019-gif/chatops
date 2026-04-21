import { Pool } from 'pg'
import { readFileSync } from 'fs'
import { join } from 'path'

// Vitest setup file: ensures tool modules that transitively load src/config.ts
// can be imported in unit tests without a real DATABASE_URL in the environment.
// Integration tests that actually talk to Postgres must set their own URL.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/chatops_test'
}

// Pipeline executor resolves TEST_DATA_DIR at module-load time; must be set
// before any pipeline import, which happens before any beforeAll().
if (!process.env.TEST_DATA_DIR) {
  process.env.TEST_DATA_DIR = '/tmp/chatops-test-runs'
}

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
  'schema-v10.sql',
  'schema-v11.sql',
  'schema-v14.sql',
  'schema-v15.sql',
]

export async function resetTestDb(): Promise<void> {
  const pool = getTestPool()
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  for (const file of SCHEMA_FILES) {
    const sql = readFileSync(join(process.cwd(), 'src/db', file), 'utf8')
    await pool.query(sql)
  }
}
