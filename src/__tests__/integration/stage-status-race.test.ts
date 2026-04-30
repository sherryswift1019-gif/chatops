/**
 * stage-status-race — integration tests for the read-modify-write race in
 * stage-status.ts.
 *
 * 背景：markStageRunning 和 mergeAndPersistStageResults 都是
 *   1. SELECT stage_results
 *   2. merge in-process
 *   3. UPDATE stage_results
 * 没有事务/锁。当 langgraph chunk-driven persistValues 与
 * markStageRunning(node 入口) 在 graph-runner / graph-builder 并发触发时，
 * 两者读到同一份 stale stage_results，各自合并自己的 update 后再写回，**后写者**
 * 会把先写者的 entry 覆盖掉——running entry 丢失 / 顺序错乱。
 *
 * 这个集成测试用真 Postgres + Promise.all 高并发复现该 race。fix 之后两个写入
 * 路径走 advisory lock + 事务，最终 stage_results 必须包含每一条写过的 entry。
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import {
  markStageRunning,
  mergeAndPersistStageResults,
} from '../../pipeline/stage-status.js'
import type { StageResult } from '../../db/repositories/test-runs.js'

async function seedProductLine(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('race-test', 'Race Test', 'race')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
  )
  return rows[0].id as number
}

async function seedPipeline(productLineId: number): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (name, description, stages, product_line_id)
     VALUES ($1, 'race', '[]'::jsonb, $2) RETURNING id`,
    [`race-pipe-${Date.now()}-${Math.random()}`, productLineId],
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
     VALUES ($1, 'api', 'race-test', '{}'::jsonb, 'running', NOW(), $2::jsonb)
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

afterAll(async () => {
  // pg client 会持有 pool；测试结束让 pool drain，避免 vitest 报"open handle"
  try {
    await getPool().end()
  } catch {
    /* idempotent */
  }
})

describe('stage-status concurrent writes', () => {
  it('case 1: 并发 markStageRunning 与 mergeAndPersistStageResults 不丢 entry / 顺序保留', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [
      { name: 'A', type: 'script', status: 'success' },
      { name: 'B', type: 'capability', status: 'success' },
    ])

    // 模拟 graph-runner.persistValues（langgraph chunk 推过来的完整 state）+
    // graph-builder.markStageRunning（node 入口同步写）真同时打 DB
    await Promise.all([
      mergeAndPersistStageResults(runId, 1, [
        { name: 'A', type: 'script', status: 'success' },
        { name: 'B', type: 'capability', status: 'success' },
        { name: 'C', type: 'script', status: 'success' },
      ]),
      markStageRunning(runId, { name: 'D', stageType: 'script' }, 't-D'),
    ])

    // 紧跟着再写一条 running，确认 D 的写没被吞、E 不会被反过来覆盖
    await markStageRunning(runId, { name: 'E', stageType: 'capability' }, 't-E')

    const final = await readStageResults(runId)
    const names = final.map((r) => r.name)

    // 必须包含全部 5 条
    expect(names).toContain('A')
    expect(names).toContain('B')
    expect(names).toContain('C')
    expect(names).toContain('D')
    expect(names).toContain('E')

    // E 的写入晚于 D，因此 E 必须在 D 之后（append-only by-name 语义）
    expect(names.indexOf('E')).toBeGreaterThan(names.indexOf('D'))

    // 各 entry 业务字段没被错位
    expect(final.find((r) => r.name === 'D')).toMatchObject({
      status: 'running',
      startedAt: 't-D',
    })
    expect(final.find((r) => r.name === 'E')).toMatchObject({
      status: 'running',
      startedAt: 't-E',
    })
  })

  it('case 2: 高并发 markStageRunning + mergeAndPersistStageResults 全部 entry 落库', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [])

    const N = 10
    // 第一波：N 个不同 stage 名并发标 running
    const runningWrites = Array.from({ length: N }, (_, i) =>
      markStageRunning(
        runId,
        { name: `S${i}`, stageType: 'script' },
        `start-${i}`,
      ),
    )
    await Promise.all(runningWrites)

    // 第二波：N 个 finalize（mergeAndPersistStageResults）并发，每次只覆盖一个
    const finalizeWrites = Array.from({ length: N }, (_, i) =>
      mergeAndPersistStageResults(runId, i, [
        {
          name: `S${i}`,
          type: 'script',
          status: 'success',
          startedAt: `start-${i}`,
          finishedAt: `end-${i}`,
        },
      ]),
    )
    await Promise.all(finalizeWrites)

    const final = await readStageResults(runId)
    const names = final.map((r) => r.name).sort()

    // 全部 N 个 stage 都在
    expect(names).toEqual(
      Array.from({ length: N }, (_, i) => `S${i}`).sort(),
    )

    // 全部 finalize 成 success
    for (const r of final) {
      expect(r.status).toBe('success')
      expect(r.finishedAt).toMatch(/^end-\d+$/)
    }
  })

  it('case 3: 串行 markStageRunning(A→B→C) 顺序保留（advisory lock 不破坏单调写入）', async () => {
    const pipelineId = await seedPipeline(productLineId)
    const runId = await seedTestRun(pipelineId, [])

    await markStageRunning(runId, { name: 'A', stageType: 'script' }, 't1')
    await markStageRunning(runId, { name: 'B', stageType: 'script' }, 't2')
    await markStageRunning(runId, { name: 'C', stageType: 'script' }, 't3')

    const final = await readStageResults(runId)
    expect(final.map((r) => r.name)).toEqual(['A', 'B', 'C'])
    expect(final.every((r) => r.status === 'running')).toBe(true)
  })
})
