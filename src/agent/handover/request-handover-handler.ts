/**
 * request_handover capability handler（V2 完整接口，MVP 实现 3 个 reason）。
 *
 * V2 spec §9.3：AI 自动化失败时转人工接手的统一入口。
 * 触发源（reason）：
 *   MVP 支持：
 *     - fix_exhausted    — fix-runner 3 轮失败
 *     - l4_manual        — analyzer 判 L4
 *     - user_requested   — 触发人在前端点"转人工"
 *   V2 预留（本期不触发，但 handler 接收到也不报错）：
 *     - revise_exhausted — revise 3 轮失败
 *     - low_confidence   — 分析置信度过低
 *     - owner_label      — owner 在 GitLab 打 needs-manual label
 *     - tag_unrevisable  — tag bug 无法自动建 release 分支
 *
 * 动作：
 * 1. 幂等校验（已有 handover success 事件则跳过）
 * 2. GitLab Issue 打 `needs-manual` label（失败记告警，不阻断）
 * 3. 写 bug_fix_events(code='handover', data=V2 结构)
 * 4. 更新 report.status = 'pending_manual'
 *
 * 本 handler 不发 DM；DM 由 coordinator 依次调用的 notify_bug (kind='handover') 负责
 * （V2 里是 handover-pipeline 的下一个 stage；MVP 里是 coordinator 顺序调用两个 capability）。
 */
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import {
  getBugAnalysisReportById,
  updateReportStatus,
} from '../../db/repositories/bug-analysis-reports.js'
import { createEvent, findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { gitlabAddIssueLabel } from './gitlab-label.js'

export type HandoverReason =
  | 'fix_exhausted'
  | 'revise_exhausted'
  | 'l4_manual'
  | 'low_confidence'
  | 'user_requested'
  | 'owner_label'
  | 'tag_unrevisable'

const MVP_SUPPORTED_REASONS: HandoverReason[] = [
  'fix_exhausted',
  'l4_manual',
  'user_requested',
]

const ALL_REASONS: HandoverReason[] = [
  'fix_exhausted',
  'revise_exhausted',
  'l4_manual',
  'low_confidence',
  'user_requested',
  'owner_label',
  'tag_unrevisable',
]

function isValidReason(value: unknown): value is HandoverReason {
  return typeof value === 'string' && (ALL_REASONS as string[]).includes(value)
}

/** 从 issueUrl 提取 project path（http://.../PAM/pas-6.0/-/issues/42 → PAM/pas-6.0） */
function parseProjectPathFromIssueUrl(issueUrl: string): string | null {
  const m = issueUrl.match(/https?:\/\/[^/]+\/(.+?)\/-\/issues\/\d+/)
  return m ? m[1] : null
}

export async function handleRequestHandover(opts: TriggerOptions): Promise<TriggerResult> {
  const reportId = Number(opts.extraParams?.reportId)
  if (!reportId) {
    return { success: false, error: 'missing_reportId', output: '参数错误: 缺少 reportId' }
  }

  const reasonRaw = opts.extraParams?.reason
  if (!reasonRaw) {
    return { success: false, error: 'missing_reason', output: '参数错误: 缺少 reason' }
  }
  if (!isValidReason(reasonRaw)) {
    return {
      success: false,
      error: 'invalid_reason',
      output: `reason 不在白名单内（有效值：${ALL_REASONS.join(', ')}）`,
    }
  }
  const reason: HandoverReason = reasonRaw
  if (!MVP_SUPPORTED_REASONS.includes(reason)) {
    // V2 预留 reason：记录日志但继续处理（写事件 + 改状态，与 MVP 一致）
    console.warn(`[RequestHandover] reason=${reason} is V2-only; handler proceeds anyway`)
  }

  try {
    const report = await getBugAnalysisReportById(reportId)
    if (!report) {
      return { success: false, error: 'report_not_found', output: `报告 ${reportId} 不存在` }
    }

    // 幂等：已有 handover success 事件则直接返回
    const existing = await findByReportCode(reportId, 'handover')
    if (existing.some(e => e.status === 'success')) {
      console.log(`[RequestHandover] report=${reportId} already handed over (idempotent skip)`)
      return { success: true, output: 'already handed over (idempotent)' }
    }

    // 上下文（MVP 解析可选字段，不做强校验；V2 spec §9.3 定义的结构）
    const ctx = (opts.extraParams?.context ?? {}) as Record<string, unknown>
    const failedStage = typeof ctx.failedStage === 'string' ? ctx.failedStage : null
    const comment = typeof ctx.comment === 'string' ? ctx.comment : null
    const attemptCount =
      typeof ctx.attemptCount === 'number' && Number.isFinite(ctx.attemptCount)
        ? ctx.attemptCount
        : null

    // 1. GitLab Issue 打 needs-manual label（失败降级，不阻断 handover 主流程）
    // 优先用 report.primaryProjectPath（analyzer 写入时已规整）；仅在该字段为空时回退到 issueUrl 正则解析
    const issueProjectPath =
      (report.primaryProjectPath && report.primaryProjectPath.length > 0
        ? report.primaryProjectPath
        : null) ?? parseProjectPathFromIssueUrl(report.issueUrl)
    let labelAdded = false
    let labelError: string | null = null
    if (issueProjectPath) {
      try {
        await gitlabAddIssueLabel(issueProjectPath, report.issueId, 'needs-manual')
        labelAdded = true
      } catch (err) {
        labelError = err instanceof Error ? err.message : String(err)
        console.warn(
          `[RequestHandover] gitlab label failed (fail-soft): report=${reportId} err=${labelError}`,
        )
      }
    } else {
      labelError = `cannot derive project path (primaryProjectPath empty, issueUrl=${report.issueUrl})`
      console.warn(`[RequestHandover] ${labelError}`)
    }

    // 2. 收集涉及 project_path（供 notify_bug 等后续阶段读取）
    const scopes = await findByReportCode(reportId, 'scope_identified')
    const projectPaths = Array.from(
      new Set(scopes.map(s => s.projectPath).filter((p): p is string => !!p)),
    )

    // 3. 写 handover 事件（V2 data 结构）
    const fixBranch = `fix/issue-${report.issueId}`
    await createEvent({
      reportId,
      projectPath: null,
      code: 'handover',
      status: 'success',
      data: {
        reason,
        projectPaths,
        fixBranch,
        failedAt: failedStage,
        attemptCount,
        comment,
        nextAction: 'await_owner',
        labelAdded,
        ...(labelError ? { labelError } : {}),
      },
    })

    // 4. 状态转 pending_manual（V2 spec §5 状态机）
    await updateReportStatus(reportId, 'pending_manual')

    console.log(
      `[RequestHandover] report=${reportId} reason=${reason} → pending_manual (${projectPaths.length} projects, label=${labelAdded})`,
    )
    return {
      success: true,
      output: `handover requested (${reason}) for ${projectPaths.length} projects`,
      data: { reportId, reason, projectPaths, fixBranch, labelAdded },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[RequestHandover] handler error for report ${reportId}:`, msg)
    return { success: false, error: 'handler_error', output: msg }
  }
}

export function registerRequestHandoverHandler(): void {
  registerCapabilityHandler('request_handover', handleRequestHandover)
  console.log('[RequestHandover] handler registered')
}
