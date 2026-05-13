import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { resetTestDb } from '../helpers/db.js'
import { registerBrainstormRoutes } from '../../admin/routes/brainstorm.js'

async function buildApp() {
  const app = Fastify()
  await app.register(async (instance) => {
    await registerBrainstormRoutes(instance)
  }, { prefix: '/admin' })
  return app
}

describe('POST /admin/requirements/:id/brainstorm/answer', () => {
  beforeEach(async () => { await resetTestDb() })

  it('returns 400 when neither chosenOption nor freeText provided', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST', url: '/admin/requirements/1/brainstorm/answer',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error).toBe('invalid_body')
  })

  it('returns 400 when no active brainstorm waiter for the requirement', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST', url: '/admin/requirements/1/brainstorm/answer',
      payload: { chosenOption: 'A' },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.payload)
    expect(body.error).toBe('no_active_brainstorm_waiter')
  })

  it('accepts freeText alone', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST', url: '/admin/requirements/1/brainstorm/answer',
      payload: { freeText: '都不对，我想要 XX' },
    })
    expect(res.statusCode).toBe(400)  // still no waiter, but body parsing OK
    expect(JSON.parse(res.payload).error).toBe('no_active_brainstorm_waiter')
  })

  it('accepts both chosenOption and freeText combined', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST', url: '/admin/requirements/1/brainstorm/answer',
      payload: { chosenOption: 'A', freeText: '但默认勾选' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).error).toBe('no_active_brainstorm_waiter')
  })
})
