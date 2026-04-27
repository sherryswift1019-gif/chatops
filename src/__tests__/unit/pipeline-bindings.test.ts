import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  upsertPipelineBinding,
  getPipelineBinding,
  listPipelineBindings,
  deletePipelineBinding,
  resolvePipelineForTrigger,
} from '../../db/repositories/pipeline-bindings.js'

async function seedFixture(): Promise<{ productLineId: number; pipelineId: number }> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO product_lines (name, display_name, description) VALUES ('pl-test', 'PL Test', '')`,
  )
  const plRes = await pool.query(`SELECT id FROM product_lines WHERE name='pl-test'`)
  const productLineId = plRes.rows[0].id

  const pipelineRes = await pool.query(
    `INSERT INTO test_pipelines (name, description, graph, trigger_params, enabled, server_roles, variables, stages, product_line_id)
     VALUES ('test-p', '', '{"nodes":[],"edges":[]}'::jsonb, '{}'::jsonb, true, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, NULL)
     RETURNING id`,
  )
  return { productLineId, pipelineId: pipelineRes.rows[0].id }
}

describe('pipeline-bindings repository', () => {
  beforeEach(async () => {
    await resetTestDb()
  })

  it('upsertPipelineBinding 创建 → getPipelineBinding 命中', async () => {
    const fx = await seedFixture()
    await upsertPipelineBinding({
      productLineId: fx.productLineId,
      refKey: 'fix_bug_l1',
      pipelineId: fx.pipelineId,
      serverRoleAssignments: { web: ['srv-1', 'srv-2'] },
      description: 'test',
    })
    const got = await getPipelineBinding(fx.productLineId, 'fix_bug_l1')
    expect(got).not.toBeNull()
    expect(got!.pipelineId).toBe(fx.pipelineId)
    expect(got!.serverRoleAssignments).toEqual({ web: ['srv-1', 'srv-2'] })
  })

  it('upsertPipelineBinding 重复 key → 更新 (ON CONFLICT)', async () => {
    const fx = await seedFixture()
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l1', pipelineId: fx.pipelineId,
      serverRoleAssignments: {}, description: 'v1',
    })
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l1', pipelineId: fx.pipelineId,
      serverRoleAssignments: { web: ['x'] }, description: 'v2',
    })
    const got = await getPipelineBinding(fx.productLineId, 'fix_bug_l1')
    expect(got!.serverRoleAssignments).toEqual({ web: ['x'] })
    expect(got!.description).toBe('v2')
  })

  it('listPipelineBindings filter by productLineId', async () => {
    const fx = await seedFixture()
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l1',
      pipelineId: fx.pipelineId, serverRoleAssignments: {}, description: '',
    })
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l2',
      pipelineId: fx.pipelineId, serverRoleAssignments: {}, description: '',
    })
    const list = await listPipelineBindings({ productLineId: fx.productLineId })
    expect(list).toHaveLength(2)
  })

  it('deletePipelineBinding 删除', async () => {
    const fx = await seedFixture()
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l1',
      pipelineId: fx.pipelineId, serverRoleAssignments: {}, description: '',
    })
    await deletePipelineBinding(fx.productLineId, 'fix_bug_l1')
    const got = await getPipelineBinding(fx.productLineId, 'fix_bug_l1')
    expect(got).toBeNull()
  })

  it('resolvePipelineForTrigger 命中', async () => {
    const fx = await seedFixture()
    await upsertPipelineBinding({
      productLineId: fx.productLineId, refKey: 'fix_bug_l1', pipelineId: fx.pipelineId,
      serverRoleAssignments: { web: ['srv-1'] }, description: '',
    })
    const res = await resolvePipelineForTrigger(fx.productLineId, 'fix_bug_l1')
    expect(res).toEqual({ pipelineId: fx.pipelineId, serverRoleAssignments: { web: ['srv-1'] } })
  })

  it('resolvePipelineForTrigger 未命中返回 null', async () => {
    const fx = await seedFixture()
    const res = await resolvePipelineForTrigger(fx.productLineId, 'no_such_key')
    expect(res).toBeNull()
  })
})
