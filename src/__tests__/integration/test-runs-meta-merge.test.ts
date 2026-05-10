/**
 * appendStageResult.meta 浅合并集成测（v3 灰度路由 + 健康指标缓存）
 *
 * 背景：M3.3 让 graph-builder 通过 appendStageResult 的 meta 字段缓存
 *   - usesV3Summary（灰度路由决定，跨轮一致）
 *   - zodParseStatus / reviewHintsCount / confidenceLevel（健康指标）
 *
 * 关键不变量：每轮 appendStageResult 的 metaPatch 必须**浅合并**到既有 stage.meta，
 * 不能覆盖丢失（重复 P0-2 bug 类型；参 [graph-state.ts:19-39] 浅合并语义）。
 *
 * 不直接跑 graph-builder（依赖 LangGraph + skillExecutor mock）；这里只验证
 * appendStageResult 的 meta merge 行为正确，graph-builder 集成由 e2e 冒烟覆盖。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { appendStageResult } from '../../db/repositories/test-runs.js'
import type { StageResult } from '../../db/repositories/test-runs.js'

async function seedProductLine(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('meta-merge-test', 'Meta Merge Test', '')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
  )
  return rows[0].id as number
}

async function seedPipeline(plId: number): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (name, description, stages, product_line_id)
     VALUES ($1, '', '[]'::jsonb, $2) RETURNING id`,
    [`meta-pipe-${Date.now()}-${Math.random()}`, plId],
  )
  return rows[0].id as number
}

async function seedTestRun(pipelineId: number): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO test_runs (pipeline_id, trigger_type, triggered_by, servers, status, started_at, stage_results)
     VALUES ($1, 'api', 'meta-test', '{}'::jsonb, 'running', NOW(), '[]'::jsonb)
     RETURNING id`,
    [pipelineId],
  )
  return rows[0].id as number
}

async function readStageResults(runId: number): Promise<StageResult[]> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    'SELECT stage_results FROM test_runs WHERE id = $1',
    [runId],
  )
  return (rows[0]?.stage_results ?? []) as StageResult[]
}

let pipelineId = 0
let runId = 0

beforeEach(async () => {
  await resetTestDb()
  const plId = await seedProductLine()
  pipelineId = await seedPipeline(plId)
  runId = await seedTestRun(pipelineId)
})

describe('appendStageResult.meta 浅合并（v3 灰度健康指标缓存）', () => {
  it('第一次写 meta：所有 key 都进 stage.meta', async () => {
    await appendStageResult(runId, 0, {
      round: 1,
      decision: 'pass',
      summary: 'spec round 1',
      meta: { usesV3Summary: true, zodParseStatus: 'success', reviewHintsCount: 2 },
    })
    const sr = await readStageResults(runId)
    expect(sr[0]?.meta).toEqual({
      usesV3Summary: true,
      zodParseStatus: 'success',
      reviewHintsCount: 2,
    })
  })

  it('第二轮 metaPatch 只含部分 key：保留原有 key + 加新 key（浅合并）', async () => {
    await appendStageResult(runId, 0, {
      round: 1,
      decision: 'pass',
      summary: 'r1',
      meta: { usesV3Summary: true, zodParseStatus: 'success' },
    })
    await appendStageResult(runId, 0, {
      round: 2,
      decision: 'pass',
      summary: 'r2',
      meta: { reviewHintsCount: 5, confidenceLevel: 'high' },
    })
    const sr = await readStageResults(runId)
    expect(sr[0]?.meta).toEqual({
      usesV3Summary: true,        // ← 保留 round 1 的（关键：灰度路由跨轮一致性）
      zodParseStatus: 'success',  // ← 保留 round 1 的
      reviewHintsCount: 5,        // ← round 2 新加
      confidenceLevel: 'high',    // ← round 2 新加
    })
  })

  it('同 key 重复写：后写覆盖前写（语义符合 patch 而非追加）', async () => {
    await appendStageResult(runId, 0, {
      round: 1,
      decision: 'pass',
      summary: 'r1',
      meta: { zodParseStatus: 'success', reviewHintsCount: 3 },
    })
    await appendStageResult(runId, 0, {
      round: 2,
      decision: 'pass',
      summary: 'r2',
      meta: { zodParseStatus: 'failed', reviewHintsCount: 0 },
    })
    const sr = await readStageResults(runId)
    expect(sr[0]?.meta?.zodParseStatus).toBe('failed')
    expect(sr[0]?.meta?.reviewHintsCount).toBe(0)
  })

  it('meta 缺失（不传 meta）时既有 stage.meta 不被清空（关键防 P0-2 bug）', async () => {
    await appendStageResult(runId, 0, {
      round: 1,
      decision: 'pass',
      summary: 'r1',
      meta: { usesV3Summary: true, reviewHintsCount: 4 },
    })
    // 第二次不传 meta：模拟 graph-builder 在某些路径下不带 metaPatch
    await appendStageResult(runId, 0, {
      round: 2,
      decision: 'pass',
      summary: 'r2',
      // 故意不传 meta 字段
    })
    const sr = await readStageResults(runId)
    expect(sr[0]?.meta).toEqual({
      usesV3Summary: true,
      reviewHintsCount: 4,
    })
  })

  it('rounds[] 数组与 meta 顶层独立：rounds 累加，meta 浅合并', async () => {
    await appendStageResult(runId, 0, {
      round: 1,
      decision: 'pass',
      summary: 'r1',
      meta: { usesV3Summary: true },
    })
    await appendStageResult(runId, 0, {
      round: 2,
      decision: 'pass',
      summary: 'r2',
      meta: { reviewHintsCount: 5 },
    })
    const sr = await readStageResults(runId)
    expect(sr[0]?.rounds).toHaveLength(2)
    expect(sr[0]?.rounds?.[0]?.round).toBe(1)
    expect(sr[0]?.rounds?.[1]?.round).toBe(2)
    expect(sr[0]?.meta).toEqual({
      usesV3Summary: true,
      reviewHintsCount: 5,
    })
  })

  it('skillOutput / acDiff 与 meta 同时 patch：各字段独立合并', async () => {
    await appendStageResult(runId, 0, {
      round: 1,
      decision: 'pass',
      summary: 'r1',
      skillOutput: { acceptanceCriteria: [{ id: 'AC-1', text: 'old' }] },
      meta: { usesV3Summary: true },
    })
    await appendStageResult(runId, 0, {
      round: 2,
      decision: 'pass',
      summary: 'r2',
      skillOutput: { acceptanceCriteria: [{ id: 'AC-1', text: 'new' }, { id: 'AC-2', text: 'added' }] },
      acDiff: {
        added: [{ id: 'AC-2', text: 'added' }],
        removed: [],
        changed: [{ id: 'AC-1', oldText: 'old', newText: 'new' }],
      },
      meta: { reviewHintsCount: 1 },
    })
    const sr = await readStageResults(runId)
    expect((sr[0]?.skillOutput as { acceptanceCriteria: unknown[] }).acceptanceCriteria).toHaveLength(2)
    expect(sr[0]?.acDiff?.added).toHaveLength(1)
    expect(sr[0]?.meta).toEqual({
      usesV3Summary: true,    // 保留 round 1
      reviewHintsCount: 1,    // round 2 新加
    })
  })
})
