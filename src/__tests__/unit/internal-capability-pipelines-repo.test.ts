import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { getInternalPipelineId } from '../../db/repositories/internal-capability-pipelines.js'

/**
 * resetTestDb 跑完 SCHEMA_FILES 之后,test DB 处于"无 product_lines"状态,
 * schema-v37 seed 因 product_lines 为空而 skip,internal_capability_pipelines
 * 没有 request_handover 行。这里手动 bootstrap 一行 product_line + 重跑 v37 让 seed 生效。
 */
async function bootstrapHandoverPipeline(): Promise<void> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('pam', 'PAM', 'test')
     ON CONFLICT (name) DO NOTHING`,
  )
  const sql = readFileSync(
    join(process.cwd(), 'src/db/schema-v37.sql'),
    'utf8',
  )
  await pool.query(sql)
}

describe('internal-capability-pipelines repo', () => {
  beforeAll(async () => {
    await resetTestDb()
    await bootstrapHandoverPipeline()
  })

  it('getInternalPipelineId for seeded request_handover returns positive number', async () => {
    const id = await getInternalPipelineId('request_handover')
    expect(id).not.toBeNull()
    expect(id).toBeGreaterThan(0)
  })

  it('getInternalPipelineId for unknown capability returns null', async () => {
    expect(await getInternalPipelineId('nonexistent_xxx')).toBeNull()
  })
})
