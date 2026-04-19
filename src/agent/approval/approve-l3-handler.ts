import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import type { BugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import type { BugFixEvent } from '../../db/repositories/bug-fix-events.js'
import { createEvent, findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { getProjectByGitlabPath } from '../../db/repositories/projects-repo.js'
import { findOwner } from '../../db/repositories/module-owners.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'
import type { IMAdapter } from '../../adapters/im/types.js'

/**
 * L3 审批 capability handler。
 * 不动 approval-manager，内部调 requestApproval 完成主仓库 owner 审批，
 * 额外给从仓库 owner 发 FYI 知情 DM（不带审批命令）。
 */
export async function handleApproveL3(opts: TriggerOptions): Promise<TriggerResult> {
  const reportId = Number(opts.extraParams?.reportId)
  if (!reportId) {
    return { success: false, error: 'missing_reportId', output: '参数错误: 缺少 reportId' }
  }

  try {
    const report = await getBugAnalysisReportById(reportId)
    if (!report) {
      return { success: false, error: 'report_not_found', output: `报告 ${reportId} 不存在` }
    }
    if (!report.primaryProjectPath) {
      return { success: false, error: 'no_primary_project', output: '报告缺少 primary_project_path' }
    }

    // 查主仓库 owner：先 projects.owner_id，空则 fallback module_owners
    const primaryProject = await getProjectByGitlabPath(report.primaryProjectPath)
    const primaryOwnerId =
      (primaryProject?.ownerId && primaryProject.ownerId !== ''
        ? primaryProject.ownerId
        : null)
      ?? (await findOwner(report.productLineId, report.primaryProjectPath))?.ownerUserId
      ?? null
    if (!primaryOwnerId) {
      return {
        success: false,
        error: 'no_primary_owner',
        output: `主仓库 ${report.primaryProjectPath} 未配置负责人`,
      }
    }
    const primaryOwnerName = primaryProject?.ownerName || primaryOwnerId

    // 从仓库 owner：扫 scope_identified 事件，按 project_path 反查 owner，去重，排除主仓库 owner
    const scopes = await findByReportCode(reportId, 'scope_identified')
    const otherOwnerIds = new Set<string>()
    for (const s of scopes) {
      if (!s.projectPath) continue
      if (s.projectPath === report.primaryProjectPath) continue
      const proj = await getProjectByGitlabPath(s.projectPath)
      const oid =
        (proj?.ownerId && proj.ownerId !== '' ? proj.ownerId : null)
        ?? (await findOwner(report.productLineId, s.projectPath))?.ownerUserId
        ?? null
      if (oid && oid !== primaryOwnerId) otherOwnerIds.add(oid)
    }

    // 发从仓库 FYI DM（不走 approval-manager，不带审批命令）
    const mgr = PipelineApprovalManager.getInstance()
    const adapter = getFirstAdapter(mgr)
    if (adapter && otherOwnerIds.size > 0) {
      const fyiText = buildFyiMessage({
        issueUrl: report.issueUrl,
        primaryProjectPath: report.primaryProjectPath,
        primaryOwnerName,
        summary: truncate(report.rootCauseSummary ?? '', 200),
      })
      await Promise.all(
        Array.from(otherOwnerIds).map(oid =>
          adapter.sendDirectMessage(oid, { text: fyiText }).catch((err: unknown) => {
            console.error('[approve_l3] FYI DM failed for', oid, err)
          }),
        ),
      )
    }

    // 请求主仓库 owner 审批
    const startTime = Date.now()
    const description = buildApprovalDescription(report, scopes)
    const timeoutMs = (opts.extraParams?.approvalTimeoutMs as number | undefined) ?? 3600_000
    const decision = await mgr.requestApproval(
      [primaryOwnerId],
      description,
      timeoutMs,
      String(report.issueId),
    )

    await createEvent({
      reportId,
      projectPath: null,
      code: 'approval',
      status: decision === 'approved' ? 'success' : 'failed',
      durationMs: Date.now() - startTime,
      data: {
        decision,
        approverId: primaryOwnerId,
        approverName: primaryOwnerName,
      },
    })

    if (decision === 'approved') {
      return { success: true, output: '审批通过' }
    }
    return {
      success: false,
      error: decision,
      output: `审批结果: ${decision}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[approve_l3] handler error:', msg)
    return { success: false, error: 'handler_error', output: `审批 handler 异常: ${msg}` }
  }
}

function getFirstAdapter(mgr: PipelineApprovalManager): IMAdapter | undefined {
  const adapters = (mgr as unknown as { adapters?: IMAdapter[] }).adapters
  return adapters?.[0]
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s
}

function buildFyiMessage(p: {
  issueUrl: string
  primaryProjectPath: string
  primaryOwnerName: string
  summary: string
}): string {
  return [
    'L3 修复方案知情',
    '',
    `Bug 涉及你负责的服务（非主仓库），主负责人 ${p.primaryOwnerName} 正在审批方案。`,
    '',
    `Issue: ${p.issueUrl}`,
    `主仓库: ${p.primaryProjectPath}`,
    '',
    `方案摘要: ${p.summary}`,
    '',
    '如对方案有疑问，请直接联系主负责人。',
  ].join('\n')
}

function buildApprovalDescription(report: BugAnalysisReport, scopes: BugFixEvent[]): string {
  const projects = scopes
    .map(s => {
      const isPrimary = (s.data as Record<string, unknown>)?.isPrimary === true
      return `- ${s.projectPath}${isPrimary ? '（主仓库）' : ''}`
    })
    .join('\n')
  const projectsBlock = projects || `- ${report.primaryProjectPath}（主仓库）`
  return [
    '## L3 Bug 修复方案审批',
    '',
    `Issue: ${report.issueUrl}`,
    '',
    '涉及 project:',
    projectsBlock,
    '',
    `根因摘要: ${report.rootCauseSummary ?? ''}`,
  ].join('\n')
}

export function registerApproveL3Handler(): void {
  registerCapabilityHandler('approve_l3', handleApproveL3)
  console.log('[ApproveL3] approve_l3 handler registered')
}
