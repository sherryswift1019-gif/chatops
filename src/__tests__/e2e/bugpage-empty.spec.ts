/**
 * Task 18 Phase 3B — BugRunsPage 场景 B5：数据为空时的占位
 *
 * 目的：验证 BugRunsPage 在无数据时显示 AntD Empty 占位，且不崩溃。
 *
 * 流程：
 *   1. resetPerTest 保证 bug_analysis_reports 为空
 *   2. 打开 /bug-runs，断言默认文案 "请先选择产品线"
 *   3. 选产品线 PAM（库内无该产品线下的报告）→ 断言 "暂无分析报告"
 *
 * 注：BugRunsPage 当前的空态由 `<Empty description={...}>` 驱动，
 * 未选产品线 description="请先选择产品线"，选了产品线且 grouped.size=0
 * description="暂无分析报告"。此 spec 同时覆盖这两个分支。
 */
import { test, expect, type APIRequestContext } from '@playwright/test'
import { Pool } from 'pg'
import { resetPerTest } from './helpers/per-test.js'

const GITLAB_MOCK = process.env.E2E_GITLAB_MOCK_URL ?? 'http://localhost:4001'

async function loginAsAdmin(request: APIRequestContext): Promise<void> {
  await dbQuery(`UPDATE admin_users SET must_change_password = FALSE WHERE username = 'admin'`)
  const r = await request.post('/admin/auth/login', {
    data: { username: 'admin', password: 'admin' },
  })
  expect(r.ok()).toBe(true)
}

async function dbQuery<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows } = await pool.query(sql, params)
    return rows as T[]
  } finally {
    await pool.end()
  }
}

test.describe('BugRunsPage 空态占位', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('未选产品线 + 选后无报告 → 分别显示两种 Empty 占位', async ({ request, page }) => {
    await loginAsAdmin(request)

    // DB 确认空库
    const before = await dbQuery<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM bug_analysis_reports`,
    )
    expect(before[0].cnt).toBe('0')

    // 页面 login
    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    // ── 分支 1：未选产品线 → "请先选择产品线" ────────────────────────────
    await expect(pageCard.locator('.ant-empty').first()).toBeVisible({ timeout: 10_000 })
    await expect(pageCard.getByText('请先选择产品线')).toBeVisible({ timeout: 5_000 })

    // ── 分支 2：选了产品线但无报告 → "暂无分析报告" ───────────────────────
    await pageCard.locator('.ant-select').first().click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'PAM 特权访问管理' }).click()

    // 列表加载后仍为空 → Empty + "暂无分析报告"
    await expect(pageCard.locator('.ant-empty').first()).toBeVisible({ timeout: 10_000 })
    await expect(pageCard.getByText('暂无分析报告')).toBeVisible({ timeout: 5_000 })

    // 此时不应出现任何 "Issue #N" 卡片
    await expect(page.locator('text=/Issue #\\d+/')).toHaveCount(0)
  })
})
