import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerDryRunRoutes } from '../../admin/routes/dryrun.js'
import { getPool } from '../../db/client.js'
import type { FastifyInstance } from 'fastify'

async function seedPipelineWithRun(graph: unknown, triggerParams: unknown): Promise<{ pid: number; runId: number }> {
  const p = await getPool().query(
    `INSERT INTO test_pipelines (name, graph) VALUES ('p',$1::jsonb) RETURNING id`,
    [JSON.stringify(graph)])
  const r = await getPool().query(
    `INSERT INTO test_runs (pipeline_id, trigger_type, triggered_by, trigger_params, status)
     VALUES ($1,'api','webhook',$2::jsonb,'success') RETURNING id`,
    [p.rows[0].id, JSON.stringify(triggerParams)])
  return { pid: p.rows[0].id as number, runId: r.rows[0].id as number }
}

async function buildApp(): Promise<FastifyInstance> {
  return buildAdminTestApp(async (app) => {
    await registerDryRunRoutes(app)
  })
}

describe('dryrun API', () => {
  beforeEach(async () => { await resetTestDb() })

  it('GET /test-pipelines/:id/recent-trigger-params', async () => {
    const { pid } = await seedPipelineWithRun({ nodes: [], edges: [] }, { ref: 'main' })
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: `/test-pipelines/${pid}/recent-trigger-params?limit=10` })
    expect(r.statusCode).toBe(200)
    const list = r.json()
    expect(list).toHaveLength(1)
    expect(list[0].triggerParams).toEqual({ ref: 'main' })
    expect(list[0].triggerType).toBe('api')
    await app.close()
  })

  it('GET /test-pipelines/:id/dry-run/snapshots — 含 stale 标', async () => {
    const graph = {
      nodes: [{ id: 'q', name: 'q', stageType: 'sql_query', params: { sqlTemplate: 'SELECT 1' }, position: { x: 0, y: 0 } }],
      edges: [],
    }
    const p = await getPool().query(
      `INSERT INTO test_pipelines (name, graph) VALUES ('p',$1::jsonb) RETURNING id`,
      [JSON.stringify(graph)])
    const pid = p.rows[0].id
    // upsert 一个 snapshot with an intentionally wrong hash
    await getPool().query(
      `INSERT INTO pipeline_dryrun_snapshots (pipeline_id, node_id, status, output, source, upstream_params_hash)
       VALUES ($1, 'q', 'success', '{"rows":[]}', 'real', 'old-hash-abc')`,
      [pid])
    const app = await buildApp()
    const r = await app.inject({ method: 'GET', url: `/test-pipelines/${pid}/dry-run/snapshots` })
    expect(r.statusCode).toBe(200)
    const list = r.json()
    expect(list).toHaveLength(1)
    expect(list[0].stale).toBe(true)  // 'old-hash-abc' != 实际计算的 hash
    await app.close()
  })

  it('DELETE /test-pipelines/:id/dry-run/snapshots — 全清', async () => {
    const p = await getPool().query(`INSERT INTO test_pipelines (name) VALUES ('p') RETURNING id`)
    await getPool().query(
      `INSERT INTO pipeline_dryrun_snapshots (pipeline_id, node_id, status, output, source, upstream_params_hash)
       VALUES ($1,'q','success','{}','real','h')`, [p.rows[0].id])
    const app = await buildApp()
    const r = await app.inject({ method: 'DELETE', url: `/test-pipelines/${p.rows[0].id}/dry-run/snapshots` })
    expect(r.statusCode).toBe(204)
    const remain = await getPool().query(
      `SELECT * FROM pipeline_dryrun_snapshots WHERE pipeline_id=$1`, [p.rows[0].id])
    expect(remain.rowCount).toBe(0)
    await app.close()
  })

  it('POST /test-pipelines/:id/dry-run/sessions/:sid/decide — 提交决策（占位）', async () => {
    // 这个测试需要先启动一个 dry-run 会话，模拟 SSE waiting → POST decide → 完成
    // 集成度高，骨架先放占位
    expect(true).toBe(true)
  })

  it('graph dirty（前端传 graph hash 与 DB 不一致）→ 400', async () => {
    const p = await getPool().query(
      `INSERT INTO test_pipelines (name, graph) VALUES ('p','{"nodes":[],"edges":[]}'::jsonb) RETURNING id`)
    const app = await buildApp()
    const r = await app.inject({
      method: 'POST',
      url: `/test-pipelines/${p.rows[0].id}/dry-run/run-to/x`,
      payload: {
        graphHash: 'wrong-hash',
        triggerParams: {}, triggerType: 'manual', triggeredBy: 't',
      },
    })
    expect(r.statusCode).toBe(400)
    await app.close()
  })
})
