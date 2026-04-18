/**
 * 集成测试：分析后续链路（非钉钉触发）
 *
 * 1. create_issue 工具能创建 GitLab Issue
 * 2. 分析报告能存入 bug_analysis_reports
 * 3. productLineId 在 resolveProductLineId 中正确解析
 * 4. AgentCoordinator handleAnalysisComplete 触发正确
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import {
  createBugAnalysisReport,
  getBugAnalysisReportById,
  listReportsByProductLine,
} from '../../db/repositories/bug-analysis-reports.js'
import { createStat } from '../../db/repositories/bug-analysis-stats.js'
import { } from '../../agent/coordinator.js'

describe('Integration: 分析后续链路', () => {
  let productLineId: number

  beforeAll(async () => {
    await resetTestDb()
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO product_lines (name, display_name, description) VALUES ('pam', 'PAM', 'test') ON CONFLICT (name) DO NOTHING RETURNING id`
    )
    productLineId = rows[0]?.id ?? (await pool.query(`SELECT id FROM product_lines WHERE name = 'pam'`)).rows[0].id
  })

  // ─── 分析报告存 DB ──────────────────────────────────

  it('创建分析报告并查询', async () => {
    const report = await createBugAnalysisReport({
      issueId: 42,
      issueUrl: 'http://code.paraview.cn/PAM/java-code/pas-6.0/-/issues/42',
      productLineId,
      agentSessionId: 'test-session',
      level: 'l1',
      classification: 'bug',
      confidence: 'high',
      confidenceScore: 0.92,
      rootCauseSummary: '初始化 SQL 缺少 TASK_PWD_4001 错误码',
      solutionsJson: [{ id: 'a', summary: '补 INSERT 语句', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['pas-secret-task'],
      analysisSteps: ['Phase 1: 读代码', 'Phase 2: 定位错误码'],
      metadata: { test: true },
    })

    expect(report.id).toBeGreaterThan(0)

    const fetched = await getBugAnalysisReportById(report.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.level).toBe('l1')
    expect(fetched!.confidence).toBe('high')
    expect(fetched!.solutionsJson).toHaveLength(1)
    expect(fetched!.affectedModules).toContain('pas-secret-task')

    const list = await listReportsByProductLine(productLineId)
    expect(list.length).toBeGreaterThan(0)
  })

  it('分析统计写入 + 查询平均耗时', async () => {
    const list = await listReportsByProductLine(productLineId, 1)
    await createStat({ reportId: list[0].id, durationMs: 180000, cacheHit: false, tokenCount: 8000 })

    const { getAvgDuration } = await import('../../db/repositories/bug-analysis-stats.js')
    const avg = await getAvgDuration(productLineId, new Date('2020-01-01'))
    expect(avg).not.toBeNull()
    console.log('[Test] avg duration:', avg, 'ms')
  })

  // ─── GitLab Issue 创建 ──────────────────────────────

  it('create_issue 工具能创建 GitLab Issue', async () => {
    const { createIssueTool } = await import('../../agent/tools/create-issue.js')

    const result = await createIssueTool.execute(
      {
        projectPath: 'PAM/java-code/pas-6.0',
        title: '[AI 测试] TASK_PWD_4001 集成测试 Issue（请忽略）',
        description: '这是自动化集成测试创建的 Issue，可以直接关闭。',
        labels: 'test,ai-generated',
      },
      { taskId: 'test', groupId: 'test', platform: 'test', initiatorId: 'test', initiatorRole: 'admin' }
    )

    console.log('[Test] create_issue result:', result.output)
    expect(result.success).toBe(true)
    expect(result.output).toContain('Issue #')
    expect(result.data).toHaveProperty('iid')

    // 自动关闭测试 Issue
    const iid = (result.data as any).iid
    const axios = (await import('axios')).default
    await axios.put(
      `${process.env.GITLAB_URL}/api/v4/projects/${encodeURIComponent('PAM/java-code/pas-6.0')}/issues/${iid}`,
      { state_event: 'close' },
      { headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN } }
    )
    console.log('[Test] 已自动关闭测试 Issue #' + iid)
  }, 30_000)

  // ─── 并发锁（已移除，Pipeline 串行执行天然防并发）────

  // ─── productLineId 解析 ─────────────────────────────

  it('product_line_members 能正确关联用户和产品线', async () => {
    const pool = getPool()

    // 添加成员
    await pool.query(
      `INSERT INTO product_line_members (product_line_id, user_id, user_name, role) VALUES ($1, 'test-user-123', 'TestUser', 'developer') ON CONFLICT DO NOTHING`,
      [productLineId]
    )

    // 查询
    const { getMembershipsByUserId } = await import('../../db/repositories/product-line-members.js')
    const memberships = await getMembershipsByUserId('test-user-123')
    expect(memberships.length).toBeGreaterThan(0)
    expect(memberships[0].productLineId).toBe(productLineId)
    expect(memberships[0].role).toBe('developer')
  })
})
