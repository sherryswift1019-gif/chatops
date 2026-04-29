import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerWebhookRoute } from '../../pipeline/webhook-router.js'
import { createPipelineWebhook, updatePipelineWebhook } from '../../db/repositories/pipeline-webhooks-repo.js'

// mock runPipeline，返回固定 runId 避免完整 pipeline 执行
vi.mock('../../pipeline/executor.js', () => ({
  runPipeline: vi.fn().mockResolvedValue(42),
}))

async function insertTestPipeline(enabled = true): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO test_pipelines (name, description, stages, enabled)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['wh-test', '', JSON.stringify([]), enabled],
  )
  return rows[0].id as number
}

describe('POST /webhook/pipeline/:token', () => {
  let app: Awaited<ReturnType<typeof buildAdminTestApp>>

  beforeEach(async () => {
    await resetTestDb()
    app = await buildAdminTestApp(async (a) => {
      await registerWebhookRoute(a)
    })
  })

  afterEach(async () => {
    await app.close()
    vi.clearAllMocks()
  })

  it('有效 token + JSON body → 202 + runId + statusUrl', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'my-repo', branch: 'main' }),
    })
    expect(res.statusCode).toBe(202)
    const body = res.json<{ runId: number; statusUrl: string; triggeredAt: string }>()
    expect(body.runId).toBe(42)
    expect(body.statusUrl).toBe('/admin/api/test-runs/42')
    expect(body.triggeredAt).toMatch(/^\d{4}-/)
  })

  it('不存在的 token → 401 固定字符串', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhook/pipeline/nonexistent-token-xxx',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid webhook token' })
  })

  it('webhook enabled=false → 401（与不存在相同）', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    await updatePipelineWebhook(wh.id, { enabled: false })
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid webhook token' })
  })

  it('pipeline 被禁用 → 404', async () => {
    const pipelineId = await insertTestPipeline(false)
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.statusCode).toBe(404)
  })

  it('body 非 JSON object（是数组）→ 400', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: '[1, 2, 3]',
    })
    expect(res.statusCode).toBe(400)
  })

  it('_servers 形状错误 → 400', async () => {
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _servers: 'invalid' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('_servers 从 payload 剔除，不进 triggerParams', async () => {
    const { runPipeline } = await import('../../pipeline/executor.js')
    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _servers: { deploy: ['s1'] }, ref: 'main' }),
    })
    const mockFn = runPipeline as ReturnType<typeof vi.fn>
    expect(mockFn).toHaveBeenCalledOnce()
    const trigger = mockFn.mock.calls[0][2]
    expect(trigger.params).toEqual({ ref: 'main' })
    expect(trigger.params).not.toHaveProperty('_servers')
    expect(trigger.triggeredBy).toMatch(/^webhook:\d+:ci$/)
  })

  it('body 无 _servers + webhook.default_servers=NULL → 按 role 自动分配 test_servers', async () => {
    const { runPipeline } = await import('../../pipeline/executor.js')
    // Seed: 一台 role=proxy / 一台 role=db 的服务器（产线随便建一个）
    const pool = getPool()
    const { rows: plRows } = await pool.query(
      `INSERT INTO product_lines (name, display_name) VALUES ($1, $2) RETURNING id`,
      ['wh-auto-resolve-pl', 'WH Auto Resolve PL'],
    )
    const productLineId = plRows[0].id as number
    const insert = async (role: string, host: string): Promise<number> => {
      const { rows } = await pool.query(
        `INSERT INTO test_servers (product_line_id, name, host, port, username, auth_type, credential, role, tags)
         VALUES ($1,$2,$3,22,'root','password','x',$4,'{}'::jsonb) RETURNING id`,
        [productLineId, `s-${role}`, host, role],
      )
      return rows[0].id as number
    }
    const proxyId = await insert('proxy', '10.0.0.1')
    const dbId = await insert('db', '10.0.0.2')

    const pipelineId = await insertTestPipeline()
    const wh = await createPipelineWebhook({ pipelineId, name: 'ci', createdBy: 'test' })
    // default_servers 留空（createPipelineWebhook 的默认行为就是 NULL）

    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    })
    expect(res.statusCode).toBe(202)

    const mockFn = runPipeline as ReturnType<typeof vi.fn>
    expect(mockFn).toHaveBeenCalledOnce()
    const effectiveServers = mockFn.mock.calls[0][1] as Record<string, string[]>
    expect(effectiveServers).toEqual({
      proxy: [String(proxyId)],
      db: [String(dbId)],
    })
  })
})
