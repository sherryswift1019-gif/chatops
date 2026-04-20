/**
 * BugRunsPage 空态占位 — 适配 Table + Drawer UI
 *
 * 新版 UI：Card(Title="Bug 修复实例") + Table，空态由 Table locale 控制：
 *   - 无筛选：<Empty description="暂无 Bug 修复实例" />
 *   - 有筛选但 0 行：<Empty description="当前筛选条件下无结果，试试调整筛选" />
 *
 * 两个用例：
 *   1. 不带筛选访问 /bug-runs → 显示 "暂无 Bug 修复实例"
 *   2. 选择 status=aborted（无匹配行）→ URL 带 status=aborted + 显示筛选空态
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

  test('不带筛选默认显示全部实例', async ({ request, page }) => {
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

    // 无 seed 数据：Table locale.emptyText 直接渲染字符串（无 .ant-empty 组件，纯文本）
    // 用 Table placeholder 定位
    await expect(
      pageCard.locator('.ant-table-placeholder').getByText(/暂无 Bug 修复实例/),
    ).toBeVisible({ timeout: 10_000 })
  })

  test('选状态无数据时显示筛选空态', async ({ request, page }) => {
    await loginAsAdmin(request)

    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/bug-runs')
    const pageCard = page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })

    // 选状态 = aborted（空库下无匹配）
    // AntD Select placeholder 在 span.ant-select-selection-placeholder 上，不在 input
    // 用 selector 链：pageCard → .ant-select（含 placeholder=状态）→ click
    const statusSelect = pageCard.locator('.ant-select').filter({
      has: page.locator('.ant-select-selection-placeholder', { hasText: '状态' }),
    })
    await statusSelect.click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^aborted$/ }).click()

    // URL 带 status=aborted
    await expect(page).toHaveURL(/status=aborted/)

    // 筛选空态文案
    await expect(
      pageCard.locator('.ant-table-placeholder').getByText(/当前筛选条件下无结果/),
    ).toBeVisible({ timeout: 10_000 })
  })
})
