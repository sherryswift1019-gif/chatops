import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerPipelineNodeTypeRoutes } from '../../admin/routes/pipeline-node-types.js'
import { getPool } from '../../db/client.js'

describe('GET /pipeline-node-types route — fastify-inject', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildAdminTestApp(async (a) => {
      await registerPipelineNodeTypeRoutes(a)
    })
  })
  afterAll(async () => { await app.close() })

  it('returns 200 with bare array of 13 enabled node types (5 phase-0 + 7 phase-3 + switch)', async () => {
    const res = await app.inject({ method: 'GET', url: '/pipeline-node-types' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(13)
  })

  it('disabled node types are filtered out', async () => {
    // 临时把 script 标记 disabled
    await getPool().query(`UPDATE pipeline_node_types SET enabled=false WHERE key='script'`)
    try {
      const res = await app.inject({ method: 'GET', url: '/pipeline-node-types' })
      const body = res.json() as Array<{ key: string }>
      expect(body.find(t => t.key === 'script')).toBeUndefined()
      expect(body).toHaveLength(12)
    } finally {
      await getPool().query(`UPDATE pipeline_node_types SET enabled=true WHERE key='script'`)
    }
  })

  it('each item exposes key/displayName/category/paramSchema/outputSchema', async () => {
    const res = await app.inject({ method: 'GET', url: '/pipeline-node-types' })
    const body = res.json() as Array<Record<string, unknown>>
    for (const item of body) {
      expect(item).toHaveProperty('key')
      expect(item).toHaveProperty('displayName')
      expect(item).toHaveProperty('category')
      expect(typeof item.paramSchema).toBe('object')
      expect(typeof item.outputSchema).toBe('object')
    }
  })
})
