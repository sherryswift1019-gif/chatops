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
  gitlabGetIssue: vi.fn(),
  gitlabUpdateIssue: vi.fn(),
}))

// 允许单测用 mock 劫持 createEvent（C1/C4 使用）
vi.mock('../../db/repositories/bug-fix-events.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../db/repositories/bug-fix-events.js')>(
      '../../db/repositories/bug-fix-events.js',
    )
  return {
    ...actual,
    // 默认走 actual.createEvent（真正写 DB）；C1 测试用 mockRejectedValueOnce
    // 只影响那一次调用，之后继续走 actual
    createEvent: vi.fn(actual.createEvent),
  }
})

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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetTestDb, getTestPool } from '../helpers/db.js'
import {
  parseAnalysisOutput,
  buildMarkdownReport,
  handleAnalyzeBug,
  registerAnalysisBugHandler,
} from '../../agent/analysis/analyzer.js'
import {
  findByReport,
  findByReportCode,
  createEvent as createEventMock,
} from '../../db/repositories/bug-fix-events.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { runFilterStage, runDetailStage, type DetailStageResult, type DetailStageOutcome } from '../../agent/analysis/claude-runs.js'
import { extractJson } from '../../agent/analysis/claude-runs.js'
import {
  gitlabCreateIssue,
  gitlabPostIssueNote,
  gitlabGetIssue,
  gitlabUpdateIssue,
} from '../../agent/analysis/gitlab-issue.js'

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
const asDetail = (r: DetailStageResult): DetailStageOutcome => ({ kind: 'detail', detail: r })


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
    `INSERT INTO capabilities (key, display_name, description, tool_names, is_system, system_prompt)
     VALUES ('analyze_bug', '分析 Bug', 'desc', '[]'::jsonb, true, 'SYSTEM_PROMPT_FOR_ANALYZE_BUG')
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
    // C2：reuseIssueId 场景下 analyzer 会额外调 gitlabGetIssue/gitlabUpdateIssue。
    // 本 describe 不关心 body banner，给 stub 让它不抛错即可。
    vi.mocked(gitlabGetIssue).mockReset()
    vi.mocked(gitlabGetIssue).mockResolvedValue({ description: '' })
    vi.mocked(gitlabUpdateIssue).mockReset()
    vi.mocked(gitlabUpdateIssue).mockResolvedValue(undefined)
  })

  it('writes analysis + scope_identified + create_issue events for bug classification', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })

    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'business_logic', summary: '登录时未校验空 token', file: 'auth.ts', lineRange: [10, 20] },
      solutions: [{ id: 'opt-a', summary: '加空值判断', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['auth'],
      analysisSteps: ['P1', 'P2'],
      markdown: '## 根因\n\n登录时未校验空 token',
    }))
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
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'usage_issue',
      level: 'l1',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'business_logic', summary: '使用方式错误', file: '', lineRange: [] },
      solutions: [],
      affectedModules: [],
      analysisSteps: [],
      markdown: '## 使用方式不对',
    }))

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

  it('runDetailStage 返回 insufficient → success:true + output，不落库、不创 Issue', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api', ownerId: 'u-a' }],
    })

    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockResolvedValue({
      kind: 'insufficient',
      markdown: '## 初步分析\n\n发现 3 个候选根因：\n1. PS1 ANSI 污染\n2. SSH 超时\n3. 日志格式',
      verifyCommand: "ssh root@host 'echo $PS1'",
      verifyCriteria: '输出包含 ^[[ 即确认',
      recommendedOption: 1,
    })

    const result = await handleAnalyzeBug(buildOpts(productLineId, { message: '连接超时' }))

    expect(result.success).toBe(true)
    expect(result.output).toContain('## 初步分析')
    expect(result.output).toContain('PS1 ANSI 污染')
    expect(result.output).toContain('材料不够判断')
    expect(result.output).toContain('请按上述分析补充信息后重新 @ 我')
    // insufficient 分支不进数据库、不建 Issue
    expect(result.data).toBeUndefined()
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
    vi.mocked(runDetailStage).mockImplementation(async (input) => asDetail({
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
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'business_logic', summary: '再次分析', file: 'auth.ts', lineRange: [10, 20] },
      solutions: [{ id: 'opt-a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['auth'],
      analysisSteps: ['P1'],
      markdown: '## 再次分析',
    }))
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

describe('analyzer reuseIssueId Issue body banner (C2)', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
    vi.mocked(gitlabCreateIssue).mockReset()
    vi.mocked(gitlabPostIssueNote).mockReset()
    vi.mocked(gitlabGetIssue).mockReset()
    vi.mocked(gitlabUpdateIssue).mockReset()
  })

  function mockAnalysisBug() {
    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'business_logic', summary: '新分析', file: 'a.ts', lineRange: [1, 2] },
      solutions: [{ id: 'opt-a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['auth'],
      analysisSteps: ['P1'],
      markdown: '## 新分析',
    }))
    vi.mocked(gitlabPostIssueNote).mockResolvedValue({
      noteId: 4242,
      issueUrl: 'http://git.example.com/PAM/pas-api/-/issues/789',
    })
  }

  it('reuseIssueId 首次：Issue body 顶部插入 banner，原内容完整保留', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    mockAnalysisBug()
    vi.mocked(gitlabGetIssue).mockResolvedValue({
      description: '## 原始分析\n\n根因：token 空值',
    })
    vi.mocked(gitlabUpdateIssue).mockResolvedValue(undefined)

    const result = await handleAnalyzeBug(buildOpts(productLineId, { reuseIssueId: 789 }))
    expect(result.success).toBe(true)

    expect(gitlabGetIssue).toHaveBeenCalledWith('PAM/pas-api', 789)
    expect(gitlabUpdateIssue).toHaveBeenCalledTimes(1)
    const [, , payload] = vi.mocked(gitlabUpdateIssue).mock.calls[0]
    const desc = payload.description
    expect(desc).toMatch(/<!-- reanalyze-banner:start -->/)
    expect(desc).toMatch(/<!-- reanalyze-banner:end -->/)
    expect(desc).toMatch(/\*\*1\*\* 次重新分析/)
    expect(desc).toContain('#note_4242')
    // 原内容完整保留
    expect(desc).toContain('## 原始分析')
    expect(desc).toContain('根因：token 空值')
    // banner 在原内容之前
    expect(desc.indexOf('<!-- reanalyze-banner:end -->')).toBeLessThan(desc.indexOf('## 原始分析'))
  })

  it('reuseIssueId 第 N 次：banner 内容被替换（计数递增），不重复累积', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    mockAnalysisBug()
    // 已存在 banner（第 2 次），本次应变成第 3 次
    const existingDescription =
      '<!-- reanalyze-banner:start -->\n' +
      '> ⚠️ 本 Issue 已经历 **2** 次重新分析。最新分析结果见 [comment](http://old)\n' +
      '>\n' +
      '> 原始分析保留如下 ⬇️\n' +
      '<!-- reanalyze-banner:end -->\n\n' +
      '## 原始分析\n\n根因：token 空值'
    vi.mocked(gitlabGetIssue).mockResolvedValue({ description: existingDescription })
    vi.mocked(gitlabUpdateIssue).mockResolvedValue(undefined)

    const result = await handleAnalyzeBug(buildOpts(productLineId, { reuseIssueId: 789 }))
    expect(result.success).toBe(true)

    const [, , payload] = vi.mocked(gitlabUpdateIssue).mock.calls[0]
    const desc = payload.description
    // 计数 +1 → 3
    expect(desc).toMatch(/\*\*3\*\* 次重新分析/)
    // 只替换不累积
    const startMatches = desc.match(/<!-- reanalyze-banner:start -->/g) ?? []
    expect(startMatches).toHaveLength(1)
    const endMatches = desc.match(/<!-- reanalyze-banner:end -->/g) ?? []
    expect(endMatches).toHaveLength(1)
    // URL 指向新 comment（而非老 http://old）
    expect(desc).toContain('#note_4242')
    expect(desc).not.toContain('http://old')
    // 原内容仍在
    expect(desc).toContain('## 原始分析')
  })

  it('reuseIssueId：gitlabUpdateIssue 失败不阻塞主流程，analyzer 仍返回 success', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    mockAnalysisBug()
    vi.mocked(gitlabGetIssue).mockResolvedValue({ description: '原文' })
    vi.mocked(gitlabUpdateIssue).mockRejectedValue(new Error('gitlab 503'))

    const result = await handleAnalyzeBug(buildOpts(productLineId, { reuseIssueId: 789 }))

    expect(result.success).toBe(true)
    const reportId = (result.data as { reportId: number }).reportId
    expect(reportId).toBeGreaterThan(0)
    expect(gitlabPostIssueNote).toHaveBeenCalledTimes(1)
    expect(gitlabUpdateIssue).toHaveBeenCalledTimes(1)
  })

  it('非 reuseIssueId 场景（首次分析）：不调 gitlabGetIssue / gitlabUpdateIssue', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    mockAnalysisBug()
    vi.mocked(gitlabCreateIssue).mockResolvedValue({
      iid: 100,
      url: 'http://git.example.com/PAM/pas-api/-/issues/100',
    })

    const result = await handleAnalyzeBug(buildOpts(productLineId))
    expect(result.success).toBe(true)

    expect(gitlabGetIssue).not.toHaveBeenCalled()
    expect(gitlabUpdateIssue).not.toHaveBeenCalled()
  })
})

describe('analyzer createEvent failure propagation (C1)', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
    vi.mocked(gitlabCreateIssue).mockReset()
    vi.mocked(gitlabPostIssueNote).mockReset()
    vi.mocked(createEventMock).mockReset()
  })

  it('createEvent 抛错时 handleAnalyzeBug 返回 success=false（不静默吞）', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })

    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'business_logic', summary: 'x', file: 'a.ts', lineRange: [1, 2] },
      solutions: [{ id: 'opt-a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['auth'],
      analysisSteps: ['P1'],
      markdown: '## x',
    }))
    vi.mocked(gitlabCreateIssue).mockResolvedValue({
      iid: 1,
      url: 'http://git.example.com/PAM/pas-api/-/issues/1',
    })
    // 模拟 DB 连接断开导致 createEvent 抛错（Once：只影响本测试，不泄漏给其他 describe）
    vi.mocked(createEventMock).mockRejectedValueOnce(new Error('connection terminated unexpectedly'))

    const result = await handleAnalyzeBug(buildOpts(productLineId))

    expect(result.success).toBe(false)
    // classifyError 把普通 DB 错归到 analyzer_error（兜底类），不静默吞
    expect(result.error).toBe('analyzer_error')
    expect(result.output).toContain('connection terminated')
  })
})

describe('analyzer multi-project concurrency (C4)', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
    vi.mocked(gitlabCreateIssue).mockReset()
    vi.mocked(gitlabPostIssueNote).mockReset()
    vi.mocked(gitlabGetIssue).mockReset()
    vi.mocked(gitlabGetIssue).mockResolvedValue({ description: '' })
    vi.mocked(gitlabUpdateIssue).mockReset()
    vi.mocked(gitlabUpdateIssue).mockResolvedValue(undefined)
  })

  it('5 个 project 并发受 p-limit 限制（peak <= ANALYSIS_CONCURRENCY=3）', async () => {
    const productLineId = await seedBaseData({
      projects: [
        { name: 'pa', gitlabPath: 'PAM/a' },
        { name: 'pb', gitlabPath: 'PAM/b' },
        { name: 'pc', gitlabPath: 'PAM/c' },
        { name: 'pd', gitlabPath: 'PAM/d' },
        { name: 'pe', gitlabPath: 'PAM/e' },
      ],
    })

    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [
        { projectPath: 'PAM/a', isPrimary: true, sourceBranch: 'master' },
        { projectPath: 'PAM/b', isPrimary: false, sourceBranch: 'master' },
        { projectPath: 'PAM/c', isPrimary: false, sourceBranch: 'master' },
        { projectPath: 'PAM/d', isPrimary: false, sourceBranch: 'master' },
        { projectPath: 'PAM/e', isPrimary: false, sourceBranch: 'master' },
      ],
      primaryProjectPath: 'PAM/a',
    })

    let active = 0
    let peak = 0
    vi.mocked(runDetailStage).mockImplementation(async (input) => {
      active++
      peak = Math.max(peak, active)
      // 用 timer 让多个并发 run 真正重叠
      await new Promise(res => setTimeout(res, 30))
      active--
      return asDetail({
        classification: 'bug',
        level: 'l2',
        confidence: 'medium',
        confidenceScore: 0.7,
        rootCause: {
          type: 'business_logic',
          summary: `${input.projectPath} 根因`,
          file: 'x.ts',
          lineRange: [1, 2],
        },
        solutions: [{ id: 'a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
        affectedModules: ['x'],
        analysisSteps: ['p1'],
        markdown: '## x',
      })
    })
    vi.mocked(gitlabCreateIssue).mockResolvedValue({
      iid: 1,
      url: 'http://git.example.com/PAM/a/-/issues/1',
    })

    const result = await handleAnalyzeBug(buildOpts(productLineId, { message: 'bug 覆盖 5 个 proj' }))
    expect(result.success).toBe(true)

    // peak 必须 <= 默认并发 3，且 5 个项目都调到了
    expect(vi.mocked(runDetailStage)).toHaveBeenCalledTimes(5)
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(3)
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

// ============================================================
// 补充分支覆盖
// ============================================================

describe('parseAnalysisOutput 边界分支', () => {
  it('unclosed JSON（只有 { 没有 }）返回 null（end=-1 分支）', () => {
    // `{` 被找到但闭合找不到 → end 还是 -1 → return null
    const input = '{ "classification": "bug" '
    expect(parseAnalysisOutput(input)).toBeNull()
  })

  it('缺 required 字段时返回 null', () => {
    // 有 classification 但缺 level
    const text = '{ "classification": "bug", "confidence": "high", "root_cause": {}, "solutions": [] }'
    expect(parseAnalysisOutput(text)).toBeNull()
  })

  it('root_cause.summary 为空时返回 null', () => {
    const text = JSON.stringify({
      classification: 'bug',
      level: 'l1',
      confidence: 'high',
      root_cause: { summary: '' },
      solutions: [{}],
    })
    expect(parseAnalysisOutput(text)).toBeNull()
  })

  it('solutions 非数组时返回 null', () => {
    const text = JSON.stringify({
      classification: 'bug',
      level: 'l1',
      confidence: 'high',
      root_cause: { summary: 'x', file: 'a', line_range: [1, 2] },
      solutions: 'not-array',
    })
    expect(parseAnalysisOutput(text)).toBeNull()
  })
})

describe('buildMarkdownReport 边界分支', () => {
  const base = {
    classification: 'bug' as const,
    level: 'l2' as const,
    confidence: 'medium' as const,
    confidence_score: 0.5,
    root_cause: { type: 'biz', summary: 's', file: 'f', line_range: [1, 2] },
    solutions: [{ id: 'a', summary: 's', recommended: false, risk: 'low' as const, effort: 'small' as const }],
    affected_modules: [],
    analysis_steps: [],
  }

  it('affected_modules 为空时显示 `-`', () => {
    const md = buildMarkdownReport(base)
    expect(md).toContain('### 影响模块\n\n-')
  })

  it('confidence_score 缺失时回退为 0 (0%)', () => {
    const md = buildMarkdownReport({ ...base, confidence_score: undefined as unknown as number })
    expect(md).toContain('(0%)')
  })

  it('非 recommended 方案不显示"推荐"标签', () => {
    const md = buildMarkdownReport(base)
    expect(md).not.toContain('（推荐）')
  })

  it('未知 level 时直接显示原值（LEVEL_LABEL fallback）', () => {
    const md = buildMarkdownReport({ ...base, level: 'l99' as unknown as 'l1' })
    expect(md).toContain('**等级**: l99')
  })

  it('analysis_steps 缺失时渲染空串', () => {
    const md = buildMarkdownReport({ ...base, analysis_steps: undefined as unknown as string[] })
    expect(md).toContain('### 分析步骤\n\n\n')
  })
})

describe('registerAnalysisBugHandler', () => {
  it('调用不抛错，注册 analyze_bug handler', () => {
    expect(() => registerAnalysisBugHandler()).not.toThrow()
  })
})

describe('handleAnalyzeBug 入口校验分支', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
  })

  it('缺 productLineId → success=false', async () => {
    const res = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't', groupId: 'g', platform: 'dingtalk', initiatorId: 'u', initiatorRole: 'developer' } as any,
      extraParams: { message: 'x' },
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('productLineId')
  })

  it('缺 message → success=false', async () => {
    const res = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't', groupId: 'g', platform: 'dingtalk', initiatorId: 'u', initiatorRole: 'developer' } as any,
      extraParams: { productLineId: 7 },
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('message')
  })

  it('产品线无 knowledge_repo → success=false', async () => {
    // seed productLine 但不 seed product_knowledge_repos
    const pool = getTestPool()
    const { rows } = await pool.query(
      `INSERT INTO product_lines (name, display_name, description) VALUES ('empty', 'E', 'e') RETURNING id`,
    )
    const pid = rows[0].id as number
    await pool.query(
      `INSERT INTO capabilities (key, display_name, description, tool_names, is_system, system_prompt)
       VALUES ('analyze_bug', 'a', '', '[]'::jsonb, true, 'sp')
       ON CONFLICT (key) DO UPDATE SET system_prompt = EXCLUDED.system_prompt`,
    )
    const res = await handleAnalyzeBug(buildOpts(pid))
    expect(res.success).toBe(false)
    expect(res.error).toContain('未配置代码仓库')
  })

  it('capability 无 systemPrompt → success=false', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    // 清空 systemPrompt
    const pool = getTestPool()
    await pool.query(`UPDATE capabilities SET system_prompt = '' WHERE key = 'analyze_bug'`)
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(false)
    expect(res.error).toContain('未配置 systemPrompt')
  })

  it('system_prompt 为 NULL 时 fallback 到 default_system_prompt', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    const pool = getTestPool()
    await pool.query(
      `UPDATE capabilities
       SET system_prompt = NULL, default_system_prompt = 'DEFAULT_ANALYZE_PROMPT'
       WHERE key = 'analyze_bug'`,
    )

    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'business_logic', summary: 's', file: 'a.ts', lineRange: [1, 2] },
      solutions: [{ id: 'a', summary: 's', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: ['m'],
      analysisSteps: ['s'],
      markdown: '',
    }))
    vi.mocked(gitlabCreateIssue).mockResolvedValue({ iid: 1, url: 'http://x' })

    const result = await handleAnalyzeBug(buildOpts(productLineId))

    expect(result.success).toBe(true)
    const filterCallArg = vi.mocked(runFilterStage).mock.calls[0][0]
    expect(filterCallArg.systemPrompt).toBe('DEFAULT_ANALYZE_PROMPT')
    const detailCallArg = vi.mocked(runDetailStage).mock.calls[0][0]
    expect(detailCallArg.systemPrompt).toBe('DEFAULT_ANALYZE_PROMPT')
  })

  it('productLine 下 0 个 project → 返回 "未配置任何 project"', async () => {
    // 准备数据：有 product_line + knowledgeRepo + capability，但 projects 表无记录
    const productLineId = await seedBaseData({ projects: [] })
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(false)
    expect(res.error).toContain('未配置任何 project')
  })
})

describe('handleAnalyzeBug 错误分类 classifyError', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
    vi.mocked(gitlabCreateIssue).mockReset()
    vi.mocked(gitlabPostIssueNote).mockReset()
  })

  async function setupBug() {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    return productLineId
  }

  it('包含 timeout → claude_timeout', async () => {
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockRejectedValue(new Error('claude cli timeout after 600s'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(false)
    expect(res.error).toBe('claude_timeout')
  })

  it('包含中文"超时"→ claude_timeout', async () => {
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockRejectedValue(new Error('连接超时'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.error).toBe('claude_timeout')
  })

  it('包含 "timed out" → claude_timeout', async () => {
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockRejectedValue(new Error('operation timed out'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.error).toBe('claude_timeout')
  })

  it('SyntaxError 或 "unexpected token" → claude_invalid_json', async () => {
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockRejectedValue(new SyntaxError('Unexpected token } in JSON'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.error).toBe('claude_invalid_json')
  })

  it('"未返回 json" → claude_invalid_json', async () => {
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockRejectedValue(new Error('Claude 未返回 json 响应'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.error).toBe('claude_invalid_json')
  })

  it('"未解析到 json" → claude_invalid_json', async () => {
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockRejectedValue(new Error('未解析到 json'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.error).toBe('claude_invalid_json')
  })

  it('"字段缺失" → claude_invalid_json', async () => {
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockRejectedValue(new Error('字段缺失: classification'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.error).toBe('claude_invalid_json')
  })

  it('"json.parse" 关键字 → claude_invalid_json', async () => {
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockRejectedValue(new Error('json.parse failed: abc'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.error).toBe('claude_invalid_json')
  })

  it('Issue 创建失败（GitLab 错误）→ issue_create_failed', async () => {
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'bug',
      level: 'l2',
      confidence: 'high',
      confidenceScore: 0.9,
      rootCause: { type: 'x', summary: 'x', file: 'a', lineRange: [1, 2] },
      solutions: [{ id: 'a', summary: 's', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: [],
      analysisSteps: [],
      markdown: '## x',
    }))
    vi.mocked(gitlabCreateIssue).mockRejectedValue(new Error('create issue on gitlab 403'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.error).toBe('issue_create_failed')
  })

  it('无 "issue" 关键字的 GitLab 错误归入兜底 analyzer_error', async () => {
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockRejectedValue(new Error('random DB crash'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.error).toBe('analyzer_error')
  })

  it('"no projects" 关键字 → no_projects（通过 inner Error 构造测试）', async () => {
    // 由于 "no projects" 的正规路径是前置校验（走 analyzer_error 兜底），
    // 这里通过让 runDetailStage 抛 no projects 文案来触发 classifyError 的该分支
    const productLineId = await setupBug()
    vi.mocked(runDetailStage).mockRejectedValue(new Error('no projects available'))
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.error).toBe('no_projects')
  })

  it('非 Error 对象（字符串）也被 classifyError 处理', async () => {
    const productLineId = await setupBug()
    // eslint-disable-next-line no-throw-literal
    vi.mocked(runDetailStage).mockImplementation(async () => {
      throw 'plain string error'
    })
    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(false)
    expect(res.error).toBe('analyzer_error')
    expect(res.output).toContain('plain string error')
  })
})

describe('handleAnalyzeBug 阶段 A worktree / filter 失败', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
  })

  it('阶段 A acquire 抛错 → "阶段A 主仓库 clone 失败"', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    // 让 acquire 抛错（第一次调用）
    const wtm = await import('../../agent/worktree/manager.js')
    vi.mocked(wtm.acquire).mockRejectedValueOnce(new Error('git clone 403'))

    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(false)
    expect(res.error).toContain('阶段A 主仓库 clone 失败')
  })

  it('阶段 A filter 抛错 → "阶段A 筛选失败"（release 仍被调用）', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    const wtm = await import('../../agent/worktree/manager.js')
    vi.mocked(runFilterStage).mockRejectedValue(new Error('filter boom'))

    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(false)
    expect(res.error).toContain('阶段A 筛选失败')
    // finally 块保证 release 被调一次
    expect(vi.mocked(wtm.release)).toHaveBeenCalled()
  })
})

describe('handleAnalyzeBug ANALYSIS_CONCURRENCY 环境变量', () => {
  const original = process.env.ANALYSIS_CONCURRENCY

  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
    vi.mocked(gitlabCreateIssue).mockReset()
  })

  afterEach(() => {
    if (original === undefined) delete process.env.ANALYSIS_CONCURRENCY
    else process.env.ANALYSIS_CONCURRENCY = original
  })

  it('ANALYSIS_CONCURRENCY=0 时回退默认 3', async () => {
    process.env.ANALYSIS_CONCURRENCY = '0'
    const productLineId = await seedBaseData({
      projects: [
        { name: 'a', gitlabPath: 'PAM/a' },
        { name: 'b', gitlabPath: 'PAM/b' },
      ],
    })
    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [
        { projectPath: 'PAM/a', isPrimary: true, sourceBranch: 'master' },
        { projectPath: 'PAM/b', isPrimary: false, sourceBranch: 'master' },
      ],
      primaryProjectPath: 'PAM/a',
    })
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'bug',
      level: 'l2',
      confidence: 'medium',
      confidenceScore: 0.7,
      rootCause: { type: 'x', summary: 'x', file: 'a.ts', lineRange: [1, 2] },
      solutions: [{ id: 'a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: [],
      analysisSteps: [],
      markdown: '## x',
    }))
    vi.mocked(gitlabCreateIssue).mockResolvedValue({ iid: 1, url: 'http://x' })

    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(true)
    expect(vi.mocked(runDetailStage)).toHaveBeenCalledTimes(2)
  })

  it('ANALYSIS_CONCURRENCY=NaN 时回退默认 3', async () => {
    process.env.ANALYSIS_CONCURRENCY = 'abc'
    const productLineId = await seedBaseData({
      projects: [{ name: 'a', gitlabPath: 'PAM/a' }],
    })
    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/a', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/a',
    })
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'bug',
      level: 'l2',
      confidence: 'medium',
      confidenceScore: 0.7,
      rootCause: { type: 'x', summary: 'x', file: 'a.ts', lineRange: [1, 2] },
      solutions: [{ id: 'a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: [],
      analysisSteps: [],
      markdown: '## x',
    }))
    vi.mocked(gitlabCreateIssue).mockResolvedValue({ iid: 1, url: 'http://x' })

    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(true)
  })
})

describe('handleAnalyzeBug affectedModulesByProject 边界', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
    vi.mocked(gitlabCreateIssue).mockReset()
  })

  it('某 project 在 affectedModulesByProject 里无对应项时 fallback 为 []', async () => {
    const productLineId = await seedBaseData({
      projects: [
        { name: 'a', gitlabPath: 'PAM/a' },
        { name: 'b', gitlabPath: 'PAM/b' },
      ],
    })
    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [
        { projectPath: 'PAM/a', isPrimary: true, sourceBranch: 'master' },
        { projectPath: 'PAM/b', isPrimary: false, sourceBranch: 'master' },
      ],
      primaryProjectPath: 'PAM/a',
    })
    // PAM/a 有 affected_modules=['m1']，PAM/b 的 affected_modules=[]（空数组）
    vi.mocked(runDetailStage).mockImplementation(async (input) => asDetail({
      classification: 'bug',
      level: 'l2',
      confidence: 'medium',
      confidenceScore: 0.7,
      rootCause: { type: 'x', summary: 'x', file: 'a.ts', lineRange: [1, 2] },
      solutions: [{ id: 'a', summary: 'fix', recommended: true, risk: 'low', effort: 'small' }],
      affectedModules: input.projectPath === 'PAM/a' ? ['m1'] : [],
      analysisSteps: [],
      markdown: '## x',
    }))
    vi.mocked(gitlabCreateIssue).mockResolvedValue({ iid: 2, url: 'http://x' })

    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(true)
    const reportId = (res.data as { reportId: number }).reportId
    const events = await findByReportCode(reportId, 'scope_identified')
    const pb = events.find(e => e.projectPath === 'PAM/b')!
    // 空数组时事件的 affectedModules 是 []（而非 undefined）
    expect((pb.data as any).affectedModules).toEqual([])
  })
})

// L4 分类：analyzer 自己不会触发 Pipeline（交由 coordinator），但 analyzer 里把 L4 正常写入
// status=published（走 bug 分支）。确认 L4 报告 published，而非被 analyzer 吞掉。
describe('handleAnalyzeBug L4 分类', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
    vi.mocked(gitlabCreateIssue).mockReset()
  })

  it('L4 bug：report.status=published，level=l4 写入', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'bug',
      level: 'l4',
      confidence: 'low',
      confidenceScore: 0.3,
      rootCause: { type: 'arch', summary: '架构问题', file: 'x', lineRange: [1, 1] },
      solutions: [],
      affectedModules: [],
      analysisSteps: [],
      markdown: '## L4',
    }))
    vi.mocked(gitlabCreateIssue).mockResolvedValue({ iid: 4, url: 'http://x/4' })

    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(true)
    expect((res.data as { level: string }).level).toBe('l4')

    const reportId = (res.data as { reportId: number }).reportId
    const report = await getBugAnalysisReportById(reportId)
    expect(report?.level).toBe('l4')
    expect(report?.status).toBe('published')
  })
})

describe('handleAnalyzeBug config_issue 分类', () => {
  beforeEach(async () => {
    await resetTestDb()
    vi.mocked(runFilterStage).mockReset()
    vi.mocked(runDetailStage).mockReset()
    vi.mocked(gitlabCreateIssue).mockReset()
  })

  it('config_issue：status=completed，不创建 issue，不写 scope_identified', async () => {
    const productLineId = await seedBaseData({
      projects: [{ name: 'pas-api', gitlabPath: 'PAM/pas-api' }],
    })
    vi.mocked(runFilterStage).mockResolvedValue({
      involvedProjects: [{ projectPath: 'PAM/pas-api', isPrimary: true, sourceBranch: 'master' }],
      primaryProjectPath: 'PAM/pas-api',
    })
    vi.mocked(runDetailStage).mockResolvedValue(asDetail({
      classification: 'config_issue',
      level: 'l1',
      confidence: 'high',
      confidenceScore: 0.95,
      rootCause: { type: 'config', summary: '配置问题', file: '-', lineRange: [] },
      solutions: [],
      affectedModules: [],
      analysisSteps: [],
      markdown: '## config',
    }))

    const res = await handleAnalyzeBug(buildOpts(productLineId))
    expect(res.success).toBe(true)
    expect((res.data as any).classification).toBe('config_issue')
    const reportId = (res.data as any).reportId as number
    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('completed')

    expect(gitlabCreateIssue).not.toHaveBeenCalled()
    const scopes = await findByReportCode(reportId, 'scope_identified')
    expect(scopes).toHaveLength(0)
  })
})
