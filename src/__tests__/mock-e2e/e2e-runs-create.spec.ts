import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { Pool } from 'pg'
import { resetPerTest } from './helpers/per-test.js'

const GITLAB_MOCK = process.env.E2E_GITLAB_MOCK_URL ?? 'http://localhost:4001'

async function dbQuery(sql: string, params: unknown[] = []): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await pool.query(sql, params)
  } finally {
    await pool.end()
  }
}

async function loginAsAdmin(request: APIRequestContext): Promise<void> {
  await dbQuery(`UPDATE admin_users SET must_change_password = FALSE WHERE username = 'admin'`)
  const r = await request.post('/admin/auth/login', {
    data: { username: 'admin', password: 'admin' },
  })
  expect(r.ok()).toBe(true)
}

async function mockE2eRunApis(page: Page): Promise<{ createdBodies: unknown[] }> {
  const createdBodies: unknown[] = []

  await page.route('**/admin/e2e-targets', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'chatops',
          displayName: 'ChatOps',
          gitlabRepo: 'devops/chatops',
          defaultBranch: 'main',
          workingDir: '.',
          scripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
          capabilities: {},
          defaultSandboxKind: 'docker-compose-local',
          createdAt: new Date().toISOString(),
        },
      ]),
    })
  })

  await page.route('**/admin/e2e-targets/chatops/branches', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ branches: ['main', 'feature/smoke'], defaultBranch: 'main' }),
    })
  })

  await page.route('**/admin/e2e-runs/scenario-options?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ref: 'main',
        allTags: ['auth', 'smoke'],
        scenarios: [
          {
            id: 'login.success',
            name: '登录成功',
            tags: ['smoke', 'auth'],
            specPath: 'docs/test-playbooks/login.yaml',
          },
        ],
      }),
    })
  })

  await page.route('**/admin/e2e-runs?limit=20&offset=0', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ runs: [], total: 0 }),
    })
  })

  await page.route('**/admin/e2e-runs', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    createdBodies.push(route.request().postDataJSON())
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ runId: '1', status: 'pending' }),
    })
  })

  return { createdBodies }
}

test.describe('E2eRunsPage 新建 Run', () => {
  test.beforeEach(async ({ request }) => {
    await resetPerTest(request, GITLAB_MOCK)
  })

  test('点击新建 Run，可选择 smoke tag 并提交 scenarioFilter', async ({ request, page }) => {
    await loginAsAdmin(request)
    const { createdBodies } = await mockE2eRunApis(page)

    const loginResp = await page.request.post('/admin/auth/login', {
      data: { username: 'admin', password: 'admin' },
    })
    expect(loginResp.ok()).toBe(true)

    await page.goto('/e2e-runs')

    const pageCard = page.locator('.ant-card').filter({ hasText: 'E2E 测试 Runs' }).first()
    await expect(pageCard).toBeVisible({ timeout: 10_000 })
    await pageCard.getByRole('button', { name: /新建 Run/ }).click()

    const modal = page.locator('.ant-modal-content').filter({ hasText: '新建 E2E Run' }).first()
    await expect(modal).toBeVisible()

    await modal.locator('.ant-select').filter({
      has: page.locator('.ant-select-selection-placeholder', { hasText: '选择项目' }),
    }).click()
    await page.locator('.ant-select-item-option').filter({ hasText: 'ChatOps' }).click()

    await expect(modal.getByText('main')).toBeVisible()
    await modal.getByText('按 tag').click()
    await modal.locator('.ant-select').filter({
      has: page.locator('.ant-select-selection-placeholder', { hasText: '选择 tag' }),
    }).click()
    await page.locator('.ant-select-item-option').filter({ hasText: /^smoke$/ }).click()

    await page.keyboard.press('Escape')
    await page.locator('.ant-modal-footer button.ant-btn-primary').click()

    await expect.poll(() => createdBodies.length).toBe(1)
    expect(createdBodies[0]).toEqual({
      targetProjectId: 'chatops',
      sourceBranch: 'main',
      scenarioFilter: { tags: ['smoke'] },
    })
  })
})
