import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { resetTestDb } from '../helpers/db.js'
import { registerToolsRoutes } from '../../admin/routes/tools.js'
// Task 3 完成后会改用 run_command 作为锚点
import '../../agent/tools/run-tests.js'

let app: FastifyInstance

beforeAll(async () => {
  await resetTestDb()
  app = Fastify()
  await registerToolsRoutes(app)
  await app.ready()
})

afterAll(async () => { await app.close() })

describe('GET /admin/tools', () => {
  it('returns the registered tool catalog', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/tools' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ name: string; description: string; riskLevel: string }>
    const names = body.map(t => t.name)
    expect(names).toContain('run_tests')
    const runTests = body.find(t => t.name === 'run_tests')!
    expect(runTests.description).toMatch(/worktree/)
    expect(runTests.riskLevel).toBe('medium')
  })
})
