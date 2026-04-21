/**
 * Integration: capabilities.defaultPipelineId binding CRUD
 *
 * 验证 schema-v17 新增的 default_pipeline_id 字段能正确读写。
 * 建立 IM → Pipeline 入口绑定所依赖的数据层契约。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  createCapability,
  getCapabilityByKey,
  updateCapabilityPipelineBinding,
} from '../../db/repositories/capabilities.js'

async function insertMinimalPipeline(name: string): Promise<number> {
  const pool = getTestPool()
  const { rows: plRows } = await pool.query(
    `INSERT INTO product_lines (name, display_name) VALUES ($1, $1)
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    ['bind-test-pl'],
  )
  const productLineId = plRows[0].id
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, enabled)
     VALUES ($1, $2, '', '[]'::jsonb, '{}'::jsonb, true) RETURNING id`,
    [productLineId, name],
  )
  return rows[0].id
}

describe('capabilities.defaultPipelineId', () => {
  beforeAll(async () => {
    await resetTestDb()
  })

  it('defaults to null on new capability', async () => {
    const cap = await createCapability({
      key: 'bind-test-a',
      displayName: 'bind-test-a',
      description: '',
      category: 'action',
      toolNames: [],
      needsApproval: false,
    })
    expect(cap.defaultPipelineId).toBeNull()
  })

  it('updateCapabilityPipelineBinding sets and clears the binding', async () => {
    const cap = await createCapability({
      key: 'bind-test-b',
      displayName: 'bind-test-b',
      description: '',
      category: 'action',
      toolNames: [],
      needsApproval: false,
    })
    const pipelineId = await insertMinimalPipeline('bind-test-pipeline-1')

    const set = await updateCapabilityPipelineBinding(cap.id, pipelineId)
    expect(set?.defaultPipelineId).toBe(pipelineId)
    const got = await getCapabilityByKey('bind-test-b')
    expect(got?.defaultPipelineId).toBe(pipelineId)

    const cleared = await updateCapabilityPipelineBinding(cap.id, null)
    expect(cleared?.defaultPipelineId).toBeNull()
  })

  it('pipeline deletion sets binding to NULL (ON DELETE SET NULL)', async () => {
    const cap = await createCapability({
      key: 'bind-test-c',
      displayName: 'bind-test-c',
      description: '',
      category: 'action',
      toolNames: [],
      needsApproval: false,
    })
    const pipelineId = await insertMinimalPipeline('bind-test-pipeline-2')
    await updateCapabilityPipelineBinding(cap.id, pipelineId)

    const pool = getTestPool()
    await pool.query('DELETE FROM test_pipelines WHERE id = $1', [pipelineId])

    const got = await getCapabilityByKey('bind-test-c')
    expect(got?.defaultPipelineId).toBeNull()
  })
})
