/**
 * 集成测试：端到端验证 analyze_bug + search_knowledge + AgentCoordinator
 * 需要：PostgreSQL + ANTHROPIC_API_KEY + Claude CLI
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { createBugAnalysisReport, getBugAnalysisReportById, listReportsByProductLine } from '../../db/repositories/bug-analysis-reports.js'
import { createProductKnowledgeRepo, getByProductLineId } from '../../db/repositories/product-knowledge-repos.js'
import { incrementHit, getTopHits } from '../../db/repositories/knowledge-hit-stats.js'
import { createStat, getAvgDuration } from '../../db/repositories/bug-analysis-stats.js'
import { createAttribution, getByIssueId as getAttributionsByIssueId, countByType } from '../../db/repositories/root-cause-attribution.js'
import { upsertMetric, getMetricRange } from '../../db/repositories/metrics-daily.js'
import { parseAnalysisOutput, buildMarkdownReport } from '../../agent/analysis/analyzer.js'
import { mask } from '../../agent/masking/sensitive-info.js'
import { extractQueryFromText } from '../../agent/knowledge/index-matcher.js'
import { retryWithDowngrade } from '../../agent/fix/retry-handler.js'
import { triggerCapability, registerCapabilityHandler } from '../../agent/coordinator.js'

// 需要 product_lines 表有数据才能测 FK 约束
async function ensureProductLine(): Promise<number> {
  const pool = getPool()
  const { rows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description) VALUES ('test-pam', 'Test PAM', 'Test PAM 产品线') ON CONFLICT (name) DO NOTHING RETURNING id`
  )
  if (rows.length > 0) return rows[0].id
  const existing = await pool.query(`SELECT id FROM product_lines WHERE name = 'test-pam'`)
  return existing.rows[0].id
}

describe('Integration: 新增 Repository CRUD', () => {
  let productLineId: number

  beforeAll(async () => {
    await resetTestDb()
    productLineId = await ensureProductLine()
  })

  // ─── bug_analysis_reports ───

  it('creates and retrieves bug analysis report', async () => {
    const report = await createBugAnalysisReport({
      issueId: 1001,
      issueUrl: 'https://code.paraview.cn/issues/1001',
      productLineId,
      agentSessionId: 'session-abc',
      level: 'l1',
      classification: 'bug',
      confidence: 'high',
      confidenceScore: 0.92,
      rootCauseSummary: '初始化 SQL 缺少 TASK_PWD_4001 错误码',
      solutionsJson: [{ id: 'a', summary: '添加 INSERT', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['pas-secret-task'],
      analysisSteps: ['Phase 1: 读代码', 'Phase 2: 对比'],
      metadata: { test: true },
    })

    expect(report.id).toBeGreaterThan(0)
    expect(report.level).toBe('l1')
    expect(report.confidence).toBe('high')
    expect(report.solutionsJson).toHaveLength(1)

    const fetched = await getBugAnalysisReportById(report.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.issueId).toBe(1001)
    expect(fetched!.affectedModules).toContain('pas-secret-task')
  })

  it('lists reports by product line', async () => {
    const reports = await listReportsByProductLine(productLineId)
    expect(reports.length).toBeGreaterThan(0)
  })

  // ─── product_knowledge_repos ───

  it('creates and retrieves knowledge repo config', async () => {
    await createProductKnowledgeRepo({
      productLineId,
      codeRepoUrl: 'git@code.paraview.cn:pam/pas.git',
      codeDefaultBranch: 'develop',
      knowledgeRepoUrl: 'git@code.paraview.cn:pam/pam-knowledge.git',
      aiSummaryPath: 'docs/ai',
      imageStorageConfig: { type: 'local', path: '/opt/knowledge/images' },
    })

    const repo = await getByProductLineId(productLineId)
    expect(repo).not.toBeNull()
    expect(repo!.codeRepoUrl).toContain('pas.git')
    expect(repo!.aiSummaryPath).toBe('docs/ai')
  })

  // ─── knowledge_hit_stats ───

  it('increments hit count with upsert', async () => {
    await incrementHit('pgsql-case', productLineId)
    await incrementHit('pgsql-case', productLineId)
    await incrementHit('pgsql-case', productLineId)

    const top = await getTopHits(productLineId)
    expect(top.length).toBeGreaterThan(0)
    expect(top[0].entryId).toBe('pgsql-case')
    expect(top[0].hitCount).toBe(3)
  })

  // ─── bug_analysis_stats ───

  it('creates stat and queries avg duration', async () => {
    const reports = await listReportsByProductLine(productLineId, 1)
    await createStat({ reportId: reports[0].id, durationMs: 120000, cacheHit: false, tokenCount: 5000 })
    await createStat({ reportId: reports[0].id, durationMs: 60000, cacheHit: true, tokenCount: 2000 })

    const avg = await getAvgDuration(productLineId, new Date('2020-01-01'))
    expect(avg).not.toBeNull()
    expect(avg).toBe(90000) // (120000 + 60000) / 2
  })

  // ─── root_cause_attributions ───

  it('creates attribution and counts by type', async () => {
    const reports = await listReportsByProductLine(productLineId, 1)
    await createAttribution({ issueId: 1001, reportId: reports[0].id, rootCauseType: 'syntax', context: 'SQL 缺失', attributedBy: 'ai' })
    await createAttribution({ issueId: 1002, reportId: reports[0].id, rootCauseType: 'syntax', context: '空指针', attributedBy: 'ai' })
    await createAttribution({ issueId: 1003, reportId: reports[0].id, rootCauseType: 'business_logic', context: '流程错误', attributedBy: 'user:hanff' })

    const counts = await countByType(productLineId, new Date('2020-01-01'))
    expect(counts.length).toBeGreaterThan(0)
    const syntaxCount = counts.find((c: any) => c.root_cause_type === 'syntax' || c.rootCauseType === 'syntax')
    expect(syntaxCount).toBeDefined()
  })

  // ─── metrics_daily ───

  it('upserts daily metric and queries range', async () => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    await upsertMetric(today, productLineId, 'analysis_count', 15)
    await upsertMetric(today, productLineId, 'analysis_count', 20) // upsert 覆盖

    const metrics = await getMetricRange(productLineId, 'analysis_count', new Date('2020-01-01'), new Date('2030-01-01'))
    expect(metrics.length).toBeGreaterThan(0)
    expect(Number(metrics[0].metricValue)).toBe(20) // 被覆盖为 20
  })
})

describe('Integration: 新增 Capability 验证', () => {
  beforeAll(async () => { await resetTestDb() })

  const expectedCaps = ['analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3', 'ai_review_mr', 'search_knowledge']

  it.each(expectedCaps)('capability "%s" exists in DB', async (key) => {
    const cap = await getCapabilityByKey(key)
    expect(cap).not.toBeNull()
    expect(cap!.key).toBe(key)
    expect(cap!.toolNames.length).toBeGreaterThan(0)
  })
})

describe('Integration: AgentCoordinator 调度', () => {
  it('triggers registered handler and returns result', async () => {
    const results: string[] = []
    registerCapabilityHandler('test_integration_cap', async (opts) => {
      results.push(opts.capabilityKey)
      return { success: true, output: 'handled' }
    })

    // Mock DB to find capability
    const pool = getPool()
    await pool.query(
      `INSERT INTO capabilities (key, display_name, description, tool_names) VALUES ('test_integration_cap', 'Test', 'Test', '[]') ON CONFLICT (key) DO NOTHING`
    )

    const result = await triggerCapability({
      capabilityKey: 'test_integration_cap',
      context: { taskId: 'int-1', groupId: 'g1', platform: 'test', initiatorId: 'u1', initiatorRole: 'admin' },
    })

    expect(result.success).toBe(true)
    expect(results).toContain('test_integration_cap')
  })
})

describe('Integration: 分析输出解析 + 脱敏 + Markdown', () => {
  it('full pipeline: parse → mask → markdown', () => {
    const claudeOutput = `分析完成。根因如下：
{
  "classification": "bug",
  "level": "l2",
  "confidence": "medium",
  "confidence_score": 0.65,
  "root_cause": {
    "type": "business_logic",
    "summary": "密码 password=abc123 在 192.168.1.50 上验证失败",
    "file": "src/auth/PasswordValidator.java",
    "line_range": [45, 67]
  },
  "solutions": [
    { "id": "option-a", "summary": "修复验证逻辑", "recommended": true, "risk": "low", "effort": "small" }
  ],
  "affected_modules": ["pas-secret-task"],
  "analysis_steps": ["Phase 1: 读代码", "Phase 2: 对比正常逻辑"]
}`

    // Step 1: Parse
    const parsed = parseAnalysisOutput(claudeOutput)
    expect(parsed).not.toBeNull()
    expect(parsed!.level).toBe('l2')

    // Step 2: Mask sensitive info
    const maskedSummary = mask(parsed!.root_cause.summary)
    expect(maskedSummary).toContain('[MASKED]') // password masked
    expect(maskedSummary).toContain('[MASKED_IP]') // IP masked
    expect(maskedSummary).not.toContain('abc123')
    expect(maskedSummary).not.toContain('192.168.1.50')

    // Step 3: Build markdown
    const md = buildMarkdownReport(parsed!)
    expect(md).toContain('## AI 分析报告')
    expect(md).toContain('L2 简单代码')
    expect(md).toContain('pas-secret-task')
  })
})

describe('Integration: retry + downgrade 完整流程', () => {
  it('3 failures → downgrade callback', async () => {
    let downgraded = false
    let downgradeIssueId = 0

    const result = await retryWithDowngrade(
      999,
      'l2',
      async (ctx) => ({ success: false, error: `fail attempt ${ctx.attempt}` }),
      async (ctx) => {
        downgraded = true
        downgradeIssueId = ctx.issueId
      },
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('降级')
    expect(downgraded).toBe(true)
    expect(downgradeIssueId).toBe(999)
  })
})
