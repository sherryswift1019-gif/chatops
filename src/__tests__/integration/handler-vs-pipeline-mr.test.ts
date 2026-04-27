/**
 * P4-T4: create_mr handler vs pipeline 行为对等测试
 *
 * 5 scenario × handler-vs-pipeline 各跑一次。
 *
 * 关键 side effects:
 *   - GitLab API 调用 (handler 走 axios via gitlabCreateMr; pipeline 走 globalThis.fetch via http executor)
 *   - bug_fix_events code='create_mr' 行 (status / data.mrIid / data.mrUrl / data.branch / data.isPrimary)
 *   - bug_fix_events code='create_mr' status='failed' 行 (data.error / data.branch / data.isPrimary)
 *
 * 已知差异 (KD-1 ~ KD-5) 软断言保留为 it.todo，不 fail：
 *   KD-1 missing_reportId         —— pipeline 启动前 trigger_params 校验 (错误码差异)
 *   KD-2 report_not_found         —— pipeline noop (sql_query 0 rows)；handler 返回 error
 *   KD-3 no_primary_issue         —— 同 KD-2
 *   KD-4 no_successful_fixes      —— 同 KD-2
 *   KD-5 gitlab_api_error         —— pipeline 仍 success (onItemFailure=continue)；handler 返回 error
 *                                   side effects (failed 事件) 严格对等
 *   KD-NEW skipped 项 output 字符串 —— handler `(已存在)` 显式列出, pipeline 忽略
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

import { resetTestDb, getTestPool } from '../helpers/db.js'
import { triggerCapability } from '../../agent/coordinator.js'
import {
  createBugAnalysisReport,
} from '../../db/repositories/bug-analysis-reports.js'
import { createEvent, findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { getTestRunById } from '../../db/repositories/test-runs.js'
import { resetCheckpointerForTesting } from '../../pipeline/graph-runtime.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'
import { registerCreateMrHandler } from '../../agent/mr/mr-handler.js'
import * as gitlabMr from '../../agent/mr/gitlab-mr.js'
import { readFileSync } from 'fs'
import { join } from 'path'

// 触发 pipeline node-types 自注册
import '../../pipeline/node-types/index.js'

interface CreateMrCall {
  projectPath: string
  sourceBranch: string
  targetBranch: string
  title: string
  description: string
}

interface Fixture {
  productLineId: number
  reportId: number
  issueId: number
  issueIid: number
}

const baseContext = {
  taskId: 'parity-task',
  groupId: 'g',
  platform: 'api',
  initiatorId: 'u-trigger',
  initiatorRole: 'admin' as const,
}

async function bootstrapCreateMrPipelineMapping(): Promise<void> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('pam', 'PAM', 'test')
     ON CONFLICT (name) DO NOTHING`,
  )
  // resetTestDb 不预 seed v37/v40/v41（product_lines 空时 seed skip），bootstrap 后重跑。
  const v37 = readFileSync(join(process.cwd(), 'src/db/schema-v37.sql'), 'utf8')
  await pool.query(v37)
  const v40 = readFileSync(join(process.cwd(), 'src/db/schema-v40.sql'), 'utf8')
  await pool.query(v40)
  const v41 = readFileSync(join(process.cwd(), 'src/db/schema-v41.sql'), 'utf8')
  await pool.query(v41)
}

async function seedCapability(): Promise<void> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO capabilities (key, display_name, description, tool_names, is_system, system_prompt)
     VALUES ('create_mr', 'create-mr', 'parity test', '[]'::jsonb, true, '')
     ON CONFLICT (key) DO NOTHING`,
  )
}

async function seedReportAndProjects(opts: {
  level?: 'l1' | 'l2' | 'l3' | 'l4'
  projects?: Array<{ gitlabPath: string }>
  primaryProjectPath?: string
  rootCauseSummary?: string
}): Promise<Fixture> {
  const pool = getTestPool()
  const plRow = await pool.query(`SELECT id FROM product_lines WHERE name='pam'`)
  const productLineId = plRow.rows[0].id as number

  const projects = opts.projects ?? [{ gitlabPath: 'PAM/svc-a' }]
  for (const [i, p] of projects.entries()) {
    await pool.query(
      `INSERT INTO projects (product_line_id, name, display_name, gitlab_path, owner_id, owner_name, description)
       VALUES ($1, $2, $3, $4, '', '', '')
       ON CONFLICT (name) DO UPDATE
         SET gitlab_path = EXCLUDED.gitlab_path`,
      [productLineId, `proj-${i}-${p.gitlabPath}`, p.gitlabPath, p.gitlabPath],
    )
  }

  const issueId = 1000 + Math.floor(Math.random() * 9000)
  const issueIid = 200 + Math.floor(Math.random() * 800)
  const report = await createBugAnalysisReport({
    issueId,
    issueUrl: `http://gitlab/issue/${issueId}`,
    productLineId,
    agentSessionId: null,
    level: opts.level ?? 'l2',
    classification: 'bug',
    confidence: 'high',
    confidenceScore: 0.9,
    rootCauseSummary: opts.rootCauseSummary ?? '示例根因摘要',
    solutionsJson: [{ id: 'a', summary: 's', recommended: true, risk: 'low', effort: 'small' }],
    affectedModules: null,
    analysisSteps: null,
    metadata: null,
    primaryProjectPath: opts.primaryProjectPath ?? projects[0].gitlabPath,
  })

  // 主 Issue 事件 (mr-handler 用 findPrimaryCreateIssue 拉)
  await createEvent({
    reportId: report.id,
    projectPath: opts.primaryProjectPath ?? projects[0].gitlabPath,
    code: 'create_issue',
    status: 'success',
    data: { issueIid, isPrimary: true },
  })

  return { productLineId, reportId: report.id, issueId, issueIid }
}

interface SeedFixOpts {
  reportId: number
  projectPath: string
  fixSuccess: boolean
  branch?: string
  targetBranch?: string
  fixError?: string
}

async function seedFixAttempt(opts: SeedFixOpts): Promise<void> {
  await createEvent({
    reportId: opts.reportId,
    projectPath: opts.projectPath,
    code: 'fix_attempt',
    status: opts.fixSuccess ? 'success' : 'failed',
    data: opts.fixSuccess
      ? { branch: opts.branch ?? 'fix/issue', targetBranch: opts.targetBranch ?? 'master' }
      : { error: opts.fixError ?? 'fix failed' },
  })
}

async function pollTestRunFinished(runId: number, timeoutMs = 8000): Promise<{ status: string; errorMessage: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const run = await getTestRunById(runId)
    if (run && run.status !== 'pending' && run.status !== 'running') {
      return { status: run.status, errorMessage: run.errorMessage }
    }
    await new Promise(r => setTimeout(r, 50))
  }
  const run = await getTestRunById(runId)
  return { status: run?.status ?? 'unknown', errorMessage: run?.errorMessage ?? '' }
}

/**
 * Mock GitLab API for both paths:
 *  - handler 路径: spy gitlabCreateMr 返回 fake mr
 *  - pipeline 路径: stub globalThis.fetch 返回 GitLab MR JSON
 *
 * 参数:
 *   - mrIidByPath: 每个 projectPath 对应的 mrIid (顺序 mr 创建 1, 2, 3...)
 *   - failures: 哪些 projectPath 调用时抛错
 */
function setupMrApiMocks(
  apiCalls: CreateMrCall[],
  mrIidByPath: Map<string, number>,
  failures: Set<string>,
): { fetchSpy: ReturnType<typeof vi.fn>; gitlabCreateMrSpy: ReturnType<typeof vi.spyOn> } {
  const fetchSpy = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    // pipeline 路径: GitLab MR creation URL — /api/v4/projects/<encoded>/merge_requests
    const m = String(url).match(/\/api\/v4\/projects\/([^/]+)\/merge_requests/)
    if (!m) {
      throw new Error(`unexpected fetch URL: ${url}`)
    }
    const projectPath = decodeURIComponent(m[1])
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    apiCalls.push({
      projectPath,
      sourceBranch: String(body.source_branch ?? ''),
      targetBranch: String(body.target_branch ?? ''),
      title: String(body.title ?? ''),
      description: String(body.description ?? ''),
    })
    if (failures.has(projectPath)) {
      // 模拟 GitLab 返回 400/500 错误
      return new Response('{"message":"gitlab error"}', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
    const iid = mrIidByPath.get(projectPath) ?? 100
    return new Response(
      JSON.stringify({ iid, web_url: `http://gitlab/mr/${iid}` }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    )
  })
  vi.stubGlobal('fetch', fetchSpy)

  const gitlabCreateMrSpy = vi
    .spyOn(gitlabMr, 'gitlabCreateMr')
    .mockImplementation(async (input) => {
      apiCalls.push({
        projectPath: input.projectPath,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        title: input.title,
        description: input.description,
      })
      if (failures.has(input.projectPath)) {
        throw new Error('gitlab error')
      }
      const iid = mrIidByPath.get(input.projectPath) ?? 100
      return { iid, url: `http://gitlab/mr/${iid}` }
    })

  return { fetchSpy, gitlabCreateMrSpy }
}

async function setVarsForPipeline(): Promise<void> {
  // pipeline 内 url/headers 用 {{vars.gitlabUrl}} / {{vars.gitlabToken}}, 通过 runtime_vars 注入
  // 但 internal pipeline 走 runPipelineAsCapability —— extraParams 里的字段会被
  // 转成 runtimeVars (string). 无 gitlab url/token 时 fetch URL 仍可解析为
  // "{{vars.gitlabUrl}}/api/..."(literal placeholder), 测试用 fetch mock 通过
  // /api/v4/projects/.../merge_requests 子串匹配, 所以不需要真值。
}

describe('L_create_mr: create_mr handler vs pipeline 行为对等', () => {
  let apiCalls: CreateMrCall[]
  let mrIidByPath: Map<string, number>
  let failures: Set<string>

  beforeAll(() => {
    registerCreateMrHandler()
  })

  beforeEach(async () => {
    await resetTestDb()
    resetCheckpointerForTesting()
    await bootstrapCreateMrPipelineMapping()
    await seedCapability()
    PipelineApprovalManager.resetInstance()

    apiCalls = []
    mrIidByPath = new Map()
    failures = new Set()
    setupMrApiMocks(apiCalls, mrIidByPath, failures)
    await setVarsForPipeline()
  })

  afterEach(() => {
    process.env.PIPELINE_DAG_HANDLERS = ''
    PipelineApprovalManager.resetInstance()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function runHandlerPath(reportId: number) {
    process.env.PIPELINE_DAG_HANDLERS = ''
    return triggerCapability({
      capabilityKey: 'create_mr',
      context: baseContext,
      extraParams: { reportId },
    })
  }

  async function runPipelinePath(reportId: number) {
    process.env.PIPELINE_DAG_HANDLERS = 'create_mr'
    const result = await triggerCapability({
      capabilityKey: 'create_mr',
      context: baseContext,
      extraParams: { reportId },
    })
    const data = result.data as { runId?: number; pipelineId?: number } | undefined
    if (data?.runId) {
      const finished = await pollTestRunFinished(data.runId, 8000)
      return { result, finished }
    }
    return { result, finished: { status: 'unknown', errorMessage: '' } }
  }

  async function resetForSecondPath() {
    await resetTestDb()
    resetCheckpointerForTesting()
    await bootstrapCreateMrPipelineMapping()
    await seedCapability()
    PipelineApprovalManager.resetInstance()
    apiCalls.length = 0
    mrIidByPath = new Map()
    failures = new Set()
    setupMrApiMocks(apiCalls, mrIidByPath, failures)
    await setVarsForPipeline()
  }

  // ============================================================
  // Scenario 1: 单 project (主仓库)
  // ============================================================
  it('scenario 1: 单 project — 创 1 个 MR, description 含 Closes #<iid>, 写 success event', async () => {
    // ---- handler 路径 ----
    let fx = await seedReportAndProjects({})
    mrIidByPath.set('PAM/svc-a', 42)
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: true,
      branch: 'fix/issue-100',
    })
    const handlerResult = await runHandlerPath(fx.reportId)
    expect(handlerResult.success).toBe(true)
    expect(apiCalls).toHaveLength(1)
    expect(apiCalls[0].projectPath).toBe('PAM/svc-a')
    expect(apiCalls[0].title).toContain('PAM/svc-a')
    expect(apiCalls[0].description).toContain(`Closes #${fx.issueIid}`)
    expect(apiCalls[0].description).toContain('本 MR 由 ChatOps AI 助手自动创建')
    const handlerEvents = await findByReportCode(fx.reportId, 'create_mr')
    expect(handlerEvents).toHaveLength(1)
    expect(handlerEvents[0].status).toBe('success')
    expect(handlerEvents[0].data.mrIid).toBe(42)
    expect(handlerEvents[0].data.branch).toBe('fix/issue-100')
    expect(handlerEvents[0].data.isPrimary).toBe(true)

    // ---- pipeline 路径 ----
    await resetForSecondPath()
    fx = await seedReportAndProjects({})
    mrIidByPath.set('PAM/svc-a', 42)
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: true,
      branch: 'fix/issue-100',
    })
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    expect(apiCalls).toHaveLength(1)
    expect(apiCalls[0].projectPath).toBe('PAM/svc-a')
    expect(apiCalls[0].title).toContain('PAM/svc-a')
    expect(apiCalls[0].description).toContain(`Closes #${fx.issueIid}`)
    expect(apiCalls[0].description).toContain('本 MR 由 ChatOps AI 助手自动创建')
    const pipelineEvents = await findByReportCode(fx.reportId, 'create_mr')
    expect(pipelineEvents).toHaveLength(1)
    expect(pipelineEvents[0].status).toBe('success')
    expect(pipelineEvents[0].data.mrIid).toBe(42)
    expect(pipelineEvents[0].data.branch).toBe('fix/issue-100')
    expect(pipelineEvents[0].data.isPrimary).toBe(true)
  })

  // ============================================================
  // Scenario 2: 多 project (主仓库 + 2 从仓库)
  // ============================================================
  it('scenario 2: 多 project — 主仓库 Closes #<iid>, 从仓库 Related to <primary>#<iid>, 多 project warning', async () => {
    // ---- handler ----
    const projects = [
      { gitlabPath: 'PAM/svc-a' }, // primary
      { gitlabPath: 'PAM/svc-b' },
      { gitlabPath: 'PAM/svc-c' },
    ]
    let fx = await seedReportAndProjects({ projects, primaryProjectPath: 'PAM/svc-a' })
    mrIidByPath.set('PAM/svc-a', 1)
    mrIidByPath.set('PAM/svc-b', 2)
    mrIidByPath.set('PAM/svc-c', 3)
    for (const p of projects) {
      await seedFixAttempt({
        reportId: fx.reportId,
        projectPath: p.gitlabPath,
        fixSuccess: true,
        branch: 'fix/issue-200',
      })
    }
    const r1 = await runHandlerPath(fx.reportId)
    expect(r1.success).toBe(true)
    expect(apiCalls).toHaveLength(3)
    const handlerByPath = new Map(apiCalls.map(c => [c.projectPath, c]))
    expect(handlerByPath.get('PAM/svc-a')!.description).toContain(`Closes #${fx.issueIid}`)
    expect(handlerByPath.get('PAM/svc-b')!.description).toContain(`Related to PAM/svc-a#${fx.issueIid}`)
    expect(handlerByPath.get('PAM/svc-c')!.description).toContain(`Related to PAM/svc-a#${fx.issueIid}`)
    expect(handlerByPath.get('PAM/svc-a')!.description).toContain('涉及 3 个服务')
    expect(handlerByPath.get('PAM/svc-b')!.description).toContain('涉及 3 个服务')
    let events = await findByReportCode(fx.reportId, 'create_mr')
    expect(events).toHaveLength(3)
    expect(events.every(e => e.status === 'success')).toBe(true)
    const handlerByEventPath = new Map(events.map(e => [e.projectPath, e]))
    expect(handlerByEventPath.get('PAM/svc-a')!.data.isPrimary).toBe(true)
    expect(handlerByEventPath.get('PAM/svc-b')!.data.isPrimary).toBe(false)
    expect(handlerByEventPath.get('PAM/svc-c')!.data.isPrimary).toBe(false)

    // ---- pipeline ----
    await resetForSecondPath()
    fx = await seedReportAndProjects({ projects, primaryProjectPath: 'PAM/svc-a' })
    mrIidByPath.set('PAM/svc-a', 1)
    mrIidByPath.set('PAM/svc-b', 2)
    mrIidByPath.set('PAM/svc-c', 3)
    for (const p of projects) {
      await seedFixAttempt({
        reportId: fx.reportId,
        projectPath: p.gitlabPath,
        fixSuccess: true,
        branch: 'fix/issue-200',
      })
    }
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    expect(apiCalls).toHaveLength(3)
    const pipelineByPath = new Map(apiCalls.map(c => [c.projectPath, c]))
    expect(pipelineByPath.get('PAM/svc-a')!.description).toContain(`Closes #${fx.issueIid}`)
    expect(pipelineByPath.get('PAM/svc-b')!.description).toContain(`Related to PAM/svc-a#${fx.issueIid}`)
    expect(pipelineByPath.get('PAM/svc-c')!.description).toContain(`Related to PAM/svc-a#${fx.issueIid}`)
    expect(pipelineByPath.get('PAM/svc-a')!.description).toContain('涉及 3 个服务')
    expect(pipelineByPath.get('PAM/svc-b')!.description).toContain('涉及 3 个服务')
    events = await findByReportCode(fx.reportId, 'create_mr')
    expect(events).toHaveLength(3)
    expect(events.every(e => e.status === 'success')).toBe(true)
    const pipelineByEventPath = new Map(events.map(e => [e.projectPath, e]))
    expect(pipelineByEventPath.get('PAM/svc-a')!.data.isPrimary).toBe(true)
    expect(pipelineByEventPath.get('PAM/svc-b')!.data.isPrimary).toBe(false)
    expect(pipelineByEventPath.get('PAM/svc-c')!.data.isPrimary).toBe(false)
  })

  // ============================================================
  // Scenario 3: 幂等 (已有 1 个 create_mr success event)
  // ============================================================
  it('scenario 3: 幂等 — 已有 success event 的 project 不重复调 API, side effects 对等', async () => {
    // ---- handler ----
    const projects = [{ gitlabPath: 'PAM/svc-a' }, { gitlabPath: 'PAM/svc-b' }]
    let fx = await seedReportAndProjects({ projects, primaryProjectPath: 'PAM/svc-a' })
    mrIidByPath.set('PAM/svc-a', 10)
    mrIidByPath.set('PAM/svc-b', 11)
    for (const p of projects) {
      await seedFixAttempt({
        reportId: fx.reportId,
        projectPath: p.gitlabPath,
        fixSuccess: true,
        branch: 'fix/issue-300',
      })
    }
    // 预先种 svc-a 的 create_mr success 事件 (模拟之前已创建 MR)
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'create_mr',
      status: 'success',
      data: { mrIid: 99, mrUrl: 'http://gitlab/mr/99', branch: 'fix/issue-300', isPrimary: true },
    })
    await runHandlerPath(fx.reportId)
    // svc-a 跳过, 仅 svc-b 调用 API
    expect(apiCalls).toHaveLength(1)
    expect(apiCalls[0].projectPath).toBe('PAM/svc-b')
    let events = await findByReportCode(fx.reportId, 'create_mr')
    // 1 (preexisting) + 1 (new svc-b) = 2
    expect(events).toHaveLength(2)

    // ---- pipeline ----
    await resetForSecondPath()
    fx = await seedReportAndProjects({ projects, primaryProjectPath: 'PAM/svc-a' })
    mrIidByPath.set('PAM/svc-a', 10)
    mrIidByPath.set('PAM/svc-b', 11)
    for (const p of projects) {
      await seedFixAttempt({
        reportId: fx.reportId,
        projectPath: p.gitlabPath,
        fixSuccess: true,
        branch: 'fix/issue-300',
      })
    }
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'create_mr',
      status: 'success',
      data: { mrIid: 99, mrUrl: 'http://gitlab/mr/99', branch: 'fix/issue-300', isPrimary: true },
    })
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    // svc-a 已存在 → SQL 排除 → 只调 svc-b
    expect(apiCalls).toHaveLength(1)
    expect(apiCalls[0].projectPath).toBe('PAM/svc-b')
    events = await findByReportCode(fx.reportId, 'create_mr')
    expect(events).toHaveLength(2)
    expect(events.filter(e => e.status === 'success')).toHaveLength(2)
  })

  // ============================================================
  // Scenario 4: fix_attempt 全 failed (KD-4)
  // ============================================================
  it('scenario 4: fix_attempt 全 failed — handler 返回 no_successful_fixes, pipeline noop (KD-4)', async () => {
    // ---- handler ----
    let fx = await seedReportAndProjects({})
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: false,
      fixError: 'compile error',
    })
    const r1 = await runHandlerPath(fx.reportId)
    expect(r1.success).toBe(false)
    expect(r1.error).toBe('no_successful_fixes')
    expect(apiCalls).toHaveLength(0)
    let events = await findByReportCode(fx.reportId, 'create_mr')
    expect(events).toHaveLength(0)

    // ---- pipeline (KD-4: 整体 success-noop, 不调 API) ----
    await resetForSecondPath()
    fx = await seedReportAndProjects({})
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: false,
      fixError: 'compile error',
    })
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    // side effects 对等: 没调 API, 没写 create_mr 事件
    expect(apiCalls).toHaveLength(0)
    events = await findByReportCode(fx.reportId, 'create_mr')
    expect(events).toHaveLength(0)
  })

  // ============================================================
  // Scenario 5: GitLab API 失败 (KD-5)
  // ============================================================
  it('scenario 5: GitLab API 失败 — 写 failed event, side effects 对等 (KD-5)', async () => {
    // ---- handler ----
    let fx = await seedReportAndProjects({})
    failures.add('PAM/svc-a')
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: true,
      branch: 'fix/issue-500',
    })
    const r1 = await runHandlerPath(fx.reportId)
    expect(r1.success).toBe(false)
    expect(r1.error).toBe('gitlab_api_error')
    expect(apiCalls).toHaveLength(1)
    let events = await findByReportCode(fx.reportId, 'create_mr')
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('failed')
    expect(events[0].data.branch).toBe('fix/issue-500')
    expect(events[0].data.isPrimary).toBe(true)
    expect(typeof events[0].data.error).toBe('string')

    // ---- pipeline (KD-5: 整体 success, 但写 failed event) ----
    await resetForSecondPath()
    fx = await seedReportAndProjects({})
    failures.add('PAM/svc-a')
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: true,
      branch: 'fix/issue-500',
    })
    const { finished } = await runPipelinePath(fx.reportId)
    // KD-5: pipeline run 整体 success (onItemFailure=continue)
    expect(finished.status).toBe('success')
    expect(apiCalls).toHaveLength(1)
    events = await findByReportCode(fx.reportId, 'create_mr')
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('failed')
    expect(events[0].data.branch).toBe('fix/issue-500')
    expect(events[0].data.isPrimary).toBe(true)
    expect(typeof events[0].data.error).toBe('string')
  })

  // ============================================================
  // 已知差异 (KD-1 ~ KD-5) — 软断言占位
  // ============================================================
  it.todo('KD-1: missing_reportId — pipeline 启动前校验拦下 (错误码不同但都失败)')
  it.todo('KD-2: report_not_found — pipeline noop (sql_query 0 rows), handler 返回 error')
  it.todo('KD-3: no_primary_issue (无 create_issue 事件) — 同 KD-2')
  it.todo('KD-4: no_successful_fixes — pipeline noop, handler 返回 error')
  it.todo('KD-5: gitlab_api_error (任一 fan_out item failed) — pipeline 仍 success, handler 返回 error')
})
