import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { upsertPipelineBinding } from '../../db/repositories/pipeline-bindings.js'
import { handleAnalysisComplete } from '../../agent/coordinator.js'

async function seedSharedPipeline() {
  const pool = getTestPool()
  const pl1 = (await pool.query(`INSERT INTO product_lines (name, display_name, description) VALUES ('pl-1', '', '') RETURNING id`)).rows[0].id
  const pl2 = (await pool.query(`INSERT INTO product_lines (name, display_name, description) VALUES ('pl-2', '', '') RETURNING id`)).rows[0].id

  const pipelineId = (await pool.query(
    `INSERT INTO test_pipelines (name, description, graph, trigger_params, enabled, server_roles, variables, stages, product_line_id)
     VALUES ('shared-l3', '', '{"nodes":[],"edges":[]}'::jsonb, '{}'::jsonb, true, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, NULL) RETURNING id`,
  )).rows[0].id

  await upsertPipelineBinding({ productLineId: pl1, refKey: 'fix_bug_l3', pipelineId, serverRoleAssignments: {}, description: '' })
  await upsertPipelineBinding({ productLineId: pl2, refKey: 'fix_bug_l3', pipelineId, serverRoleAssignments: {}, description: '' })

  return { pl1, pl2, pipelineId }
}

describe('pipeline 解绑产线 — 跨产线复用 + binding 路径', () => {
  beforeEach(async () => { await resetTestDb() })

  it('binding 不存在 → handleAnalysisComplete 标 aborted', async () => {
    const pool = getTestPool()
    const pl = (await pool.query(`INSERT INTO product_lines (name, display_name, description) VALUES ('pl-noref', '', '') RETURNING id`)).rows[0].id

    const reportId = (await pool.query(
      `INSERT INTO bug_analysis_reports (issue_id, issue_url, product_line_id, level, classification, confidence, confidence_score, root_cause_summary, solutions_json, status)
       VALUES (200, 'http://gl/200', $1, 'l3', 'bug', 'high', 0.9, 'rc', '[]'::jsonb, 'pending') RETURNING id`,
      [pl],
    )).rows[0].id

    await handleAnalysisComplete(reportId, 'l3', 'bug', 'u-trigger')

    const r = await pool.query(`SELECT status FROM bug_analysis_reports WHERE id = $1`, [reportId])
    expect(r.rows[0].status).toBe('aborted')
  })

  it('两个产线可独立绑定到同一 pipeline（跨产线复用）', async () => {
    const { pl1, pl2, pipelineId } = await seedSharedPipeline()
    const pool = getTestPool()

    // 验证两个产线都能解析到同一 pipeline
    const r1 = await pool.query(
      `SELECT pipeline_id FROM pipeline_bindings WHERE product_line_id = $1 AND ref_key = 'fix_bug_l3'`,
      [pl1],
    )
    const r2 = await pool.query(
      `SELECT pipeline_id FROM pipeline_bindings WHERE product_line_id = $1 AND ref_key = 'fix_bug_l3'`,
      [pl2],
    )
    expect(r1.rows[0].pipeline_id).toBe(pipelineId)
    expect(r2.rows[0].pipeline_id).toBe(pipelineId)
    // 同一 pipeline，跨产线共享
    expect(r1.rows[0].pipeline_id).toBe(r2.rows[0].pipeline_id)
  })
})
