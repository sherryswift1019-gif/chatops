import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerIMTriggersRoutes } from '../../admin/routes/im-triggers.js'

describe('admin im-triggers route — fastify-inject', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildAdminTestApp(async (a) => { await registerIMTriggersRoutes(a) })
  })
  afterAll(async () => { await app.close() })

  it('GET /im-triggers returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/im-triggers' })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('GET /im-triggers/:key returns 404 for unknown', async () => {
    const res = await app.inject({ method: 'GET', url: '/im-triggers/nonexistent_xxx' })
    expect(res.statusCode).toBe(404)
  })

  it('POST + GET + DELETE round-trip', async () => {
    const post = await app.inject({
      method: 'POST', url: '/im-triggers',
      payload: { key: 'test_admin_phase2', displayName: '测试', description: 'fastify-inject' },
    })
    expect(post.statusCode).toBe(201)
    const created = post.json() as { id: number; key: string }
    expect(created.key).toBe('test_admin_phase2')

    const get = await app.inject({ method: 'GET', url: '/im-triggers/test_admin_phase2' })
    expect(get.statusCode).toBe(200)

    const del = await app.inject({ method: 'DELETE', url: `/im-triggers/${created.id}` })
    expect(del.statusCode).toBe(204)
  })

  it('POST returns 400 when both pipelineId and capabilityKey are set', async () => {
    const res = await app.inject({
      method: 'POST', url: '/im-triggers',
      payload: {
        key: 'test_both_fields',
        displayName: '互斥测试',
        pipelineId: 1,
        capabilityKey: 'deploy',
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('不能同时设置')
  })

  it('PUT returns 400 when both pipelineId and capabilityKey are set', async () => {
    // 先创建一个
    const post = await app.inject({
      method: 'POST', url: '/im-triggers',
      payload: { key: 'test_exclusive_put', displayName: '互斥 PUT 测试' },
    })
    expect(post.statusCode).toBe(201)
    const created = post.json() as { id: number }

    const res = await app.inject({
      method: 'PUT', url: `/im-triggers/${created.id}`,
      payload: { pipelineId: 1, capabilityKey: 'deploy' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('不能同时设置')

    // 清理
    await app.inject({ method: 'DELETE', url: `/im-triggers/${created.id}` })
  })
})
