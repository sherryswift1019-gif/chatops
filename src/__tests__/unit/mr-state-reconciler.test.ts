/**
 * mr-state-reconciler 单测
 *
 * 覆盖 8 个场景（见 docs/superpowers/plans/2026-04-20-mr-state-reconciliation.md Task 2）：
 *   1. pipeline_success + MR merged → 写 lifecycle_sync + status=completed
 *   2. pipeline_success + MR closed → 写 lifecycle_sync + status=aborted
 *   3. pipeline_success + MR opened → 不动
 *   4. 已有 lifecycle_sync(merge) 事件 → 跳过，不重复写
 *   5. 扫描窗口过期（> windowDays）→ 不扫描
 *   6. GitLab 返回 500 → 当前 MR 跳过，继续处理，函数正常返回
 *   7. 多 project：全终态才更新 status（D5 语义）
 *   8. 并发受 concurrency 控制（pLimit 行为验证）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { reconcileOnce } from '../../agent/reconcile/mr-state-reconciler.js'
import { gitlabGetMr, type GitLabMr } from '../../agent/analysis/gitlab-mr.js'
import {
  createEvent,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'

// Mock GitLab MR API
vi.mock('../../agent/analysis/gitlab-mr.js', () => ({
  gitlabGetMr: vi.fn(),
}))

// ────────────────────────────────────────────────────────────────
// Seed 辅助
// ────────────────────────────────────────────────────────────────

async function seedProductLine(): Promise<number> {
  const pool = getTestPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('pam', 'PAM', 'reconciler-test')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
  )
  return rows[0].id as number
}

interface SeedReportOptions {
  productLineId: number
  status?: 'pipeline_success' | 'completed' | 'aborted' | 'published'
  issueId?: number
  primaryProjectPath?: string
  /** 控制 created_at（默认 now），用于窗口过期测试 */
  createdAt?: string
}

async function seedReport(opts: SeedReportOptions): Promise<number> {
  const pool = getTestPool()
  const issueId = opts.issueId ?? Math.floor(Math.random() * 1_000_000)
  const { rows } = await pool.query(
    `INSERT INTO bug_analysis_reports
       (issue_id, issue_url, product_line_id, level, classification, confidence, solutions_json, status, primary_project_path, created_at)
     VALUES ($1, $2, $3, 'l2', 'bug', 'high', '[]'::jsonb, $4, $5, COALESCE($6::timestamptz, now()))
     RETURNING id`,
    [
      issueId,
      `http://mock-gitlab/PAM/pas-api/-/issues/${issueId}`,
      opts.productLineId,
      opts.status ?? 'pipeline_success',
      opts.primaryProjectPath ?? 'PAM/pas-api',
      opts.createdAt ?? null,
    ],
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
    data: {
      mrIid,
      mrUrl: `http://mock-gitlab/${projectPath}/merge_requests/${mrIid}`,
    },
  })
}

function mockMr(overrides: Partial<GitLabMr>): GitLabMr {
  return {
    iid: 1,
    state: 'opened',
    merged_at: null,
    merged_by: null,
    closed_at: null,
    closed_by: null,
    web_url: 'http://mock-gitlab/x',
    ...overrides,
  }
}

// ────────────────────────────────────────────────────────────────
// 测试
// ────────────────────────────────────────────────────────────────

describe('mr-state-reconciler.reconcileOnce', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(gitlabGetMr).mockReset()
  })

  it('[1] pipeline_success + MR merged → 写 lifecycle_sync + status=completed', async () => {
    const productLineId = await seedProductLine()
    const reportId = await seedReport({ productLineId })
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 55)

    vi.mocked(gitlabGetMr).mockResolvedValue(
      mockMr({
        iid: 55,
        state: 'merged',
        merged_at: '2026-04-20T00:00:00Z',
        merged_by: { username: 'alice', name: 'Alice' },
      }),
    )

    const stats = await reconcileOnce()

    expect(stats.scanned).toBe(1)
    expect(stats.mergedSynced).toBe(1)
    expect(stats.closedSynced).toBe(0)
    expect(stats.failures).toHaveLength(0)

    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('completed')

    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(1)
    expect(syncEvents[0].data).toMatchObject({
      mrAction: 'merge',
      mrIid: 55,
      targetStatus: 'completed',
      mergedBy: 'alice',
      source: 'reconciler',
    })
  })

  it('[2] pipeline_success + MR closed → 写 lifecycle_sync + status=aborted', async () => {
    const productLineId = await seedProductLine()
    const reportId = await seedReport({ productLineId })
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 77)

    vi.mocked(gitlabGetMr).mockResolvedValue(
      mockMr({
        iid: 77,
        state: 'closed',
        closed_at: '2026-04-20T01:00:00Z',
        closed_by: { username: 'bob', name: 'Bob' },
      }),
    )

    const stats = await reconcileOnce()

    expect(stats.closedSynced).toBe(1)
    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('aborted')

    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents[0].data).toMatchObject({
      mrAction: 'close',
      mrIid: 77,
      targetStatus: 'aborted',
      closedBy: 'bob',
      source: 'reconciler',
    })
  })

  it('[3] pipeline_success + MR opened → 不写事件，不更新 status', async () => {
    const productLineId = await seedProductLine()
    const reportId = await seedReport({ productLineId })
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 33)

    vi.mocked(gitlabGetMr).mockResolvedValue(mockMr({ iid: 33, state: 'opened' }))

    const stats = await reconcileOnce()

    expect(stats.mergedSynced).toBe(0)
    expect(stats.closedSynced).toBe(0)
    expect(stats.skipped).toBe(1)

    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('pipeline_success') // 保持原样

    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(0)
  })

  it('[4] 已有 lifecycle_sync(merge) 事件 → 跳过，不重复调 GitLab，不重复写', async () => {
    const productLineId = await seedProductLine()
    const reportId = await seedReport({ productLineId })
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 88)
    // 模拟 webhook 已经写过 lifecycle_sync
    await createEvent({
      reportId,
      projectPath: 'PAM/pas-api',
      code: 'lifecycle_sync',
      status: 'success',
      data: {
        mrAction: 'merge',
        mrIid: 88,
        targetStatus: 'completed',
        source: 'webhook',
      },
    })

    await reconcileOnce()

    expect(vi.mocked(gitlabGetMr)).not.toHaveBeenCalled()

    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(1)
    expect((syncEvents[0].data as Record<string, unknown>).source).toBe('webhook')
  })

  it('[5] 扫描窗口过期（> windowDays）→ 报告不被扫描', async () => {
    const productLineId = await seedProductLine()
    // 创建一个 8 天前的 report
    const reportId = await seedReport({
      productLineId,
      createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(),
    })
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 101)

    // 用默认 windowDays=7
    const stats = await reconcileOnce({ windowDays: 7 })

    expect(stats.scanned).toBe(0)
    expect(vi.mocked(gitlabGetMr)).not.toHaveBeenCalled()

    // 把 windowDays 调到 10 天，应该能扫到
    vi.mocked(gitlabGetMr).mockResolvedValue(mockMr({ iid: 101, state: 'opened' }))
    const stats2 = await reconcileOnce({ windowDays: 10 })
    expect(stats2.scanned).toBe(1)
  })

  it('[6] GitLab 返回错误 → 当前 MR 进 failures，函数正常返回', async () => {
    const productLineId = await seedProductLine()
    const reportId1 = await seedReport({ productLineId })
    const reportId2 = await seedReport({ productLineId })
    await seedCreateMrEvent(reportId1, 'PAM/pas-api', 1)
    await seedCreateMrEvent(reportId2, 'PAM/pas-api', 2)

    // MR 1 挂，MR 2 正常 merged
    vi.mocked(gitlabGetMr).mockImplementation(async ({ mrIid }) => {
      if (mrIid === 1) throw new Error('500 Internal Server Error')
      return mockMr({ iid: 2, state: 'merged' })
    })

    const stats = await reconcileOnce()

    expect(stats.scanned).toBe(2)
    expect(stats.failures).toHaveLength(1)
    expect(stats.failures[0]).toMatchObject({
      reportId: reportId1,
      mrIid: 1,
    })
    expect(stats.mergedSynced).toBe(1) // report 2 正常处理

    // report 1 因 MR 查询失败保持 pipeline_success（未终态 → 不更新）
    expect((await getBugAnalysisReportById(reportId1))?.status).toBe('pipeline_success')
    // report 2 已 merged
    expect((await getBugAnalysisReportById(reportId2))?.status).toBe('completed')
  })

  it('[7a] 多 project 全 merged → status=completed', async () => {
    const productLineId = await seedProductLine()
    const reportId = await seedReport({ productLineId })
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 10)
    await seedCreateMrEvent(reportId, 'PAM/pas-web', 20)

    vi.mocked(gitlabGetMr).mockImplementation(async ({ mrIid }) =>
      mockMr({ iid: mrIid, state: 'merged' }),
    )

    await reconcileOnce()

    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('completed')

    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(2)
  })

  it('[7b] 多 project 一 merged 一 closed → status=aborted（任一 closed 即异常）', async () => {
    const productLineId = await seedProductLine()
    const reportId = await seedReport({ productLineId })
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 11)
    await seedCreateMrEvent(reportId, 'PAM/pas-web', 21)

    vi.mocked(gitlabGetMr).mockImplementation(async ({ mrIid }) => {
      if (mrIid === 11) return mockMr({ iid: 11, state: 'merged' })
      return mockMr({ iid: 21, state: 'closed' })
    })

    await reconcileOnce()

    expect((await getBugAnalysisReportById(reportId))?.status).toBe('aborted')
  })

  it('[7c] 多 project 一 merged 一 opened → 不更新 status（未全终态）', async () => {
    const productLineId = await seedProductLine()
    const reportId = await seedReport({ productLineId })
    await seedCreateMrEvent(reportId, 'PAM/pas-api', 12)
    await seedCreateMrEvent(reportId, 'PAM/pas-web', 22)

    vi.mocked(gitlabGetMr).mockImplementation(async ({ mrIid }) => {
      if (mrIid === 12) return mockMr({ iid: 12, state: 'merged' })
      return mockMr({ iid: 22, state: 'opened' })
    })

    await reconcileOnce()

    // MR 12 应该写入了 lifecycle_sync（本 MR 单独幂等），但 status 不动
    const syncEvents = await findByReportCode(reportId, 'lifecycle_sync')
    expect(syncEvents).toHaveLength(1)
    expect(syncEvents[0].data).toMatchObject({ mrAction: 'merge', mrIid: 12 })

    expect((await getBugAnalysisReportById(reportId))?.status).toBe('pipeline_success')
  })

  it('[8] 并发受 concurrency 控制（peak <= N）', async () => {
    const productLineId = await seedProductLine()
    // 造 5 个 report，每个一个 MR
    const reportIds: number[] = []
    for (let i = 0; i < 5; i++) {
      const rid = await seedReport({ productLineId, issueId: 1000 + i })
      await seedCreateMrEvent(rid, 'PAM/pas-api', 500 + i)
      reportIds.push(rid)
    }

    let running = 0
    let peak = 0
    vi.mocked(gitlabGetMr).mockImplementation(async ({ mrIid }) => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 20))
      running--
      return mockMr({ iid: mrIid, state: 'merged' })
    })

    const stats = await reconcileOnce({ concurrency: 2 })

    expect(peak).toBeLessThanOrEqual(2)
    expect(stats.mergedSynced).toBe(5)
  })
})
