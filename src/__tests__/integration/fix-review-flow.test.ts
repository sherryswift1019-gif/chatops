/**
 * 集成测试：L1 修复链路 + AI Review（非钉钉触发）
 *
 * 1. 从 bug_analysis_reports 读取分析报告
 * 2. fix_code 工具在 worktree 中修改文件
 * 3. run_tests 工具执行命令
 * 4. create_mr 工具创建 GitLab MR
 * 5. review_mr_diff 工具读取 MR diff
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import { createBugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'
import { acquire, remove } from '../../agent/worktree/manager.js'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

describe('Integration: L1 修复链路（非钉钉）', () => {
  let productLineId: number
  let worktree: any

  beforeAll(async () => {
    await resetTestDb()
    const pool = getPool()
    const { rows } = await pool.query(
      `INSERT INTO product_lines (name, display_name, description) VALUES ('pam', 'PAM', 'test') ON CONFLICT (name) DO NOTHING RETURNING id`
    )
    productLineId = rows[0]?.id ?? (await pool.query(`SELECT id FROM product_lines WHERE name = 'pam'`)).rows[0].id

    await pool.query(
      `INSERT INTO product_knowledge_repos (product_line_id, code_repo_url, code_default_branch, knowledge_repo_url, ai_summary_path)
       VALUES ($1, 'http://code.paraview.cn/PAM/java-code/pas-6.0.git', 'test', '', 'docs/ai-summary')
       ON CONFLICT (product_line_id) DO NOTHING`, [productLineId]
    )

    // 创建 worktree
    worktree = await acquire({
      userId: 'test-fix',
      product: `pl-${productLineId}`,
      version: 'test',
      sessionId: `fix-test-${Date.now()}`,
      repoUrl: 'http://code.paraview.cn/PAM/java-code/pas-6.0.git',
    })
  })

  afterAll(async () => {
    if (worktree) await remove(worktree).catch(() => {})
  })

  // ─── Step 1: 模拟分析报告 ────────────────────────────

  it('Step 1: 创建模拟分析报告（L1 配置类）', async () => {
    const report = await createBugAnalysisReport({
      issueId: 100,
      issueUrl: 'http://code.paraview.cn/PAM/java-code/pas-6.0/-/issues/100',
      productLineId,
      agentSessionId: 'fix-test',
      level: 'l1',
      classification: 'bug',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCauseSummary: '初始化 SQL 缺少 TASK_PWD_4001 错误码',
      solutionsJson: [{ id: 'a', summary: '在 sql 目录新增 INSERT 语句', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['pas-secret-task'],
      analysisSteps: ['Phase 1: 读代码'],
      metadata: null,
    })

    expect(report.id).toBeGreaterThan(0)
    ;(globalThis as any).__testReportId = report.id
  })

  // ─── Step 2: fix_code 工具写文件 ─────────────────────

  it('Step 2: fix_code 在 worktree 中写文件', async () => {
    const { fixCodeTool } = await import('../../agent/tools/fix-code.js')

    const result = await fixCodeTool.execute(
      { path: 'test-fix-output.sql', content: "INSERT INTO error_codes (code, message) VALUES ('TASK_PWD_4001', '密码验证失败');\n" },
      { taskId: 'fix-test', groupId: 'test', platform: 'test', initiatorId: 'test', initiatorRole: 'admin' as const, cwd: worktree.path }
    )

    console.log('[Step 2] fix_code result:', result.output)
    expect(result.success).toBe(true)

    // 验证文件确实写入了
    const filePath = join(worktree.path, 'test-fix-output.sql')
    expect(existsSync(filePath)).toBe(true)
    const content = readFileSync(filePath, 'utf8')
    expect(content).toContain('TASK_PWD_4001')
  })

  // ─── Step 3: run_tests 工具执行命令 ──────────────────

  it('Step 3: run_tests 执行简单命令', async () => {
    const { runTestsTool } = await import('../../agent/tools/run-tests.js')

    const result = await runTestsTool.execute(
      { command: 'echo "test passed"', timeout: 10000 },
      { taskId: 'fix-test', groupId: 'test', platform: 'test', initiatorId: 'test', initiatorRole: 'admin' as const, cwd: worktree.path }
    )

    console.log('[Step 3] run_tests result:', result.success, result.output.substring(0, 100))
    expect(result.success).toBe(true)
    expect(result.output).toContain('test passed')
  })

  // ─── Step 4: update_ai_summary 工具 ──────────────────

  it('Step 4: update_ai_summary 更新摘要', async () => {
    const { updateAiSummaryTool } = await import('../../agent/tools/update-ai-summary.js')

    const result = await updateAiSummaryTool.execute(
      { module: 'pas-secret-task', changesDescription: '修复 TASK_PWD_4001 错误码缺失' },
      { taskId: 'fix-test', groupId: 'test', platform: 'test', initiatorId: 'test', initiatorRole: 'admin' as const, cwd: worktree.path }
    )

    console.log('[Step 4] update_ai_summary result:', result.output)
    expect(result.success).toBe(true)

    const summaryPath = join(worktree.path, 'docs', 'ai', 'pas-secret-task.md')
    expect(existsSync(summaryPath)).toBe(true)
    const content = readFileSync(summaryPath, 'utf8')
    expect(content).toContain('TASK_PWD_4001')
  })

  // ─── Step 5: review_mr_diff 工具 ─────────────────────

  it('Step 5: review_mr_diff 能读取 MR（用已有 MR 测试）', async () => {
    const { reviewMrDiffTool } = await import('../../agent/tools/review-mr-diff.js')

    // 用 PAM 项目中的一个已存在的 MR（iid=1 通常存在）
    const result = await reviewMrDiffTool.execute(
      { projectPath: 'PAM/java-code/pas-6.0', mrIid: 1 },
      { taskId: 'review-test', groupId: 'test', platform: 'test', initiatorId: 'test', initiatorRole: 'admin' as const }
    )

    console.log('[Step 5] review_mr_diff result:', result.success, result.output.substring(0, 200))
    // MR 可能不存在，但工具本身应该不崩溃
    if (result.success) {
      expect(result.output).toContain('MR')
    } else {
      console.log('[Step 5] MR 不存在或无法读取（非关键）:', result.output.substring(0, 100))
    }
  }, 30_000)

  // ─── Step 6: switch_version 工具 ─────────────────────

  it('Step 6: switch_version 能切换分支', async () => {
    const { switchVersionTool } = await import('../../agent/tools/switch-version.js')

    const result = await switchVersionTool.execute(
      { branch: 'test' },
      { taskId: 'switch-test', groupId: 'test', platform: 'test', initiatorId: 'test', initiatorRole: 'admin' as const, cwd: worktree.path }
    )

    console.log('[Step 6] switch_version result:', result.output)
    expect(result.success).toBe(true)
    expect(result.output).toContain('test')
  })

  // ─── Step 7: search_knowledge 工具 ──────────────────

  it('Step 7: search_knowledge 查询（空知识库返回 no_match）', async () => {
    const { searchKnowledgeTool } = await import('../../agent/tools/search-knowledge.js')

    const result = await searchKnowledgeTool.execute(
      { query: 'TASK_PWD_4001 密码验证失败', product: 'pam' },
      { taskId: 'search-test', groupId: 'test', platform: 'test', initiatorId: 'test', initiatorRole: 'admin' as const }
    )

    console.log('[Step 7] search_knowledge result:', result.output.substring(0, 100))
    expect(result.success).toBe(true)
    // 空知识库应该返回 no_match
    expect(result.output).toContain('no_match')
  })

  // ─── Step 8: 敏感信息脱敏 ──────────────────────────

  it('Step 8: 敏感信息脱敏覆盖', async () => {
    const { mask } = await import('../../agent/masking/sensitive-info.js')

    const input = '连接到 192.168.1.50 失败，password=abc123，token=sk-ant-api03-verylongkey'
    const masked = mask(input)

    expect(masked).not.toContain('192.168.1.50')
    expect(masked).not.toContain('abc123')
    expect(masked).toContain('[MASKED_IP]')
    expect(masked).toContain('[MASKED]')
  })
})
