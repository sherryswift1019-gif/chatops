import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import {
  upsertSnapshot, listSnapshots, deleteSnapshot, deleteAllSnapshots,
} from '../../db/repositories/dryrun-snapshots.js'
import { getPool } from '../../db/client.js'

describe('dryrun-snapshots repository', () => {
  beforeEach(async () => { await resetTestDb() })

  async function seedPipeline(): Promise<number> {
    const pool = getPool()
    const plRow = await pool.query(
      `INSERT INTO product_lines (name, display_name) VALUES ('test-pl', 'Test PL') RETURNING id`)
    const plId = plRow.rows[0].id as number
    const r = await pool.query(
      `INSERT INTO test_pipelines (name, product_line_id) VALUES ('p1', $1) RETURNING id`,
      [plId])
    return r.rows[0].id as number
  }

  it('upsertSnapshot 新增 + 覆盖', async () => {
    const pid = await seedPipeline()
    await upsertSnapshot({
      pipelineId: pid, nodeId: 'n1',
      status: 'success', output: { foo: 'bar' }, source: 'real',
      upstreamParamsHash: 'aaa', lastDecision: null, lastManualInput: null,
      durationMs: 100, error: null,
    })
    const list1 = await listSnapshots(pid)
    expect(list1).toHaveLength(1)
    expect(list1[0].output).toEqual({ foo: 'bar' })
    // 覆盖
    await upsertSnapshot({
      pipelineId: pid, nodeId: 'n1',
      status: 'success', output: { foo: 'baz' }, source: 'stub',
      upstreamParamsHash: 'bbb', lastDecision: 'stub', lastManualInput: null,
      durationMs: 0, error: null,
    })
    const list2 = await listSnapshots(pid)
    expect(list2).toHaveLength(1)
    expect(list2[0].output).toEqual({ foo: 'baz' })
    expect(list2[0].source).toBe('stub')
    expect(list2[0].lastDecision).toBe('stub')
  })

  it('deleteSnapshot 单删 / deleteAll 清空', async () => {
    const pid = await seedPipeline()
    await upsertSnapshot({
      pipelineId: pid, nodeId: 'n1', status: 'success', output: {},
      source: 'real', upstreamParamsHash: 'h', lastDecision: null,
      lastManualInput: null, durationMs: 0, error: null,
    })
    await upsertSnapshot({
      pipelineId: pid, nodeId: 'n2', status: 'success', output: {},
      source: 'real', upstreamParamsHash: 'h', lastDecision: null,
      lastManualInput: null, durationMs: 0, error: null,
    })
    expect((await listSnapshots(pid)).length).toBe(2)
    await deleteSnapshot(pid, 'n1')
    expect((await listSnapshots(pid)).length).toBe(1)
    await deleteAllSnapshots(pid)
    expect((await listSnapshots(pid)).length).toBe(0)
  })

  it('删除 pipeline 级联删 snapshot', async () => {
    const pid = await seedPipeline()
    await upsertSnapshot({
      pipelineId: pid, nodeId: 'n1', status: 'success', output: {},
      source: 'real', upstreamParamsHash: 'h', lastDecision: null,
      lastManualInput: null, durationMs: 0, error: null,
    })
    await getPool().query(`DELETE FROM test_pipelines WHERE id=$1`, [pid])
    const r = await getPool().query(
      `SELECT * FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1`, [pid])
    expect(r.rowCount).toBe(0)
  })
})
