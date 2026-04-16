/**
 * 集成测试：Webhook → Handler → Coordinator 完整链路
 * 模拟 GitLab Webhook 请求，验证从 HTTP 到 Agent 触发的完整流程
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import { createBugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'
import { GitLabWebhookReceiver } from '../../adapters/gitlab/webhook-receiver.js'
import { registerCapabilityHandler, triggerCapability } from '../../agent/coordinator.js'
import { vi } from 'vitest'

describe('Integration: Webhook → Handler → Coordinator', () => {
  let productLineId: number
  let receiver: GitLabWebhookReceiver

  beforeAll(async () => {
    await resetTestDb()
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO product_lines (name, display_name, description) VALUES ('pam', 'PAM', 'test') ON CONFLICT (name) DO NOTHING RETURNING id`
    )
    productLineId = rows[0]?.id ?? (await pool.query(`SELECT id FROM product_lines WHERE name = 'pam'`)).rows[0].id

    receiver = new GitLabWebhookReceiver('test-secret')
  })

  // ─── Token 校验 ─────────────────────────────────────

  it('错误 token 被拒绝', async () => {
    await expect(
      receiver.handle(
        { object_kind: 'issue', object_attributes: { iid: 1, action: 'update' } },
        { 'x-gitlab-token': 'wrong-token' }
      )
    ).rejects.toThrow('Invalid token')
  })

  it('正确 token 通过', async () => {
    await expect(
      receiver.handle(
        { object_kind: 'issue', object_attributes: { iid: 1, title: 'test', action: 'update', labels: [] }, project: { path_with_namespace: 'test/repo' }, changes: { labels: { previous: [], current: [] } } },
        { 'x-gitlab-token': 'test-secret' }
      )
    ).resolves.not.toThrow()
  })

  // ─── Issue approved → 触发 fix_bug_l3 ───────────────

  it('Issue label 变为 approved → 触发 fix_bug_l3', async () => {
    // 先创建分析报告（handler 需要查 DB）
    await createBugAnalysisReport({
      issueId: 3,
      issueUrl: 'http://code.paraview.cn/issues/3',
      productLineId,
      agentSessionId: null,
      level: 'l3',
      classification: 'bug',
      confidence: 'medium',
      confidenceScore: 0.65,
      rootCauseSummary: 'JDBC 错误码丢失',
      solutionsJson: [{ id: 'a', summary: '捕获 SQLException.getErrorCode()', recommended: true, risk: 'low', effort: 'medium' }],
      affectedModules: ['pas-secret-task'],
      analysisSteps: ['读代码'],
      metadata: null,
    })

    // 注册一个 mock handler 捕获触发
    const triggered: string[] = []
    registerCapabilityHandler('fix_bug_l3', async (opts) => {
      triggered.push(opts.capabilityKey)
      console.log('[Test] fix_bug_l3 triggered with:', JSON.stringify(opts.extraParams))
      return { success: true, output: 'mock fix' }
    })

    // 确保 DB 有 fix_bug_l3 capability
    const pool = getPool()
    await pool.query(`INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval) VALUES ('fix_bug_l3', 'L3 修复', 'test', 'action', '[]', true) ON CONFLICT (key) DO NOTHING`)

    // 模拟 Webhook
    await receiver.handle(
      {
        object_kind: 'issue',
        object_attributes: {
          iid: 3,
          title: 'JDBC 错误码丢失',
          action: 'update',
          labels: [{ title: 'approved' }, { title: 'level-l3' }],
        },
        project: { path_with_namespace: 'PAM/java-code/pas-6.0' },
        changes: {
          labels: {
            previous: [{ title: 'needs-approval' }],
            current: [{ title: 'approved' }, { title: 'level-l3' }],
          },
        },
      },
      { 'x-gitlab-token': 'test-secret' }
    )

    // 等异步触发
    await new Promise(r => setTimeout(r, 500))

    expect(triggered).toContain('fix_bug_l3')
  })

  // ─── MR ai-generated → 触发 ai_review_mr ────────────

  it('MR 创建 + ai-generated label → 触发 ai_review_mr', async () => {
    const triggered: string[] = []
    registerCapabilityHandler('ai_review_mr', async (opts) => {
      triggered.push(opts.capabilityKey)
      console.log('[Test] ai_review_mr triggered with:', JSON.stringify(opts.extraParams))
      return { success: true, output: 'mock review' }
    })

    const pool = getPool()
    await pool.query(`INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval) VALUES ('ai_review_mr', 'AI Review', 'test', 'action', '[]', false) ON CONFLICT (key) DO NOTHING`)

    await receiver.handle(
      {
        object_kind: 'merge_request',
        object_attributes: {
          iid: 100,
          title: 'fix(l1): TASK_PWD_4001',
          action: 'open',
          source_branch: 'fix/issue-42',
          target_branch: 'test',
          labels: [{ title: 'ai-generated' }, { title: 'level-l1' }],
        },
        project: { path_with_namespace: 'PAM/java-code/pas-6.0' },
      },
      { 'x-gitlab-token': 'test-secret' }
    )

    await new Promise(r => setTimeout(r, 500))

    expect(triggered).toContain('ai_review_mr')
  })

  // ─── 非 approved label 不触发 ───────────────────────

  it('Issue label 变为 fixing 不触发修复（L1/L2 由 handleAnalysisComplete 触发）', async () => {
    const triggered: string[] = []
    registerCapabilityHandler('fix_bug_l1', async (opts) => {
      triggered.push(opts.capabilityKey)
      return { success: true, output: 'should not happen' }
    })

    await receiver.handle(
      {
        object_kind: 'issue',
        object_attributes: {
          iid: 5,
          title: '并发主键冲突',
          action: 'update',
          labels: [{ title: 'fixing' }, { title: 'level-l1' }],
        },
        project: { path_with_namespace: 'PAM/java-code/pas-6.0' },
        changes: {
          labels: {
            previous: [{ title: 'graded' }],
            current: [{ title: 'fixing' }, { title: 'level-l1' }],
          },
        },
      },
      { 'x-gitlab-token': 'test-secret' }
    )

    await new Promise(r => setTimeout(r, 200))

    expect(triggered).not.toContain('fix_bug_l1')
  })

  // ─── 非 ai-generated MR 不触发 Review ──────────────

  it('人工 MR 不触发 AI Review', async () => {
    const triggered: string[] = []
    registerCapabilityHandler('ai_review_mr', async (opts) => {
      triggered.push('review-' + (opts.extraParams?.mrIid ?? ''))
      return { success: true, output: 'should not happen' }
    })

    await receiver.handle(
      {
        object_kind: 'merge_request',
        object_attributes: {
          iid: 200,
          title: '人工 MR',
          action: 'open',
          source_branch: 'feature/xxx',
          target_branch: 'test',
          labels: [],
        },
        project: { path_with_namespace: 'PAM/java-code/pas-6.0' },
      },
      { 'x-gitlab-token': 'test-secret' }
    )

    await new Promise(r => setTimeout(r, 200))

    expect(triggered).not.toContain('review-200')
  })
})
