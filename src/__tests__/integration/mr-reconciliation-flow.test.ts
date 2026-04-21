/**
 * MR 状态定时对账 — 真 HTTP 集成测试
 *
 * 目的：
 *   单元测试（src/__tests__/unit/mr-state-reconciler.test.ts）已经覆盖业务逻辑，
 *   但 gitlabGetMr 被 vi.mock 跳过了。本测试起真 mock gitlab server，
 *   让 reconcileOnce() 通过 axios 真实 HTTP 打到 mock server，
 *   验证「gitlab-mr.ts ↔ mock gitlab-server.ts」的契约：
 *     - URL 编码（PAM/pas-api → PAM%2Fpas-api）
 *     - 请求 header（PRIVATE-TOKEN）
 *     - 响应 shape（state / merged_by / closed_by）
 *
 * 场景：
 *   1. merged 终态 → status=completed + lifecycle_sync 写入 + 请求被 mock 收到
 *   2. closed 终态 → status=aborted
 *   3. 幂等：两次 reconcileOnce 只调一次 GitLab（第二次从已有 lifecycle_sync 跳过）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import axios from 'axios'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { reconcileOnce } from '../../agent/reconcile/mr-state-reconciler.js'
import {
  createMockGitLabServer,
  type MockState,
} from '../mock-e2e/mocks/gitlab-server.js'
import {
  createEvent,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'

// 使用非标准端口避免和 Playwright e2e 用的 4001 / 本地开发 3000 冲突
const MOCK_PORT = 14001
const MOCK_BASE = `http://localhost:${MOCK_PORT}`

let mockServer: { close: () => Promise<void>; getState: () => MockState }

const originalEnv = {
  GITLAB_URL: process.env.GITLAB_URL,
  GITLAB_TOKEN: process.env.GITLAB_TOKEN,
}

// ────────────────────────────────────────────────────────────────

async function seedProductLine(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('pam', 'PAM', 'reconciler-integration')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
  )
  return rows[0].id as number
}

async function seedReport(productLineId: number): Promise<number> {
  const pool = getTestPool()
  const issueId = Math.floor(Math.random() * 1_000_000)
  const { rows } = await pool.query(
    `INSERT INTO bug_analysis_reports
       (issue_id, issue_url, product_line_id, level, classification, confidence, solutions_json, status, primary_project_path)
     VALUES ($1, $2, $3, 'l2', 'bug', 'high', '[]'::jsonb, 'pipeline_success', 'PAM/pas-api')
     RETURNING id`,
    [issueId, `${MOCK_BASE}/PAM/pas-api/-/issues/${issueId}`, productLineId],
  )
  return rows[0].id as number
}

async function seedCreateMrEvent(
  reportId: number,
  projectPath: string,
  mrIid: number,
): Promise<void> {
  await createEvent({
    reportId,
    projectPath,
    code: 'create_mr',
    status: 'success',
    data: { mrIid, mrUrl: `${MOCK_BASE}/${projectPath}/merge_requests/${mrIid}` },
  })
}

/** 往 mock server 的 /_control/override 注入指定响应 */
async function injectMockResponse(
  projectPath: string,
  mrIid: number,
  response: Record<string, unknown>,
): Promise<void> {
  await axios.post(`${MOCK_BASE}/_control/override`, {
    method: 'GET',
    path: `/api/v4/projects/${projectPath}/merge_requests`,
    iid: mrIid,
    response,
  })
}

async function resetMockState(): Promise<void> {
  await axios.post(`${MOCK_BASE}/_control/reset`)
}

// ────────────────────────────────────────────────────────────────

describe('MR 对账集成测试（真 HTTP + mock gitlab server）', () => {
  beforeAll(async () => {
    // 指向 mock server；token 非空即可，mock 不校验
    process.env.GITLAB_URL = MOCK_BASE
    process.env.GITLAB_TOKEN = 'test-token'
    mockServer = await createMockGitLabServer(MOCK_PORT)
  })

  afterAll(async () => {
    await mockServer?.close()
    process.env.GITLAB_URL = originalEnv.GITLAB_URL
    process.env.GITLAB_TOKEN = originalEnv.GITLAB_TOKEN
  })

  beforeEach(async () => {
    await resetTestDb()
    await resetMockState()
  })

  it('merged 终态：真 HTTP 走完整 axios → mock server → 解析响应 → 落 DB', async () => {
    const productLineId = await seedProductLine()
    const reportId = await seedReport(productLineId)
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 55)

    await injectMockResponse('PAM/pas-api', 55, {
      iid: 55,
      state: 'merged',
      merged_at: '2026-04-20T10:00:00Z',
      merged_by: { username: 'alice', name: 'Alice' },
      closed_at: null,
      closed_by: null,
      web_url: `${MOCK_BASE}/PAM/pas-api/merge_requests/55`,
    })

    const stats = await reconcileOnce()

    expect(stats.mergedSynced).toBe(1)
    expect(stats.failures).toHaveLength(0)

    // 业务状态
    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('completed')

    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(1)
    expect(syncEvents[0].data).toMatchObject({
      mrAction: 'merge',
      mrIid: 55,
      mergedBy: 'alice',
      source: 'reconciler',
    })

    // 契约证据：mock server 确实收到了请求，path 正确编码
    const calls = mockServer.getState().calls
    const getCalls = calls.filter(
      c => c.method === 'GET' && c.path.includes('/merge_requests/55'),
    )
    expect(getCalls).toHaveLength(1)
    expect(getCalls[0].path).toContain('PAM%2Fpas-api') // 验证 URL 编码
  })

  it('closed 终态：真 HTTP 路径同样能落 aborted', async () => {
    const productLineId = await seedProductLine()
    const reportId = await seedReport(productLineId)
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 77)

    await injectMockResponse('PAM/pas-api', 77, {
      iid: 77,
      state: 'closed',
      merged_at: null,
      merged_by: null,
      closed_at: '2026-04-20T11:00:00Z',
      closed_by: { username: 'bob', name: 'Bob' },
      web_url: `${MOCK_BASE}/PAM/pas-api/merge_requests/77`,
    })

    const stats = await reconcileOnce()

    expect(stats.closedSynced).toBe(1)
    expect((await getBugAnalysisReportById(reportId))?.status).toBe('aborted')

    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents[0].data).toMatchObject({
      mrAction: 'close',
      closedBy: 'bob',
      source: 'reconciler',
    })
  })

  it('幂等：两次 reconcileOnce 只调一次 GitLab（第二次从已有 lifecycle_sync 跳过）', async () => {
    const productLineId = await seedProductLine()
    const reportId = await seedReport(productLineId)
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 88)

    await injectMockResponse('PAM/pas-api', 88, {
      iid: 88,
      state: 'merged',
      merged_at: '2026-04-20T12:00:00Z',
      merged_by: { username: 'alice', name: 'Alice' },
      closed_at: null,
      closed_by: null,
      web_url: `${MOCK_BASE}/PAM/pas-api/merge_requests/88`,
    })

    // 第 1 次：发真实 HTTP
    await reconcileOnce()
    const callsAfter1 = mockServer.getState().calls.filter(
      c => c.method === 'GET' && c.path.includes('/merge_requests/88'),
    )
    expect(callsAfter1).toHaveLength(1)

    // 第 2 次：幂等跳过，不再调 GitLab
    await reconcileOnce()
    const callsAfter2 = mockServer.getState().calls.filter(
      c => c.method === 'GET' && c.path.includes('/merge_requests/88'),
    )
    expect(callsAfter2).toHaveLength(1) // 仍是 1

    // lifecycle_sync 也只有一条
    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(1)
  })
})
