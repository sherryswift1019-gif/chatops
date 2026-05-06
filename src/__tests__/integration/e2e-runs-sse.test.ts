// src/__tests__/integration/e2e-runs-sse.test.ts
//
// SSE 路由集成测试。fastify-inject 不支持流式 SSE，必须 app.listen({ port: 0 })
// 起真端口 + 原生 http 客户端读 chunk。
//
// 鉴权用真实 sessionPlugin + requireAuth + POST /admin/auth/login 拿 set-cookie
// （admin/admin 默认用户由 schema-v9 + v1005 种入并解除 must_change_password）。

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { resetTestDb } from '../helpers/db.js'
import { sessionPlugin, requireAuth } from '../../admin/auth/session-plugin.js'
import { registerAuthRoutes } from '../../admin/routes/auth.js'
import { registerE2eRunRoutes } from '../../admin/routes/e2e-runs.js'
import { __resetForTesting, emit, ensureRun } from '../../e2e/pipeline-b/scenario-event-bus.js'

interface SsePart {
  event: string
  data: string
}

/** 把 chunk 拼接成 SSE 事件数组（每事件以 \n\n 分隔，event:/data: 各占一行）。 */
function parseSse(buf: string): SsePart[] {
  const parts: SsePart[] = []
  for (const block of buf.split('\n\n')) {
    if (!block.trim()) continue
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (data) parts.push({ event, data })
  }
  return parts
}

/** 起一个 mini fastify app：mount 在 /admin 前缀下，含 sessionPlugin + requireAuth + auth + e2e-runs 路由。 */
async function buildAuthedApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(async (scoped) => {
    await scoped.register(sessionPlugin)
    scoped.addHook('preHandler', requireAuth)
    await registerAuthRoutes(scoped)
    await registerE2eRunRoutes(scoped)
  }, { prefix: '/admin' })
  await app.ready()
  return app
}

/** 通过 POST /admin/auth/login 拿 set-cookie；admin/admin 由 v9/v1005 种入。 */
async function loginAndGetCookie(port: number): Promise<string> {
  const res = await fetch(`http://localhost:${port}/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  if (res.status !== 200) {
    const body = await res.text()
    throw new Error(`login failed: status=${res.status} body=${body}`)
  }
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) throw new Error('login: no set-cookie header')
  // 取 cookie name=value 部分（去掉 Path/HttpOnly/SameSite 等 attribute）
  return setCookie.split(';')[0]
}

describe('GET /admin/e2e-runs/:runId/events SSE', () => {
  let app: FastifyInstance
  let port: number
  let cookie: string

  beforeAll(async () => {
    await resetTestDb()
    app = await buildAuthedApp()
    await app.listen({ port: 0 })
    port = (app.server.address() as AddressInfo).port
    cookie = await loginAndGetCookie(port)
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    __resetForTesting()
  })

  it('未登录请求 → 401', async () => {
    const res = await fetch(`http://localhost:${port}/admin/e2e-runs/123/events`)
    expect(res.status).toBe(401)
  })

  it('无效 runId（非数字）→ 400', async () => {
    const res = await fetch(`http://localhost:${port}/admin/e2e-runs/abc/events`, {
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'invalid runId' })
  })

  it('emit 事件后客户端收到 SSE 帧', async () => {
    const runId = 999n
    ensureRun(runId)

    const chunks: string[] = []
    const req = http.get(`http://localhost:${port}/admin/e2e-runs/${runId}/events`, {
      headers: { Cookie: cookie },
    })

    // 等连接建立 + headers 进来
    await new Promise<void>((resolve, reject) => {
      req.on('error', reject)
      req.on('response', (res) => {
        expect(res.statusCode).toBe(200)
        expect(res.headers['content-type']).toContain('text/event-stream')
        res.setEncoding('utf8')
        res.on('data', (b: string) => chunks.push(b))
        resolve()
      })
    })

    // 给一点时间让 handler 注册 subscribe
    await new Promise((r) => setTimeout(r, 100))

    emit(runId, {
      type: 'tool_use',
      runId: runId.toString(),
      phase: 'scenario',
      step: 1,
      toolName: 'browser_click',
      argsSummary: 'target=foo',
      ts: Date.now(),
    })

    // 等帧抵达
    await new Promise((r) => setTimeout(r, 100))
    const buf = chunks.join('')
    expect(buf).toContain('event: tool_use')
    expect(buf).toContain('"toolName":"browser_click"')

    req.destroy()
  })

  it('收到 closed 事件后服务端关闭流', async () => {
    const runId = 998n
    ensureRun(runId)

    const chunks: string[] = []
    let socketClosed = false
    const req = http.get(`http://localhost:${port}/admin/e2e-runs/${runId}/events`, {
      headers: { Cookie: cookie },
    })

    await new Promise<void>((resolve, reject) => {
      req.on('error', reject)
      req.on('response', (res) => {
        res.setEncoding('utf8')
        res.on('data', (b: string) => chunks.push(b))
        res.on('end', () => { socketClosed = true })
        res.on('close', () => { socketClosed = true })
        resolve()
      })
    })

    await new Promise((r) => setTimeout(r, 100))

    emit(runId, { type: 'closed', runId: runId.toString(), ts: Date.now() })

    await new Promise((r) => setTimeout(r, 200))
    expect(chunks.join('')).toContain('event: closed')
    expect(socketClosed).toBe(true)

    req.destroy()
  })

  it('订阅前 emit 的事件通过 history replay 收到', async () => {
    const runId = 997n
    ensureRun(runId)

    // 先 emit，再连接 → SSE handler 应通过 getHistory replay
    emit(runId, {
      type: 'scenario_start',
      runId: runId.toString(),
      scenarioRunId: '1',
      scenarioId: 'login.success',
      attemptNumber: 1,
      ts: Date.now(),
    })

    const chunks: string[] = []
    const req = http.get(`http://localhost:${port}/admin/e2e-runs/${runId}/events`, {
      headers: { Cookie: cookie },
    })

    await new Promise<void>((resolve, reject) => {
      req.on('error', reject)
      req.on('response', (res) => {
        res.setEncoding('utf8')
        res.on('data', (b: string) => chunks.push(b))
        resolve()
      })
    })

    await new Promise((r) => setTimeout(r, 200))
    const parts = parseSse(chunks.join(''))
    const replayed = parts.find((p) => p.event === 'scenario_start')
    expect(replayed).toBeDefined()
    expect(replayed!.data).toContain('"scenarioId":"login.success"')

    req.destroy()
  })
})
