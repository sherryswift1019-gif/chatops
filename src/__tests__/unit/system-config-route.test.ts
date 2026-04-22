/**
 * Unit test: PUT/GET /system-config 路由
 *
 * 背景：SystemConfigPage 新增 `keyvalue` 字段类型（首用：dingtalk.cardTemplates）。
 * 该字段的提交负载是对象形态（`{cardTemplates: {issue_approval: "xxx"}}`），
 * 不是过去的 `Record<string, string>` 扁平键值对。本测试锁定两件事：
 *   1. 对象形态字段能被 route merge 逻辑正确保留并写回 setConfig
 *   2. merge 不会覆盖同 key 下的其他已有字段（clientId/clientSecret 等）
 *
 * 策略：mock system-config repository，Fastify inject 验证 route 行为，
 * 不碰真实 DB（纯路由 + merge 逻辑单测）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

vi.mock('../../db/repositories/system-config.js', () => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  getAllConfig: vi.fn(async () => []),
}))

import { registerSystemConfigRoutes } from '../../admin/routes/system-config.js'
import { getConfig, setConfig } from '../../db/repositories/system-config.js'

async function buildApp() {
  const app = Fastify()
  await app.register(async (scope) => {
    await registerSystemConfigRoutes(scope, { adapters: [] })
  })
  return app
}

describe('PUT /system-config/:key — keyvalue 字段 merge 行为', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(setConfig).mockImplementation(async (key, value) => ({
      key,
      value,
      updatedAt: new Date(),
    }))
  })

  it('新增 dingtalk.cardTemplates（DB 无 dingtalk key）→ setConfig 收到对象形态 value', async () => {
    vi.mocked(getConfig).mockResolvedValueOnce(null)

    const app = await buildApp()
    const res = await app.inject({
      method: 'PUT',
      url: '/system-config/dingtalk',
      payload: { cardTemplates: { issue_approval: 'tpl-xxx.schema' } },
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(setConfig).toHaveBeenCalledWith('dingtalk', {
      cardTemplates: { issue_approval: 'tpl-xxx.schema' },
    })
  })

  it('已有 clientId/clientSecret 时新增 cardTemplates → 三字段并存（merge 不覆盖老字段）', async () => {
    vi.mocked(getConfig).mockResolvedValueOnce({
      key: 'dingtalk',
      value: { clientId: 'app-1', clientSecret: 'secret-1' },
      updatedAt: new Date(),
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'PUT',
      url: '/system-config/dingtalk',
      payload: { cardTemplates: { issue_approval: 'tpl-xxx.schema' } },
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(setConfig).toHaveBeenCalledWith('dingtalk', {
      clientId: 'app-1',
      clientSecret: 'secret-1',
      cardTemplates: { issue_approval: 'tpl-xxx.schema' },
    })
  })

  it('PUT 空对象 cardTemplates={} → merge 后 value 里 cardTemplates 为空对象（"清空所有条目"语义）', async () => {
    vi.mocked(getConfig).mockResolvedValueOnce({
      key: 'dingtalk',
      value: {
        clientId: 'app-1',
        cardTemplates: { issue_approval: 'old-tpl.schema', l2_notify: 'old-2.schema' },
      },
      updatedAt: new Date(),
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'PUT',
      url: '/system-config/dingtalk',
      payload: { cardTemplates: {} },
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    // 现有 merge 逻辑：`if (v !== '') merged[k] = v` —— `{} !== ''` 为 true，所以空对象能覆盖旧值
    expect(setConfig).toHaveBeenCalledWith('dingtalk', {
      clientId: 'app-1',
      cardTemplates: {},
    })
  })

  it('GET /system-config 返回 cardTemplates 字段明文（非 secret，不会被 mask）', async () => {
    const { getAllConfig } = await import('../../db/repositories/system-config.js')
    vi.mocked(getAllConfig).mockResolvedValueOnce([
      {
        key: 'dingtalk',
        value: {
          clientSecret: 'super-long-secret-value',
          cardTemplates: { issue_approval: 'tpl-visible.schema' },
        },
        updatedAt: new Date(),
      },
    ])

    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/system-config' })
    await app.close()

    expect(res.statusCode).toBe(200)
    const body = res.json() as Array<{ key: string; value: Record<string, unknown> }>
    const dingtalk = body.find(c => c.key === 'dingtalk')
    expect(dingtalk).toBeTruthy()
    // clientSecret 被 mask（末 4 位 + ****）
    expect(dingtalk!.value.clientSecret).toMatch(/^\*\*\*\*/)
    // cardTemplates 不含 secret/password/token/key 字样，不会被 mask
    expect(dingtalk!.value.cardTemplates).toEqual({ issue_approval: 'tpl-visible.schema' })
  })
})
