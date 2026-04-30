/**
 * stage-running-marker — integration tests for markStageRunning +
 * mergeAndPersistStageResults.
 *
 * 背景：build*Node 的 LangGraph callback 只在节点完成时返回一次 update。stage 跑
 * 期间 langgraph state 里没有该 stage 的 entry，admin Drawer 看不到 running
 * 状态。markStageRunning 在节点开头直写 DB；persistValues 改 merge 后，langgraph
 * state 不会把"跑中但 DB 已有的 running entry"覆盖丢失。
 *
 * 注：原来这是 unit test（mock test-runs repo），但 race-fix 之后 stage-status.ts
 * 直接通过 getPool() 拿 PoolClient + advisory lock + 事务，绕过了 repo helpers。
 * 测试也跟着升级成 integration（真 pg，一次性 testcontainer）以覆盖事务路径。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  markStageRunning,
  mergeAndPersistStageResults,
} from '../../pipeline/stage-status.js'
import type { StageResult } from '../../db/repositories/test-runs.js'

async function seedProductLine(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('marker-test', 'Marker Test', '')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
  )
  return rows[0].id as number
}

async function seedPipeline(productLineId: number): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (name, description, stages, product_line_id)
     VALUES ($1, '', '[]'::jsonb, $2) RETURNING id`,
    [`marker-pipe-${Date.now()}-${Math.random()}`, productLineId],
  )
  return rows[0].id as number
}

async function seedTestRun(
  pipelineId: number,
  initialStageResults: StageResult[] = [],
): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO test_runs (pipeline_id, trigger_type, triggered_by, servers, status, started_at, stage_results)
     VALUES ($1, 'api', 'marker', '{}'::jsonb, 'running', NOW(), $2::jsonb)
     RETURNING id`,
    [pipelineId, JSON.stringify(initialStageResults)],
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

let productLineId = 0

beforeEach(async () => {
  await resetTestDb()
  productLineId = await seedProductLine()
})

describe('markStageRunning', () => {
  it('写入 running entry 当 stage 不存在', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [])

    await markStageRunning(
      runId,
      { name: '清理', stageType: 'script' },
      '2026-04-29T00:00:00Z',
    )

    const stored = await readStageResults(runId)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      name: '清理',
      type: 'script',
      status: 'running',
      startedAt: '2026-04-29T00:00:00Z',
    })
  })

  it('不覆盖已 finalized 的 stage（success / failed / skipped）', async () => {
    const finalizedCases: Array<'success' | 'failed' | 'skipped'> = [
      'success',
      'failed',
      'skipped',
    ]
    for (const status of finalizedCases) {
      const pipelineId = await seedPipeline(productLineId)
      const runId = await seedTestRun(pipelineId, [
        { name: '清理', type: 'script', status, output: 'ok' },
      ])
      await markStageRunning(
        runId,
        { name: '清理', stageType: 'script' },
        '2026-04-29T00:00:00Z',
      )
      const stored = await readStageResults(runId)
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({ name: '清理', type: 'script', status })
      // helper 必须 no-op：原始字段一字不动
      expect((stored[0] as { output?: string }).output).toBe('ok')
    }
  })

  it('与既有其它 stage 共存，by-name merge 不影响 sibling', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [
      { name: 'A', type: 'script', status: 'success' },
    ])
    await markStageRunning(
      runId,
      { name: 'B', stageType: 'capability' },
      '2026-04-29T00:00:01Z',
    )
    const stored = await readStageResults(runId)
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({ name: 'A', status: 'success' })
    expect(stored[1]).toMatchObject({
      name: 'B',
      type: 'capability',
      status: 'running',
      startedAt: '2026-04-29T00:00:01Z',
    })
  })

  it('既有 running entry 时 markStageRunning 重复调用是 no-op（不刷 startedAt）', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [
      { name: 'X', type: 'script', status: 'running', startedAt: 'first' },
    ])
    await markStageRunning(runId, { name: 'X', stageType: 'script' }, 'second')
    const stored = await readStageResults(runId)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ status: 'running', startedAt: 'first' })
  })

  it('run 不存在时静默（不 throw）', async () => {
    await expect(
      markStageRunning(999999, { name: 'X', stageType: 'script' }, 'now'),
    ).resolves.toBeUndefined()
  })

  it('支持 stageType 别名 type（防止字段名分歧）', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [])
    await markStageRunning(runId, { name: 'Y', type: 'approval' }, 'now')
    const stored = await readStageResults(runId)
    expect(stored[0]).toMatchObject({ type: 'approval', status: 'running' })
  })

  it('stageType / type 都缺时回落到 unknown', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [])
    await markStageRunning(runId, { name: 'Z' } as { name: string }, 'now')
    const stored = await readStageResults(runId)
    expect(stored[0]).toMatchObject({ type: 'unknown', status: 'running' })
  })
})

describe('mergeAndPersistStageResults (persistValues 替换路径)', () => {
  it('合并 langgraph state 后覆盖 running entry', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [
      { name: 'A', type: 'script', status: 'success' },
      { name: 'B', type: 'capability', status: 'running', startedAt: 't1' },
    ])
    await mergeAndPersistStageResults(runId, 1, [
      { name: 'A', type: 'script', status: 'success' },
      {
        name: 'B',
        type: 'capability',
        status: 'success',
        startedAt: 't1',
        finishedAt: 't2',
      },
    ])
    const stored = await readStageResults(runId)
    expect(stored).toHaveLength(2)
    expect(stored[1]).toMatchObject({
      name: 'B',
      status: 'success',
      finishedAt: 't2',
    })
  })

  it('保留 DB 中存在但 langgraph state 中缺失的 running entry', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [
      { name: 'A', type: 'script', status: 'success' },
      { name: 'C', type: 'capability', status: 'running', startedAt: 't0' },
    ])
    await mergeAndPersistStageResults(runId, 0, [
      { name: 'A', type: 'script', status: 'success' },
    ])
    const stored = await readStageResults(runId)
    expect(stored).toHaveLength(2)
    expect(stored.find((r) => r.name === 'C')).toMatchObject({
      status: 'running',
      startedAt: 't0',
    })
  })

  it('空 langgraph state 时不破坏 DB', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [
      { name: 'A', type: 'script', status: 'running' },
    ])
    await mergeAndPersistStageResults(runId, 0, [])
    const stored = await readStageResults(runId)
    expect(stored).toEqual([{ name: 'A', type: 'script', status: 'running' }])
  })
})
