/**
 * P4-T3: notify_bug handler vs pipeline 行为对等测试
 *
 * 8 scenario × handler-vs-pipeline 各跑一次。
 *
 * 关键 side effects:
 *   - DM 调用 (handler 走 IMAdapter.sendDirectMessage; pipeline 走 sendImDirect 注册函数)
 *   - bug_fix_events code='notify' 行 (status / data.userId / data.role / data.messageKind / data.mrIids)
 *
 * 已知差异 (KD-1 ~ KD-5) 软断言保留为 it.todo，不 fail：
 *   KD-1 report_not_found     —— pipeline noop (sql_query 0 rows)；handler 返回 error
 *   KD-2 no_recipients        —— 同上
 *   KD-3 im_api_error (部分 owner DM 失败) —— pipeline 仍 success (onItemFailure=continue)；handler 返回 error
 *   KD-4 no_adapter           —— pipeline dm executor 抛错 → fan_out failed item；handler 返回 error
 *   KD-5 missing_reportId     —— pipeline 启动前校验拦下 (实际效果对等失败，错误码不同)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import { resetTestDb, getTestPool } from '../helpers/db.js'
import { triggerCapability } from '../../agent/coordinator.js'
import {
  createBugAnalysisReport,
} from '../../db/repositories/bug-analysis-reports.js'
import { createEvent, findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { getInternalPipelineId } from '../../db/repositories/internal-capability-pipelines.js'
import { getTestRunById } from '../../db/repositories/test-runs.js'
import { resetCheckpointerForTesting } from '../../pipeline/graph-runtime.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'
import { registerNotifyHandler } from '../../agent/notify/notify-handler.js'
import {
  registerImDmSender,
  __clearImSendersForTest,
} from '../../pipeline/im-notifier.js'
import type { IMAdapter } from '../../adapters/im/types.js'

// 触发 pipeline node-types 自注册
import '../../pipeline/node-types/index.js'

interface DmCall {
  userId: string
  text: string
}

interface Fixture {
  productLineId: number
  reportId: number
  issueId: number
}

const baseContext = {
  taskId: 'parity-task',
  groupId: 'g',
  platform: 'api',
  initiatorId: 'u-trigger',
  initiatorRole: 'admin' as const,
}

async function bootstrapNotifyPipelineMapping(): Promise<void> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO product_lines (name, display_name, description)
     VALUES ('pam', 'PAM', 'test')
     ON CONFLICT (name) DO NOTHING`,
  )
  // resetTestDb 不预 seed v40（product_lines 空时 seed skip），bootstrap 后重跑
  // v37 → v40 让 'notify_bug' / 'request_handover' 的 internal mapping 都生效。
  const v37 = readFileSync(join(process.cwd(), 'src/db/schema-v37.sql'), 'utf8')
  await pool.query(v37)
  const v40 = readFileSync(join(process.cwd(), 'src/db/schema-v40.sql'), 'utf8')
  await pool.query(v40)
}

async function seedCapability(): Promise<void> {
  const pool = getTestPool()
  await pool.query(
    `INSERT INTO capabilities (key, display_name, description, tool_names, is_system, system_prompt)
     VALUES ('notify_bug', 'notify-bug', 'parity test', '[]'::jsonb, true, '')
     ON CONFLICT (key) DO NOTHING`,
  )
}

async function seedReportAndProjects(opts: {
  level?: 'l1' | 'l2' | 'l3' | 'l4'
  classification?: 'bug' | 'config_issue' | 'usage_issue'
  projects?: Array<{ gitlabPath: string; ownerId: string; ownerName?: string }>
  primaryProjectPath?: string
}): Promise<Fixture> {
  const pool = getTestPool()
  const plRow = await pool.query(`SELECT id FROM product_lines WHERE name='pam'`)
  const productLineId = plRow.rows[0].id as number

  const projects = opts.projects ?? [
    { gitlabPath: 'PAM/svc-a', ownerId: 'u-alice', ownerName: 'Alice' },
  ]
  for (const [i, p] of projects.entries()) {
    await pool.query(
      `INSERT INTO projects (product_line_id, name, display_name, gitlab_path, owner_id, owner_name, description)
       VALUES ($1, $2, $3, $4, $5, $6, '')
       ON CONFLICT (name) DO UPDATE
         SET gitlab_path = EXCLUDED.gitlab_path,
             owner_id = EXCLUDED.owner_id,
             owner_name = EXCLUDED.owner_name`,
      [productLineId, `proj-${i}-${p.gitlabPath}`, p.gitlabPath, p.gitlabPath, p.ownerId, p.ownerName ?? p.ownerId],
    )
  }

  const issueId = 1000 + Math.floor(Math.random() * 9000)
  const report = await createBugAnalysisReport({
    issueId,
    issueUrl: `http://gitlab/issue/${issueId}`,
    productLineId,
    agentSessionId: null,
    level: opts.level ?? 'l2',
    classification: opts.classification ?? 'bug',
    confidence: 'high',
    confidenceScore: 0.9,
    rootCauseSummary: '示例根因摘要',
    solutionsJson: [{ id: 'a', summary: 's', recommended: true, risk: 'low', effort: 'small' }],
    affectedModules: null,
    analysisSteps: null,
    metadata: null,
    primaryProjectPath: opts.primaryProjectPath ?? projects[0].gitlabPath,
  })

  return { productLineId, reportId: report.id, issueId }
}

interface SeedFixOpts {
  reportId: number
  projectPath: string
  fixSuccess: boolean
  hasMr?: boolean
  mrIid?: number
  mrUrl?: string
  reviewLabel?: 'ai-approved' | 'ai-needs-attention' | null
  fixError?: string
}

async function seedFixAttempt(opts: SeedFixOpts): Promise<void> {
  await createEvent({
    reportId: opts.reportId,
    projectPath: opts.projectPath,
    code: 'scope_identified',
    status: 'success',
    data: { isPrimary: true },
  })
  await createEvent({
    reportId: opts.reportId,
    projectPath: opts.projectPath,
    code: 'fix_attempt',
    status: opts.fixSuccess ? 'success' : 'failed',
    data: opts.fixSuccess
      ? { branch: 'fix/issue' }
      : { error: opts.fixError ?? 'fix failed' },
  })
  if (opts.hasMr) {
    await createEvent({
      reportId: opts.reportId,
      projectPath: opts.projectPath,
      code: 'create_mr',
      status: 'success',
      data: {
        mrIid: opts.mrIid ?? 99,
        mrUrl: opts.mrUrl ?? `http://gitlab/mr/${opts.mrIid ?? 99}`,
        branch: 'fix/issue',
        isPrimary: true,
      },
    })
  }
  if (opts.reviewLabel) {
    await createEvent({
      reportId: opts.reportId,
      projectPath: opts.projectPath,
      code: 'ai_review',
      status: 'success',
      data: { label: opts.reviewLabel },
    })
  }
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

function makeMockAdapter(dmCalls: DmCall[]): IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> } {
  const fn = vi.fn().mockImplementation(async (userId: string, payload: { text: string }) => {
    dmCalls.push({ userId, text: payload.text })
  })
  return {
    platform: 'dingtalk',
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
    sendCard: vi.fn(),
    sendDirectMessage: fn,
    getUserInfo: vi.fn(),
    onCardAction: vi.fn(),
    handleWebhook: vi.fn(),
  } as unknown as IMAdapter & { sendDirectMessage: ReturnType<typeof vi.fn> }
}

describe('L_notify: notify_bug handler vs pipeline 行为对等', () => {
  let dmCalls: DmCall[]

  beforeAll(() => {
    registerNotifyHandler()
  })

  beforeEach(async () => {
    await resetTestDb()
    resetCheckpointerForTesting()
    await bootstrapNotifyPipelineMapping()
    await seedCapability()
    __clearImSendersForTest()
    PipelineApprovalManager.resetInstance()

    dmCalls = []
    const mockAdapter = makeMockAdapter(dmCalls)
    PipelineApprovalManager.initialize([mockAdapter])
    // pipeline 路径用 dm registry
    registerImDmSender('dingtalk', async (userId: string, text: string) => {
      dmCalls.push({ userId, text })
      return { messageId: `m-${Math.floor(Math.random() * 1e9)}` }
    })
  })

  afterEach(() => {
    process.env.PIPELINE_DAG_HANDLERS = ''
    __clearImSendersForTest()
    PipelineApprovalManager.resetInstance()
  })

  // ============================================================
  // Helpers per scenario - 在两条路径下分别跑
  // ============================================================

  async function runHandlerPath(reportId: number) {
    process.env.PIPELINE_DAG_HANDLERS = ''
    return triggerCapability({
      capabilityKey: 'notify_bug',
      context: baseContext,
      extraParams: { reportId },
    })
  }

  async function runPipelinePath(reportId: number) {
    process.env.PIPELINE_DAG_HANDLERS = 'notify_bug'
    const result = await triggerCapability({
      capabilityKey: 'notify_bug',
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

  // Reset between handler and pipeline runs in the same scenario test
  async function resetForSecondPath() {
    await resetTestDb()
    resetCheckpointerForTesting()
    await bootstrapNotifyPipelineMapping()
    await seedCapability()
    __clearImSendersForTest()
    PipelineApprovalManager.resetInstance()

    dmCalls.length = 0
    const mockAdapter = makeMockAdapter(dmCalls)
    PipelineApprovalManager.initialize([mockAdapter])
    registerImDmSender('dingtalk', async (userId: string, text: string) => {
      dmCalls.push({ userId, text })
      return { messageId: `m-${Math.floor(Math.random() * 1e9)}` }
    })
  }

  // ============================================================
  // Scenario 1: fix_success (DM 发送)
  // ============================================================

  it('scenario 1: fix_success — handler & pipeline 都给 owner 发 DM 并写 success notify event', async () => {
    // ---- handler 路径 ----
    let fx = await seedReportAndProjects({})
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: true,
      hasMr: true,
      mrIid: 42,
      mrUrl: 'http://gitlab/mr/42',
      reviewLabel: 'ai-approved',
    })
    const handlerResult = await runHandlerPath(fx.reportId)
    expect(handlerResult.success).toBe(true)
    expect(dmCalls).toHaveLength(1)
    expect(dmCalls[0].userId).toBe('u-alice')
    expect(dmCalls[0].text).toContain('PAM/svc-a')
    expect(dmCalls[0].text).toContain('http://gitlab/mr/42')
    expect(dmCalls[0].text).toContain('ai-approved')
    const handlerEvents = await findByReportCode(fx.reportId, 'notify')
    expect(handlerEvents).toHaveLength(1)
    expect(handlerEvents[0].status).toBe('success')
    expect(handlerEvents[0].data.userId).toBe('u-alice')
    expect(handlerEvents[0].data.role).toBe('owner')
    expect(handlerEvents[0].data.messageKind).toBe('fix_success')
    expect(handlerEvents[0].data.mrIids).toEqual([42])

    // ---- pipeline 路径 ----
    await resetForSecondPath()
    fx = await seedReportAndProjects({})
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: true,
      hasMr: true,
      mrIid: 42,
      mrUrl: 'http://gitlab/mr/42',
      reviewLabel: 'ai-approved',
    })
    const { result, finished } = await runPipelinePath(fx.reportId)
    expect(result.success).toBe(true)
    expect(finished.status).toBe('success')
    expect(dmCalls).toHaveLength(1)
    expect(dmCalls[0].userId).toBe('u-alice')
    expect(dmCalls[0].text).toContain('PAM/svc-a')
    expect(dmCalls[0].text).toContain('http://gitlab/mr/42')
    expect(dmCalls[0].text).toContain('ai-approved')
    const pipelineEvents = await findByReportCode(fx.reportId, 'notify')
    expect(pipelineEvents).toHaveLength(1)
    expect(pipelineEvents[0].status).toBe('success')
    expect(pipelineEvents[0].data.userId).toBe('u-alice')
    expect(pipelineEvents[0].data.role).toBe('owner')
    expect(pipelineEvents[0].data.messageKind).toBe('fix_success')
    expect(pipelineEvents[0].data.mrIids).toEqual([42])
  })

  // ============================================================
  // Scenario 2: fix_success_review_concerns
  // ============================================================

  it('scenario 2: fix_success_review_concerns — 含 needs-attention 警告', async () => {
    // handler
    let fx = await seedReportAndProjects({})
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: true,
      hasMr: true,
      mrIid: 77,
      reviewLabel: 'ai-needs-attention',
    })
    const r1 = await runHandlerPath(fx.reportId)
    expect(r1.success).toBe(true)
    expect(dmCalls).toHaveLength(1)
    expect(dmCalls[0].text).toContain('ai-needs-attention')
    let events = await findByReportCode(fx.reportId, 'notify')
    expect(events[0].data.messageKind).toBe('fix_success_review_concerns')

    // pipeline
    await resetForSecondPath()
    fx = await seedReportAndProjects({})
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: true,
      hasMr: true,
      mrIid: 77,
      reviewLabel: 'ai-needs-attention',
    })
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    expect(dmCalls).toHaveLength(1)
    expect(dmCalls[0].text).toContain('ai-needs-attention')
    events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('success')
    expect(events[0].data.messageKind).toBe('fix_success_review_concerns')
  })

  // ============================================================
  // Scenario 3: l4_created
  // ============================================================

  it('scenario 3: l4_created — Bug level=l4 + 无 MR → DM 含 issueUrl + 摘要', async () => {
    // handler
    let fx = await seedReportAndProjects({ level: 'l4', classification: 'bug' })
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    const r1 = await runHandlerPath(fx.reportId)
    expect(r1.success).toBe(true)
    expect(dmCalls).toHaveLength(1)
    expect(dmCalls[0].text).toContain('L4')
    expect(dmCalls[0].text).toContain(`/issue/${fx.issueId}`)
    let events = await findByReportCode(fx.reportId, 'notify')
    expect(events[0].data.messageKind).toBe('l4_created')

    // pipeline
    await resetForSecondPath()
    fx = await seedReportAndProjects({ level: 'l4', classification: 'bug' })
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    expect(dmCalls).toHaveLength(1)
    expect(dmCalls[0].text).toContain('L4')
    expect(dmCalls[0].text).toContain(`/issue/${fx.issueId}`)
    events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(1)
    expect(events[0].data.messageKind).toBe('l4_created')
  })

  // ============================================================
  // Scenario 4: handover (handover 事件优先)
  // ============================================================

  it('scenario 4: handover — handover 事件 → DM 含 reasonCn + fixBranch + ownerProjectsLine', async () => {
    // handler
    let fx = await seedReportAndProjects({})
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'handover',
      status: 'success',
      data: {
        reason: 'fix_exhausted',
        fixBranch: 'fix/issue-100',
        attemptCount: 3,
        comment: '请协助',
        failureSummary: '编译错误',
      },
    })
    const r1 = await runHandlerPath(fx.reportId)
    expect(r1.success).toBe(true)
    expect(dmCalls).toHaveLength(1)
    expect(dmCalls[0].text).toContain('AI 修复多次未通过')
    expect(dmCalls[0].text).toContain('fix/issue-100')
    expect(dmCalls[0].text).toContain('PAM/svc-a')
    let events = await findByReportCode(fx.reportId, 'notify')
    expect(events[0].data.messageKind).toBe('handover')

    // pipeline
    await resetForSecondPath()
    fx = await seedReportAndProjects({})
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'handover',
      status: 'success',
      data: {
        reason: 'fix_exhausted',
        fixBranch: 'fix/issue-100',
        attemptCount: 3,
        comment: '请协助',
        failureSummary: '编译错误',
      },
    })
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    expect(dmCalls).toHaveLength(1)
    expect(dmCalls[0].text).toContain('AI 修复多次未通过')
    expect(dmCalls[0].text).toContain('fix/issue-100')
    expect(dmCalls[0].text).toContain('PAM/svc-a')
    events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(1)
    expect(events[0].data.messageKind).toBe('handover')
  })

  // ============================================================
  // Scenario 5: fix_failed (不发 DM)
  // ============================================================

  it('scenario 5: fix_failed — handler & pipeline 都不发 DM 且不写 notify event', async () => {
    // handler
    let fx = await seedReportAndProjects({})
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: false,
      fixError: '语法错误',
    })
    await runHandlerPath(fx.reportId)
    expect(dmCalls).toHaveLength(0)
    let events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(0)

    // pipeline
    await resetForSecondPath()
    fx = await seedReportAndProjects({})
    await seedFixAttempt({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      fixSuccess: false,
      fixError: '语法错误',
    })
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    expect(dmCalls).toHaveLength(0)
    events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(0)
  })

  // ============================================================
  // Scenario 6: approval_rejected (不发 DM)
  // ============================================================

  it('scenario 6: approval_rejected — handler & pipeline 都不发 DM', async () => {
    // handler
    let fx = await seedReportAndProjects({})
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'approval',
      status: 'success',
      data: { decision: 'rejected' },
    })
    await runHandlerPath(fx.reportId)
    expect(dmCalls).toHaveLength(0)
    let events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(0)

    // pipeline
    await resetForSecondPath()
    fx = await seedReportAndProjects({})
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'approval',
      status: 'success',
      data: { decision: 'rejected' },
    })
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    expect(dmCalls).toHaveLength(0)
    events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(0)
  })

  // ============================================================
  // Scenario 7: approval_timeout (不发 DM)
  // ============================================================

  it('scenario 7: approval_timeout — handler & pipeline 都不发 DM', async () => {
    let fx = await seedReportAndProjects({})
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'approval',
      status: 'success',
      data: { decision: 'timeout' },
    })
    await runHandlerPath(fx.reportId)
    expect(dmCalls).toHaveLength(0)
    let events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(0)

    await resetForSecondPath()
    fx = await seedReportAndProjects({})
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'approval',
      status: 'success',
      data: { decision: 'timeout' },
    })
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    expect(dmCalls).toHaveLength(0)
    events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(0)
  })

  // ============================================================
  // Scenario 8: approval_retry_analysis (不发 DM)
  // ============================================================

  it('scenario 8: approval_retry_analysis — handler & pipeline 都不发 DM', async () => {
    let fx = await seedReportAndProjects({})
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'approval',
      status: 'success',
      data: { decision: 'retry_analysis' },
    })
    await runHandlerPath(fx.reportId)
    expect(dmCalls).toHaveLength(0)
    let events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(0)

    await resetForSecondPath()
    fx = await seedReportAndProjects({})
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'scope_identified',
      data: { isPrimary: true },
    })
    await createEvent({
      reportId: fx.reportId,
      projectPath: 'PAM/svc-a',
      code: 'approval',
      status: 'success',
      data: { decision: 'retry_analysis' },
    })
    const { finished } = await runPipelinePath(fx.reportId)
    expect(finished.status).toBe('success')
    expect(dmCalls).toHaveLength(0)
    events = await findByReportCode(fx.reportId, 'notify')
    expect(events).toHaveLength(0)
  })

  // ============================================================
  // 已知差异 (KD-1 ~ KD-5) — 软断言 / 行为 side effect 对等但错误码不同
  // ============================================================

  it.todo('KD-1: report_not_found — handler 返回 error，pipeline noop（错误码差异接受）')
  it.todo('KD-2: no_recipients (projects.owner_id 全空) — 同 KD-1')
  it.todo('KD-3: im_api_error (部分 owner DM 失败) — handler 返回 error，pipeline 仍 success（事件 status=failed）')
  it.todo('KD-4: no_adapter — handler 返回 error，pipeline dm executor 抛错 → 事件 status=failed')
  it.todo('KD-5: missing_reportId — handler 返回 error，pipeline 启动前校验拦下（错误码不同但都失败）')
})
