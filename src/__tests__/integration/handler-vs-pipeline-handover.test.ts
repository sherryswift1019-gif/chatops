/**
 * P4-T2: L1 (request_handover) handler vs pipeline 行为对等测试
 *
 * 目标：通过 PIPELINE_DAG_HANDLERS feature flag 切换两条执行路径，比较
 *   1) 旧 handler 路径 (handleRequestHandover)
 *   2) 新 pipeline 路径 (handover-internal 5 节点 DAG)
 * 产生的三个 side effects：
 *   - INSERT bug_fix_events (code='handover', status='success', ...)
 *   - GitLab API POST /projects/<path>/issues/<issue_id>/labels（添加 needs-manual）
 *   - UPDATE bug_analysis_reports SET status='pending_manual'
 *
 * 历史背景：phase 3 引入了 7 个新 NodeExecutor 类型 (sql_query/http/db_update/
 * dm/file_read/template_render/fan_out)，但 graph-builder.ts 的 stageType
 * switch 没有同步扩展，第一次运行此测试时 pipeline 路径在 compile 阶段抛
 * "Unsupported stage type"。修复见 commit fix(pipeline): graph-builder
 * switch 加 7 新节点类型 dispatch。
 *
 * 当前断言: pipeline 路径必须 success，三个 side effects 全部命中；同时显式
 * 记录 handler 与 pipeline 的 bug_fix_events.data 字段差异（pipeline 仅写
 * {reason}，handler 写 {reason,projectPaths,fixBranch,...}）——这块对等
 * 由后续 task 通过扩展 DAG 节点补齐。
 */
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// mock gitlab-label，handler 路径走这条；pipeline 路径走 fetch（http executor）
vi.mock('../../agent/handover/gitlab-label.js', () => ({
  gitlabAddIssueLabel: vi.fn().mockResolvedValue(undefined),
}))

import { resetTestDb, getTestPool } from '../helpers/db.js'
import { gitlabAddIssueLabel } from '../../agent/handover/gitlab-label.js'
import { registerRequestHandoverHandler } from '../../agent/handover/request-handover-handler.js'
import { triggerCapability } from '../../agent/coordinator.js'
import {
  createBugAnalysisReport,
  getBugAnalysisReportById,
} from '../../db/repositories/bug-analysis-reports.js'
import { createEvent, findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { getInternalPipelineId } from '../../db/repositories/internal-capability-pipelines.js'
import { getTestRunById } from '../../db/repositories/test-runs.js'
// resetCheckpointerForTesting 让 PostgresSaver 在每个 case 前重新 setup()——
// 否则 resetTestDb 的 DROP SCHEMA CASCADE 会把 checkpoints/checkpoint_writes 表
// 删掉，但 saver 单例缓存仍认为已初始化，下一个 case 跑 pipeline 立即抛
// "relation public.checkpoints does not exist"。
import { resetCheckpointerForTesting } from '../../pipeline/graph-runtime.js'
// 触发 pipeline node-types 自注册（http/sql_query/db_update 等）
import '../../pipeline/node-types/index.js'

interface Fixture {
  productLineId: number
  reportId: number
  issueId: number
  projectPath: string
}

async function bootstrapHandoverPipelineMapping(): Promise<void> {
  // schema-v37 在 product_lines 为空时 skip seed（含 mapping）；这里 bootstrap 一行
  // product_line 后重跑 v37 让 'request_handover' → handover-internal pipeline 映射生效。
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('pam', 'PAM', 'test')
     ON CONFLICT (name) DO NOTHING`,
  )
  const sql = readFileSync(join(process.cwd(), 'src/db/schema-v37.sql'), 'utf8')
  await pool.query(sql)
}

async function seedRequestHandoverCapability(): Promise<void> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO capabilities (key, display_name, description, tool_names, is_system, system_prompt)
     VALUES ('request_handover', '转人工接手', 'handover for tests', '[]'::jsonb, true, '')
     ON CONFLICT (key) DO NOTHING`,
  )
}

async function seedFixture(): Promise<Fixture> {
  const pool = getTestPool()
  const plRes = await pool.query(`SELECT id FROM product_lines WHERE name='pam' LIMIT 1`)
  const productLineId = plRes.rows[0].id as number

  await pool.query(
    `INSERT INTO projects (product_line_id, name, display_name, gitlab_path, owner_id, owner_name, description)
     VALUES ($1, 'pas-6.0', 'pas-6.0', 'PAM/pas-6.0', 'u-owner', 'Owner', '')
     ON CONFLICT (name) DO UPDATE SET gitlab_path = EXCLUDED.gitlab_path`,
    [productLineId],
  )

  const issueId = 4242
  const projectPath = 'PAM/pas-6.0'
  const report = await createBugAnalysisReport({
    issueId,
    issueUrl: `http://git.example.com/${projectPath}/-/issues/${issueId}`,
    productLineId,
    agentSessionId: null,
    level: 'l2',
    classification: 'bug',
    confidence: 'medium',
    confidenceScore: 0.7,
    rootCauseSummary: 'parity test root cause',
    solutionsJson: [{ id: 'a', summary: 's', recommended: true, risk: 'low', effort: 'small' }],
    affectedModules: null,
    analysisSteps: null,
    metadata: null,
    primaryProjectPath: projectPath,
  })

  // scope_identified 事件，handler 收集为 data.projectPaths
  await createEvent({
    reportId: report.id,
    projectPath,
    code: 'scope_identified',
    data: { sourceBranch: 'master', affectedModules: [], isPrimary: true },
  })

  return { productLineId, reportId: report.id, issueId, projectPath }
}

async function pollTestRunFinished(runId: number, timeoutMs = 5000): Promise<{ status: string; errorMessage: string }> {
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

const baseContext = {
  taskId: 'parity-task',
  groupId: 'g',
  platform: 'api',
  initiatorId: 'u-trigger',
  initiatorRole: 'admin' as const,
}

describe('L1: request_handover handler vs pipeline 行为对等', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeAll(() => {
    registerRequestHandoverHandler()
  })

  beforeEach(async () => {
    await resetTestDb()
    // DROP SCHEMA 把 PostgresSaver 自己的表也删了；让 saver 重新 setup()。
    resetCheckpointerForTesting()
    await bootstrapHandoverPipelineMapping()
    await seedRequestHandoverCapability()
    vi.clearAllMocks()
    vi.mocked(gitlabAddIssueLabel).mockResolvedValue(undefined)

    // pipeline 路径里 http 节点用 globalThis.fetch
    fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    // pipeline 路径里 http 节点的 url 用 {{vars.gitlabUrl}}；handler 路径里 axios mock
    // 已经吞掉 gitlabAddIssueLabel，所以两条路径都不真实联网。
    process.env.GITLAB_URL = 'http://gitlab.test'
    process.env.GITLAB_TOKEN = 'fake-token'
  })

  afterEach(() => {
    process.env.PIPELINE_DAG_HANDLERS = ''
    vi.unstubAllGlobals()
  })

  it('handler 路径产生 3 个 side effects', async () => {
    process.env.PIPELINE_DAG_HANDLERS = ''
    const fx = await seedFixture()

    const result = await triggerCapability({
      capabilityKey: 'request_handover',
      context: baseContext,
      extraParams: { reportId: fx.reportId, reason: 'fix_exhausted' },
    })

    expect(result.success).toBe(true)

    // side effect 1: bug_fix_events
    const events = await findByReportCode(fx.reportId, 'handover')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      code: 'handover',
      status: 'success',
      reportId: fx.reportId,
    })
    const data = events[0].data as Record<string, unknown>
    expect(data.reason).toBe('fix_exhausted')
    expect(data.fixBranch).toBe(`fix/issue-${fx.issueId}`)
    expect(data.nextAction).toBe('await_owner')
    expect(Array.isArray(data.projectPaths)).toBe(true)
    expect((data.projectPaths as string[])[0]).toBe(fx.projectPath)

    // side effect 2: GitLab API
    expect(gitlabAddIssueLabel).toHaveBeenCalledTimes(1)
    expect(gitlabAddIssueLabel).toHaveBeenCalledWith(fx.projectPath, fx.issueId, 'needs-manual')

    // side effect 3: report.status
    const report = await getBugAnalysisReportById(fx.reportId)
    expect(report?.status).toBe('pending_manual')
  })

  it('pipeline 路径：feature flag 命中 + 映射存在 → runPipeline 成功并产生 3 个 side effects', async () => {
    // 验证 mapping 已 bootstrap
    const pipelineId = await getInternalPipelineId('request_handover')
    expect(pipelineId).not.toBeNull()
    expect(pipelineId).toBeGreaterThan(0)

    process.env.PIPELINE_DAG_HANDLERS = 'request_handover'
    const fx = await seedFixture()

    const result = await triggerCapability({
      capabilityKey: 'request_handover',
      context: baseContext,
      extraParams: { reportId: fx.reportId, reason: 'fix_exhausted' },
    })

    // coordinator 应该走 runPipelineAsCapability 分支（非 handler）
    expect(result.success).toBe(true)
    const data = result.data as { runId?: number; pipelineId?: number } | undefined
    expect(data?.runId).toBeGreaterThan(0)
    expect(data?.pipelineId).toBe(pipelineId)

    // handler 路径的 axios mock 不应被调（pipeline 路径走 fetch，handler 走 axios）
    expect(gitlabAddIssueLabel).not.toHaveBeenCalled()

    // 等待 pipeline 终态
    const finished = await pollTestRunFinished(data!.runId!, 5000)
    expect(finished.status).toBe('success')

    // side effect 1: bug_fix_events（pipeline write_event 节点写）
    const events = await findByReportCode(fx.reportId, 'handover')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      code: 'handover',
      status: 'success',
      reportId: fx.reportId,
    })

    // side effect 2: GitLab API（pipeline gitlab_label 节点经由 fetch）
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const fetchUrl = fetchSpy.mock.calls[0][0] as string
    expect(fetchUrl).toContain('/api/v4/projects/')
    expect(fetchUrl).toContain('/issues/')
    expect(fetchUrl).toContain('/labels')

    // side effect 3: report.status（pipeline update_status 节点更新）
    const report = await getBugAnalysisReportById(fx.reportId)
    expect(report?.status).toBe('pending_manual')
  })

  it('两条路径 bug_fix_events 行内容差异（已知不对等：pipeline data 仅 {reason}）', async () => {
    // ── 1. handler 路径 ──
    process.env.PIPELINE_DAG_HANDLERS = ''
    const fxA = await seedFixture()
    await triggerCapability({
      capabilityKey: 'request_handover',
      context: baseContext,
      extraParams: { reportId: fxA.reportId, reason: 'fix_exhausted' },
    })
    const handlerEvents = await findByReportCode(fxA.reportId, 'handover')
    expect(handlerEvents).toHaveLength(1)
    const handlerEvent = handlerEvents[0]
    const handlerData = handlerEvent.data as Record<string, unknown>

    // 重置：reset DB 重新种 fixture（不能简单删 events，pipeline 会做幂等检查）
    await resetTestDb()
    resetCheckpointerForTesting()
    await bootstrapHandoverPipelineMapping()
    await seedRequestHandoverCapability()
    vi.clearAllMocks()
    fetchSpy = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    // ── 2. pipeline 路径 ──
    process.env.PIPELINE_DAG_HANDLERS = 'request_handover'
    const fxB = await seedFixture()
    const result = await triggerCapability({
      capabilityKey: 'request_handover',
      context: baseContext,
      extraParams: { reportId: fxB.reportId, reason: 'fix_exhausted' },
    })
    const data = result.data as { runId?: number } | undefined
    const finished = await pollTestRunFinished(data?.runId ?? 0, 5000)
    expect(finished.status).toBe('success')

    const pipelineEvents = await findByReportCode(fxB.reportId, 'handover')
    expect(pipelineEvents).toHaveLength(1)
    const pipelineEvent = pipelineEvents[0]
    const pipelineData = pipelineEvent.data as Record<string, unknown>

    // 共同字段必须一致
    expect(pipelineEvent.code).toBe(handlerEvent.code)
    expect(pipelineEvent.status).toBe(handlerEvent.status)
    expect(pipelineData.reason).toBe(handlerData.reason)

    // 已知差异（schema-v37 DAG write_event 节点仅写 {reason}）：
    //   - handler data 还含 projectPaths/fixBranch/owner/attemptCount/...
    //   - pipeline data 缺这些字段
    // 此差异短期内显式接受，后续 task 扩展 DAG 节点时移除下面这两个 not 断言。
    expect(pipelineData.projectPaths).toBeUndefined()
    expect(pipelineData.fixBranch).toBeUndefined()
  })
})
