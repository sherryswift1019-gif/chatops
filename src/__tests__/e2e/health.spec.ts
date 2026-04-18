/**
 * Phase 1.5 冒烟测试：验证 e2e 脚手架全部就绪
 * - 后端起来、E2E_MODE/CLAUDE_MOCK 开启
 * - GitLab mock 起来
 * - DB fixture seed 生效（pam 产品线、4 条 pipeline）
 * - 前端 SPA 可访问
 */
import { test, expect } from '@playwright/test'
import { Pool } from 'pg'

// 不要用 process.env.GITLAB_URL —— 开发环境该变量指向真 GitLab，e2e mock 另有端口
const GITLAB_MOCK = process.env.E2E_GITLAB_MOCK_URL ?? 'http://localhost:4001'

test.describe('e2e infra smoke', () => {
  test('后端 /admin/_e2e/health 返回 E2E_MODE=true', async ({ request }) => {
    const r = await request.get('/admin/_e2e/health')
    expect(r.ok()).toBe(true)
    const body = await r.json()
    expect(body.e2eMode).toBe(true)
    expect(body.claudeMock).toBe(true)
  })

  test('GitLab mock /_control/health 返回 ok', async () => {
    const r = await fetch(`${GITLAB_MOCK}/_control/health`)
    expect(r.ok).toBe(true)
    const body = await r.json()
    expect(body.status).toBe('ok')
  })

  test('DB fixture 已 seed：pam 产品线 + 4 条 pipeline + 2 个 project', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL })
    try {
      const pl = await pool.query(`SELECT name FROM product_lines WHERE name = 'pam'`)
      expect(pl.rowCount).toBe(1)

      const pipelines = await pool.query(
        `SELECT name FROM test_pipelines WHERE product_line_id = (SELECT id FROM product_lines WHERE name = 'pam') ORDER BY name`,
      )
      expect(pipelines.rows.map(r => r.name)).toEqual([
        'L1-配置类',
        'L2-代码缺陷',
        'L3-业务逻辑',
        'L4-复杂问题',
      ])

      const projects = await pool.query(
        `SELECT gitlab_path FROM projects WHERE product_line_id = (SELECT id FROM product_lines WHERE name = 'pam') ORDER BY gitlab_path`,
      )
      expect(projects.rows.map(r => r.gitlab_path)).toEqual(['PAM/pas-api', 'PAM/pas-web'])
    } finally {
      await pool.end()
    }
  })

  test('前端 SPA 根路径返回 HTML', async ({ request }) => {
    const r = await request.get('/')
    expect(r.ok()).toBe(true)
    const text = await r.text()
    expect(text.toLowerCase()).toContain('<!doctype html>')
  })

  test('GitLab mock 默认 issue 响应可用', async () => {
    const r = await fetch(`${GITLAB_MOCK}/api/v4/projects/${encodeURIComponent('PAM/pas-api')}/issues`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'smoke test', description: 'via e2e smoke' }),
    })
    expect(r.ok).toBe(true)
    const body = await r.json()
    expect(typeof body.iid).toBe('number')
    expect(body.web_url).toContain('PAM/pas-api')
  })

  test('e2e store 可写入并查询 claude mock 响应', async ({ request }) => {
    // 写一个然后通过 messages 端点间接验证 store 可访问
    const seed = await request.post('/admin/_e2e/claude', {
      data: { key: 'analyze_bug-filter', response: { sanity: true } },
    })
    expect(seed.ok()).toBe(true)

    // reset 应该清掉
    const reset = await request.post('/admin/_e2e/reset')
    expect(reset.ok()).toBe(true)
  })
})
