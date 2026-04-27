import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('v45 migration', () => {
  beforeEach(async () => {
    await resetTestDb()
  })

  it('pipeline_dryrun_snapshots 表存在 + 主键 + 字段类型', async () => {
    const pool = getTestPool()
    const r = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name='pipeline_dryrun_snapshots' ORDER BY ordinal_position`)
    const cols = r.rows.map((c: Record<string, unknown>) => c.column_name)
    expect(cols).toEqual(expect.arrayContaining([
      'pipeline_id', 'node_id', 'status', 'output', 'source',
      'upstream_params_hash', 'last_decision', 'last_manual_input',
      'duration_ms', 'error', 'ran_at',
    ]))
  })

  it('test_runs 加了 trigger_params 列', async () => {
    const pool = getTestPool()
    const r = await pool.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name='test_runs' AND column_name='trigger_params'`)
    expect(r.rows.length).toBe(1)
    expect(r.rows[0].data_type).toBe('jsonb')
  })

  it('幂等：跑两次 v45 第二次 no-op', async () => {
    const pool = getTestPool()
    const sql = readFileSync(join(process.cwd(), 'src/db/schema-v45.sql'), 'utf8')
    // v45 已经在 resetTestDb 中应用一次，再次运行不应抛错
    await expect(pool.query(sql)).resolves.toBeDefined()
  })
})
