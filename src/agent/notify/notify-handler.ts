import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import type { BugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import type { BugFixEvent } from '../../db/repositories/bug-fix-events.js'
import {
  createEvent,
  findByReportCode,
  findDistinctProjects,
  findLatest,
} from '../../db/repositories/bug-fix-events.js'
import { getProjectByGitlabPath } from '../../db/repositories/projects-repo.js'
import { findOwner } from '../../db/repositories/module-owners.js'
import { getTestRunById } from '../../db/repositories/test-runs.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'
import type { IMAdapter } from '../../adapters/im/types.js'

export type MessageKind =
  | 'l4_created'
  | 'approval_rejected'
  | 'approval_timeout'
  | 'approval_retry_analysis'
  | 'fix_success'
  | 'fix_success_review_concerns'
  | 'fix_failed'

interface ReviewInfo {
  label: 'ai-approved' | 'ai-needs-attention' | null
}

interface ProjectMr {
  projectPath: string
  mrIid: number | null
  mrUrl: string | null
  review: ReviewInfo
  fixStatus: 'success' | 'failed' | 'unknown'
  fixError: string | null
}

interface Scenario {
  kind: MessageKind
  projects: ProjectMr[]
  approvalDecision: 'rejected' | 'timeout' | 'retry_analysis' | null
  lastFixError: string | null
}

interface MessageCtx {
  role: 'owner' | 'initiator'
  report: BugAnalysisReport
  scenario: Scenario
  projectPaths: string[]
  mrIids: number[]
  mrUrls: string[]
  reviewLabels: Array<'ai-approved' | 'ai-needs-attention' | null>
}

/**
 * notify_bug capability handler：Pipeline 最后一个 stage，统一发终态 DM。
 * 对每个接收人尝试 adapter.sendDirectMessage 并写 bug_fix_events(code='notify')。
 * DM 失败不阻断其他接收人；只要有一个 notify 事件 status=failed，handler 返回 im_api_error。
 */
export async function handleNotify(opts: TriggerOptions): Promise<TriggerResult> {
  const reportId = Number(opts.extraParams?.reportId)
  if (!reportId) {
    return { success: false, error: 'missing_reportId', output: '参数错误: 缺少 reportId' }
  }

  const report = await getBugAnalysisReportById(reportId)
  if (!report) {
    return { success: false, error: 'report_not_found', output: `报告 ${reportId} 不存在` }
  }

  const triggeredBy = await getTriggeredByFromRun(report.pipelineRunId)
  const projectMrs = await gatherProjects(reportId)
  const scenario = await decideScenario(reportId, report, projectMrs)
  const ownerMap = await buildOwnerMap(projectMrs, report.productLineId)

  // 场景过滤：某些场景 owner 不收通知
  const ownerChannelAllowed = shouldNotifyOwners(scenario.kind)
  const effectiveOwners = ownerChannelAllowed ? ownerMap : new Map<string, OwnerEntry>()

  if (effectiveOwners.size === 0 && !triggeredBy) {
    return { success: false, error: 'no_recipients', output: '无可通知的接收人（触发人和 owner 均空）' }
  }

  const mgr = PipelineApprovalManager.getInstance()
  const adapter = getFirstAdapter(mgr)
  if (!adapter) {
    return { success: false, error: 'no_adapter', output: '无可用 IM adapter' }
  }

  const failures: string[] = []
  let sentCount = 0

  // 各 project owner
  for (const [ownerId, entry] of effectiveOwners) {
    const text = buildMessage(scenario.kind, {
      role: 'owner',
      report,
      scenario,
      projectPaths: entry.projectPaths,
      mrIids: entry.mrIids,
      mrUrls: entry.mrUrls,
      reviewLabels: entry.reviewLabels,
    })
    if (!text) continue

    const ok = await sendOne(adapter, ownerId, text, {
      reportId,
      role: 'owner',
      messageKind: scenario.kind,
      mrIids: entry.mrIids,
    })
    if (ok.success) {
      sentCount += 1
    } else {
      failures.push(`owner ${ownerId}: ${ok.error}`)
    }
  }

  // 触发人汇总
  if (triggeredBy) {
    const allMrIids = projectMrs
      .map(p => p.mrIid)
      .filter((n): n is number => typeof n === 'number')
    const allMrUrls = projectMrs
      .map(p => p.mrUrl)
      .filter((u): u is string => !!u)
    const allLabels = projectMrs.map(p => p.review.label)
    const text = buildMessage(scenario.kind, {
      role: 'initiator',
      report,
      scenario,
      projectPaths: projectMrs.map(p => p.projectPath),
      mrIids: allMrIids,
      mrUrls: allMrUrls,
      reviewLabels: allLabels,
    })
    if (text) {
      const ok = await sendOne(adapter, triggeredBy, text, {
        reportId,
        role: 'initiator',
        messageKind: scenario.kind,
        mrIids: allMrIids,
      })
      if (ok.success) {
        sentCount += 1
      } else {
        failures.push(`initiator ${triggeredBy}: ${ok.error}`)
      }
    }
  }

  if (failures.length > 0) {
    return { success: false, error: 'im_api_error', output: `部分 DM 失败: ${failures.join('; ')}` }
  }
  return { success: true, output: `已发送通知 ${sentCount} 条` }
}

interface OwnerEntry {
  projectPaths: string[]
  mrIids: number[]
  mrUrls: string[]
  reviewLabels: Array<'ai-approved' | 'ai-needs-attention' | null>
}

async function buildOwnerMap(
  projectMrs: ProjectMr[],
  productLineId: number,
): Promise<Map<string, OwnerEntry>> {
  const map = new Map<string, OwnerEntry>()
  for (const p of projectMrs) {
    const ownerId = await resolveOwner(p.projectPath, productLineId)
    if (!ownerId) continue
    const entry = map.get(ownerId) ?? {
      projectPaths: [],
      mrIids: [],
      mrUrls: [],
      reviewLabels: [],
    }
    entry.projectPaths.push(p.projectPath)
    if (typeof p.mrIid === 'number') entry.mrIids.push(p.mrIid)
    if (p.mrUrl) entry.mrUrls.push(p.mrUrl)
    entry.reviewLabels.push(p.review.label)
    map.set(ownerId, entry)
  }
  return map
}

async function resolveOwner(projectPath: string, productLineId: number): Promise<string | null> {
  const proj = await getProjectByGitlabPath(projectPath)
  const direct = proj?.ownerId && proj.ownerId !== '' ? proj.ownerId : null
  if (direct) return direct
  const fallback = await findOwner(productLineId, projectPath)
  return fallback?.ownerUserId ?? null
}

async function gatherProjects(reportId: number): Promise<ProjectMr[]> {
  const paths = await collectProjectPaths(reportId)
  const out: ProjectMr[] = []
  for (const p of paths) {
    const fix = await findLatest(reportId, p, 'fix_attempt')
    const mr = await findLatest(reportId, p, 'create_mr')
    const review = await findLatest(reportId, p, 'ai_review')
    const mrData = (mr?.data ?? {}) as Record<string, unknown>
    const reviewData = (review?.data ?? {}) as Record<string, unknown>
    const labelRaw = typeof reviewData.label === 'string' ? reviewData.label : null
    const label =
      labelRaw === 'ai-approved' || labelRaw === 'ai-needs-attention' ? labelRaw : null
    const fixData = (fix?.data ?? {}) as Record<string, unknown>
    out.push({
      projectPath: p,
      mrIid: mr?.status === 'success' && typeof mrData.mrIid === 'number' ? mrData.mrIid : null,
      mrUrl: mr?.status === 'success' && typeof mrData.mrUrl === 'string' ? mrData.mrUrl : null,
      review: { label },
      fixStatus: fix ? fix.status : 'unknown',
      fixError: fix?.status === 'failed' && typeof fixData.error === 'string' ? fixData.error : null,
    })
  }
  return out
}

/** 从 scope_identified / fix_attempt / create_mr 合并得到涉及的 project 列表 */
async function collectProjectPaths(reportId: number): Promise<string[]> {
  const direct = await findDistinctProjects(reportId)
  if (direct.length > 0) return direct
  const scopes = await findByReportCode(reportId, 'scope_identified')
  const set = new Set<string>()
  for (const s of scopes) {
    if (s.projectPath) set.add(s.projectPath)
  }
  return Array.from(set)
}

async function getTriggeredByFromRun(runId: number | null): Promise<string | null> {
  if (!runId) return null
  const run = await getTestRunById(runId)
  if (!run || !run.triggeredBy) return null
  return run.triggeredBy
}

async function decideScenario(
  reportId: number,
  report: BugAnalysisReport,
  projectMrs: ProjectMr[],
): Promise<Scenario> {
  // approval 事件优先
  const approvals = await findByReportCode(reportId, 'approval')
  const latestApproval = approvals.length > 0 ? approvals[approvals.length - 1] : null
  const approvalDecision = latestApproval
    ? (((latestApproval.data ?? {}) as Record<string, unknown>).decision as
        | 'approved'
        | 'rejected'
        | 'timeout'
        | 'retry_analysis'
        | undefined) ?? null
    : null

  if (approvalDecision === 'rejected') {
    return { kind: 'approval_rejected', projects: projectMrs, approvalDecision: 'rejected', lastFixError: null }
  }
  if (approvalDecision === 'timeout') {
    return { kind: 'approval_timeout', projects: projectMrs, approvalDecision: 'timeout', lastFixError: null }
  }
  if (approvalDecision === 'retry_analysis') {
    return {
      kind: 'approval_retry_analysis',
      projects: projectMrs,
      approvalDecision: 'retry_analysis',
      lastFixError: null,
    }
  }

  // L4 / 非 bug 分类 + 无 MR
  const hasAnyMr = projectMrs.some(p => typeof p.mrIid === 'number')
  if (report.classification === 'bug' && report.level === 'l4' && !hasAnyMr) {
    return { kind: 'l4_created', projects: projectMrs, approvalDecision: null, lastFixError: null }
  }

  // 修复结果判断
  const fixStates = projectMrs.map(p => p.fixStatus)
  const anyFailed = fixStates.includes('failed')
  const allSuccess =
    projectMrs.length > 0 && projectMrs.every(p => p.fixStatus === 'success' && typeof p.mrIid === 'number')

  if (anyFailed && !allSuccess && !hasAnyMr) {
    const lastFailed = projectMrs.find(p => p.fixStatus === 'failed' && p.fixError)
    return {
      kind: 'fix_failed',
      projects: projectMrs,
      approvalDecision: null,
      lastFixError: lastFailed?.fixError ?? null,
    }
  }

  if (allSuccess) {
    const hasConcerns = projectMrs.some(p => p.review.label === 'ai-needs-attention')
    if (hasConcerns) {
      return {
        kind: 'fix_success_review_concerns',
        projects: projectMrs,
        approvalDecision: null,
        lastFixError: null,
      }
    }
    return { kind: 'fix_success', projects: projectMrs, approvalDecision: null, lastFixError: null }
  }

  // 兜底：当前状态不典型（例如有 MR 但部分 fix failed），按 success-with-concerns 的形式通报
  if (hasAnyMr) {
    const hasConcerns = projectMrs.some(p => p.review.label === 'ai-needs-attention')
    return {
      kind: hasConcerns ? 'fix_success_review_concerns' : 'fix_success',
      projects: projectMrs,
      approvalDecision: null,
      lastFixError: null,
    }
  }

  // 完全没有有效事件（罕见）→ 以 fix_failed 兜底
  return { kind: 'fix_failed', projects: projectMrs, approvalDecision: null, lastFixError: null }
}

function shouldNotifyOwners(kind: MessageKind): boolean {
  switch (kind) {
    case 'fix_success':
    case 'fix_success_review_concerns':
      return true
    case 'l4_created':
    case 'fix_failed':
    case 'approval_rejected':
    case 'approval_timeout':
    case 'approval_retry_analysis':
      return false
    default:
      return false
  }
}

/**
 * 消息模板构造（spec "DM 通知策略" 章节）。role='owner' 时只列该 owner 负责 project 的 MR。
 * 文案里的 emoji 属于 spec 用户可见部分，保留。
 */
export function buildMessage(kind: MessageKind, ctx: MessageCtx): string | null {
  const { role, report, scenario } = ctx
  switch (kind) {
    case 'fix_success': {
      if (role === 'owner') {
        const mrLines = ctx.projectPaths.map((path, i) => {
          const url = ctx.mrUrls[i] ?? `MR !${ctx.mrIids[i] ?? '?'}`
          return `- ${path}: ${url}`
        })
        const summary = (report.rootCauseSummary ?? '').slice(0, 200)
        return [
          `✅ 你负责的服务已自动修复，MR 等待合并：`,
          ...mrLines,
          '',
          `📋 修复方案：${summary}`,
          '',
          `AI Review 结论：✅ ai-approved`,
        ].join('\n')
      }
      // initiator
      const lines = [
        `✅ Bug 已自动修复`,
        '',
        `Issue: ${report.issueUrl}`,
        `等级: ${report.level.toUpperCase()}`,
        `涉及服务 (${ctx.projectPaths.length} 个):`,
      ]
      ctx.projectPaths.forEach((path, i) => {
        const url = ctx.mrUrls[i] ?? `MR !${ctx.mrIids[i] ?? '?'}`
        lines.push(`- ${path}: ${url}`)
      })
      lines.push('', `AI Review 结论：${summarizeLabels(ctx.reviewLabels)}`)
      return lines.join('\n')
    }
    case 'fix_success_review_concerns': {
      if (role === 'owner') {
        const mrLines = ctx.projectPaths.map((path, i) => {
          const url = ctx.mrUrls[i] ?? `MR !${ctx.mrIids[i] ?? '?'}`
          return `- ${path}: ${url}`
        })
        return [
          `⚠️ AI Review 发现问题`,
          '',
          `你负责的服务已修复并创建 MR：`,
          ...mrLines,
          '',
          `AI Review 标签：⚠️ ai-needs-attention`,
          `请关注并决定是否合并。`,
        ].join('\n')
      }
      const lines = [
        `⚠️ Bug 已修复但 AI Review 有关注点`,
        '',
        `Issue: ${report.issueUrl}`,
        `等级: ${report.level.toUpperCase()}`,
        `涉及服务 (${ctx.projectPaths.length} 个):`,
      ]
      ctx.projectPaths.forEach((path, i) => {
        const url = ctx.mrUrls[i] ?? `MR !${ctx.mrIids[i] ?? '?'}`
        lines.push(`- ${path}: ${url}`)
      })
      lines.push('', `AI Review 结论：${summarizeLabels(ctx.reviewLabels)}`)
      return lines.join('\n')
    }
    case 'fix_failed': {
      if (role !== 'initiator') return null
      return [
        `❌ Bug 修复失败`,
        '',
        `Issue: ${report.issueUrl}`,
        `等级: ${report.level.toUpperCase()}`,
        `失败原因: ${scenario.lastFixError ?? '未知'}`,
        '',
        `Pipeline 已终止，可在 Bug 修复实例页面点重试。`,
      ].join('\n')
    }
    case 'l4_created': {
      if (role !== 'initiator') return null
      const summary = (report.rootCauseSummary ?? '').slice(0, 200)
      return [
        `ℹ️ 问题太复杂，AI 无法自动修复`,
        '',
        `Issue 已创建: ${report.issueUrl}`,
        `等级: L4`,
        `根因摘要: ${summary}`,
        '',
        `请人工介入处理。`,
      ].join('\n')
    }
    case 'approval_rejected': {
      if (role !== 'initiator') return null
      return [
        `❌ L3 修复方案审批被拒绝`,
        '',
        `Issue: ${report.issueUrl}`,
        `等级: ${report.level.toUpperCase()}`,
        '',
        `Pipeline 已终止，可在 Bug 修复实例页面点重试或人工介入。`,
      ].join('\n')
    }
    case 'approval_timeout': {
      if (role !== 'initiator') return null
      return [
        `❌ L3 修复方案审批超时`,
        '',
        `Issue: ${report.issueUrl}`,
        `等级: ${report.level.toUpperCase()}`,
        '',
        `Pipeline 已终止，可在 Bug 修复实例页面点重试。`,
      ].join('\n')
    }
    case 'approval_retry_analysis': {
      if (role !== 'initiator') return null
      return [
        `ℹ️ L3 修复方案要求重新分析`,
        '',
        `Issue: ${report.issueUrl}`,
        `等级: ${report.level.toUpperCase()}`,
        '',
        `新一轮分析将自动开始。`,
      ].join('\n')
    }
    default:
      return null
  }
}

function summarizeLabels(labels: Array<'ai-approved' | 'ai-needs-attention' | null>): string {
  if (labels.length === 0) return 'Review 已跳过'
  const approved = labels.filter(l => l === 'ai-approved').length
  const concerns = labels.filter(l => l === 'ai-needs-attention').length
  const skipped = labels.filter(l => l === null).length
  const parts: string[] = []
  if (approved > 0) parts.push(`${approved} 个 ai-approved`)
  if (concerns > 0) parts.push(`${concerns} 个 ai-needs-attention`)
  if (skipped > 0) parts.push(`${skipped} 个未评审`)
  return parts.join('、')
}

interface SendMeta {
  reportId: number
  role: 'owner' | 'initiator'
  messageKind: MessageKind
  mrIids: number[]
}

async function sendOne(
  adapter: IMAdapter,
  userId: string,
  text: string,
  meta: SendMeta,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    await adapter.sendDirectMessage(userId, { text })
    await createEvent({
      reportId: meta.reportId,
      projectPath: null,
      code: 'notify',
      status: 'success',
      data: {
        userId,
        role: meta.role,
        messageKind: meta.messageKind,
        mrIids: meta.mrIids,
      },
    })
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[notify_bug] DM failed for', userId, msg)
    await createEvent({
      reportId: meta.reportId,
      projectPath: null,
      code: 'notify',
      status: 'failed',
      data: {
        userId,
        role: meta.role,
        messageKind: meta.messageKind,
        mrIids: meta.mrIids,
        error: msg,
      },
    })
    return { success: false, error: msg }
  }
}

function getFirstAdapter(mgr: PipelineApprovalManager): IMAdapter | undefined {
  const adapters = (mgr as unknown as { adapters?: IMAdapter[] }).adapters
  return adapters?.[0]
}

// 保持类型导出供测试用（避免 lint 提示未用导入）
export type { BugFixEvent }

export function registerNotifyHandler(): void {
  registerCapabilityHandler('notify_bug', handleNotify)
  console.log('[Notify] notify_bug handler registered')
}
