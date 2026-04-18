import { vi } from 'vitest'

// Mock 两个外部依赖模块（Claude CLI 调用 + GitLab API）
vi.mock('../../agent/analysis/claude-runs.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/analysis/claude-runs.js')>(
    '../../agent/analysis/claude-runs.js',
  )
  return {
    ...actual,
    runFilterStage: vi.fn(),
    runDetailStage: vi.fn(),
  }
})

vi.mock('../../agent/analysis/gitlab-issue.js', () => ({
  gitlabCreateIssue: vi.fn(),
  gitlabPostIssueNote: vi.fn(),
}))

// Mock worktree manager 避免真正 clone 仓库
vi.mock('../../agent/worktree/manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../agent/worktree/manager.js')>(
    '../../agent/worktree/manager.js',
  )
  return {
    ...actual,
    acquire: vi.fn(async (opts: Record<string, unknown>) => ({
      id: `mock-${opts.sessionId}`,
      path: `/tmp/mock-worktree-${opts.sessionId}`,
      userId: opts.userId as string,
      product: opts.product as string,
      version: opts.version as string,
      sessionId: opts.sessionId as string,
      repoUrl: opts.repoUrl as string,
      projectPath: opts.projectPath as string | undefined,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    })),
    release: vi.fn(),
  }
})

import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  parseAnalysisOutput,
  buildMarkdownReport,
  handleAnalyzeBug,
} from '../../agent/analysis/analyzer.js'
import {
  findByReport,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { runFilterStage, runDetailStage } from '../../agent/analysis/claude-runs.js'
import { extractJson } from '../../agent/analysis/claude-runs.js'
import { gitlabCreateIssue, gitlabPostIssueNote } from '../../agent/analysis/gitlab-issue.js'

// 保留原有的 parseAnalysisOutput / buildMarkdownReport 测试（向后兼容）
describe('parseAnalysisOutput', () => {
  it('parses valid JSON from Claude output', () => {
    const text = `分析完成，以下是结果：
{
  "classification": "bug",
  "level": "l1",
  "confidence": "high",
  "confidence_score": 0.85,
  "root_cause": {
    "type": "syntax",
    "summary": "初始化 SQL 缺少错误码",
    "file": "sql/init.sql",
    "line_range": [10, 15]
  },
  "solutions": [
    { "id": "option-a", "summary": "添加 INSERT 语句", "recommended": true, "risk": "low", "effort": "small" }
  ],
  "affected_modules": ["pas-secret-task"],
  "analysis_steps": ["Phase 1: 读代码", "Phase 2: 对比"]
}`

    const result = parseAnalysisOutput(text)
    expect(result).not.toBeNull()
    expect(result!.classification).toBe('bug')
    expect(result!.level).toBe('l1')
    expect(result!.confidence).toBe('high')
    expect(result!.confidence_score).toBe(0.85)
    expect(result!.solutions).toHaveLength(1)
    expect(result!.solutions[0].recommended).toBe(true)
    expect(result!.affected_modules).toContain('pas-secret-task')
  })

  it('returns null for text without JSON', () => {
    expect(parseAnalysisOutput('这是一段普通文本')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseAnalysisOutput('{ "classification": bug }')).toBeNull()
  })
})

describe('buildMarkdownReport', () => {
  it('generates readable markdown', () => {
    const output = {
      classification: 'bug' as const,
      level: 'l2' as const,
      confidence: 'medium' as const,
      confidence_score: 0.65,
      root_cause: { type: 'business_logic', summary: '会话超时判断错误', file: 'SessionManager.java', line_range: [142, 168] },
      solutions: [
        { id: 'option-a', summary: '调整判断优先级', recommended: true, risk: 'low', effort: 'small' },
        { id: 'option-b', summary: '增加前置检查', recommended: false, risk: 'medium', effort: 'medium' },
      ],
      affected_modules: ['pas-bastion-host'],
      analysis_steps: ['Phase 1: 读代码', 'Phase 2: 对比', 'Phase 3: 验证'],
    }

    const md = buildMarkdownReport(output)
    expect(md).toContain('## AI 分析报告')
    expect(md).toContain('L2 简单代码')
    expect(md).toContain('65%')
    expect(md).toContain('会话超时判断错误')
    expect(md).toContain('option-a')
    expect(md).toContain('推荐')
    expect(md).toContain('pas-bastion-host')
  })
})

// ============================================================
// 新流程集成测试
// ============================================================

async function seedBaseData(opts: {
  productLineName?: string
  projects: Array<{ name: string; gitlabPath: string; displayName?: string; ownerId?: string }>
}): Promise<number> {
  const pool = getTestPool()
  const { rows: plRows } = await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ($1, 'PAM', 'test')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [opts.productLineName ?? 'pam'],
  )
  const productLineId = plRows[0].id as number

  // product_knowledge_repos
  await pool.query(
    `INSERT INTO product_knowledge_repos (product_line_id, code_repo_url, code_default_branch, knowledge_repo_url, ai_summary_path)
     VALUES ($1, 'http://git.example.com/PAM/main.git', 'master', 'http://git.example.com/PAM/kb.git', '/ai.md')
     ON CONFLICT DO NOTHING`,
    [productLineId],
  )

  // projects
  for (const p of opts.projects) {
    await pool.query(
      `INSERT INTO projects (product_line_id, name, display_name, gitlab_path, owner_id, description)
       VALUES ($1, $2, $3, $4, $5, '')
       ON CONFLICT (name) DO NOTHING`,
      [productLineId, p.name, p.displayName ?? p.name, p.gitlabPath, p.ownerId ?? 'u-owner'],
    )
  }

  // capability: analyze_bug with systemPrompt
  await pool.query(
    `INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, is_system, system_prompt)
     VALUES ('analyze_bug', '分析 Bug', 'desc', 'action', '[]'::jsonb, false, true, 'SYSTEM_PROMPT_FOR_ANALYZE_BUG')
     ON CONFLICT (key) DO UPDATE SET system_prompt = EXCLUDED.system_prompt`,
  )

  return productLineId
}

function buildOpts(productLineId: number, extra: Record<string, unknown> = {}) {
  return {
    capabilityKey: 'analyze_bug',
    context: {
      taskId: `t-${Date.now()}`,
      groupId: 'g1',
      platform: 'dingtalk' as const,
      initiatorId: 'u1',
      initiatorRole: 'developer' as const,
    },
    extraParams: { message: '登录 500', productLineId, ...extra },
  }
}

describe('analyzer multi-project support', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
    vi.mocked(gitlabCreateIssue).mockReset()
    vi.mocked(gitlabPostIssueNote).mockReset()
  })

  it('writes analysis + scope_identified + create_issue events for bug classification', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })

    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockResolvedValue({
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'business_logic', summary: '登录时未校验空 token', file: 'auth.ts', lineRange: [10, 20] },
      solutions: [{ id: 'opt-a', summary: '加空值判断', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['auth'],
      analysisSteps: ['P1', 'P2'],
      markdown: '## 根因\n\n登录时未校验空 token',
    })
    vi.mocked(gitlabCreateIssue).mockResolvedValue({
      iid: 123,
      url: 'http://git.example.com/PAM/pas-api/-/issues/123',
    })

    const result = await handleAnalyzeBug(buildOpts(productLineId))

    expect(result.success).toBe(true)
    expect((result.data as { classification: string }).classification).toBe('bug')
    expect((result.data as { level: string }).level).toBe('l2')

    const reportId = (result.data as { reportId: number }).reportId
    const events = await findByReport(reportId)
    const codes = events.map(e => e.code)
    expect(codes).toContain('analysis')
    expect(codes).toContain('scope_identified')
    expect(codes).toContain('create_issue')

    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('published')
    expect(report?.primaryProjectPath).toBe('PAM/pas-api')
    expect(report?.issueId).toBe(123)

    expect(gitlabCreateIssue).toHaveBeenCalledTimes(1)
    expect(gitlabPostIssueNote).not.toHaveBeenCalled()
  })

  it('non-bug classification: status=completed and no create_issue event', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })

    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockResolvedValue({
      classification: 'usage_issue',
      level: 'l1',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'business_logic', summary: '使用方式错误', file: '', lineRange: [] },
      solutions: [],
      affectedModules: [],
      analysisSteps: [],
      markdown: '## 使用方式不对',
    })

    const result = await handleAnalyzeBug(buildOpts(productLineId, { message: '怎么用' }))
    expect(result.success).toBe(true)

    const reportId = (result.data as { reportId: number }).reportId
    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('completed')

    const createIssueEvents = await findByReportCode(reportId, 'create_issue')
    expect(createIssueEvents).toHaveLength(0)

    const scopeEvents = await findByReportCode(reportId, 'scope_identified')
    expect(scopeEvents).toHaveLength(0)

    expect(gitlabCreateIssue).not.toHaveBeenCalled()
  })

  it('multi-project: writes N scope_identified rows with isPrimary flag', async () => {
    const productLineId = await seedBaseData({
      projects: [
        { name: 'pas-api', gitlabPath: 'PAM/pas-api', ownerId: 'u-a' },
        { name: 'pas-6.0', gitlabPath: 'PAM/pas-6.0', ownerId: 'u-b' },
      ],
    })

    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [
        { projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' },
        { projectPath: 'PAM/pas-6.0', isPrimary: false, sourceBranch: 'master' },
      ],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockImplementation(async (input) => ({
      classification: 'bug',
      level: input.projectPath === 'PAM/pas-api' ? 'l2' : 'l1',
      confidence: 'medium',
      confidenceScore: 0.7,
      rootCause: { type: 'business_logic', summary: `${input.projectPath} 根因`, file: 'x.ts', lineRange: [1, 2] },
      solutions: [{ id: 'opt-a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: [input.projectPath === 'PAM/pas-api' ? 'auth' : 'bff'],
      analysisSteps: ['P1'],
      markdown: `## ${input.projectPath}`,
    }))
    vi.mocked(gitlabCreateIssue).mockResolvedValue({
      iid: 456,
      url: 'http://git.example.com/PAM/pas-api/-/issues/456',
    })

    const result = await handleAnalyzeBug(buildOpts(productLineId, { message: '跨服务 bug' }))
    expect(result.success).toBe(true)
    // 合并后 level 取最高 -> l2
    expect((result.data as { level: string }).level).toBe('l2')

    const reportId = (result.data as { reportId: number }).reportId
    const scopes = await findByReportCode(reportId, 'scope_identified')
    expect(scopes).toHaveLength(2)

    const primary = scopes.find(e => (e.data as { isPrimary: boolean }).isPrimary === true)
    const secondary = scopes.find(e => (e.data as { isPrimary: boolean }).isPrimary === false)
    expect(primary?.projectPath).toBe('PAM/pas-api')
    expect(secondary?.projectPath).toBe('PAM/pas-6.0')

    // 只有一条 create_issue（主仓库）
    const issueEvents = await findByReportCode(reportId, 'create_issue')
    expect(issueEvents).toHaveLength(1)
    expect(issueEvents[0].projectPath).toBe('PAM/pas-api')
  })

  it('reuseIssueId: calls gitlabPostIssueNote instead of gitlabCreateIssue', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })

    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockResolvedValue({
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'business_logic', summary: '再次分析', file: 'auth.ts', lineRange: [10, 20] },
      solutions: [{ id: 'opt-a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['auth'],
      analysisSteps: ['P1'],
      markdown: '## 再次分析',
    })
    vi.mocked(gitlabPostIssueNote).mockResolvedValue({
      noteId: 9999,
      issueUrl: 'http://git.example.com/PAM/pas-api/-/issues/789',
    })

    const result = await handleAnalyzeBug(buildOpts(productLineId, { reuseIssueId: 789 }))
    expect(result.success).toBe(true)

    expect(gitlabPostIssueNote).toHaveBeenCalledTimes(1)
    expect(gitlabCreateIssue).not.toHaveBeenCalled()

    const reportId = (result.data as { reportId: number }).reportId
    const report = await getBugAnalysisReportById(reportId)
    expect(report?.issueId).toBe(789)

    const issueEvents = await findByReportCode(reportId, 'create_issue')
    expect(issueEvents).toHaveLength(1)
    expect((issueEvents[0].data as { isReused: boolean }).isReused).toBe(true)
  })
})

describe('extractJson', () => {
  it('handles plain JSON', () => {
    expect(extractJson('{"a": 1}')).toBe('{"a": 1}')
  })

  it('strips markdown code fence', () => {
    expect(extractJson('```json\n{"a": 1}\n```')).toContain('"a": 1')
    expect(JSON.parse(extractJson('```json\n{"a": 1}\n```'))).toEqual({ a: 1 })
  })

  it('handles leading natural language', () => {
    const input = '根据分析：\n{"a": 1}'
    expect(JSON.parse(extractJson(input))).toEqual({ a: 1 })
  })

  it('handles array response', () => {
    expect(JSON.parse(extractJson('```\n[1,2,3]\n```'))).toEqual([1, 2, 3])
  })
})
