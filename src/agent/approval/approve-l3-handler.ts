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
    // C3：fail-fast —— approvalTimeoutMs 必须由 stage.capabilityParams 显式传入。
    // 配置缺失或非法立即 return error，避免默认值掩盖配置错误。
    const timeoutMs = Number(opts.extraParams?.approvalTimeoutMs)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return {
        success: false,
        error: 'invalid_timeout',
        output: 'approvalTimeoutMs 未配置或非法（必须由 stage.capabilityParams 显式传入）',
      }
    }

    // ── 给主 owner 发互动卡片（按钮批准/拒绝）──
    // 注：approval-manager 内部还会发一条纯文本 DM（群命令 fallback），所以 owner 会看到 2 条。
    // 卡片是主 UX，文本作为 fallback（若模板渲染失败，命令仍可用）。
    if (adapter) {
      const approvalKey = `l3-fix-${report.issueId}`
      await adapter
        .sendDirectMessage(primaryOwnerId, {
          title: 'L3 修复方案审批',
          body: description,
          actions: [
            { label: '同意', value: 'agree', style: 'primary' },
            { label: '拒绝', value: 'reject', style: 'danger' },
          ],
          callbackData: { taskId: approvalKey },
          templateParams: {
            title: 'L3 修复方案审批',
            Issue_link: report.issueUrl,
            remark: description,
            created_at: formatNow(),
          },
        })
        .catch((err: unknown) => {
          // 卡片发送失败不阻塞主流程，approval-manager 的文字 DM 兜底（群命令仍可审批）
          console.error('[approve_l3] 互动卡片发送失败（降级为文字命令审批）:', err)
        })
    }

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
  // ⚠️ 访问 approval-manager 的 private `adapters` 字段。
  // 这里双重断言绕过类型系统是有意的妥协：
  //   - approval-manager.ts 是 Task 7 计划中的硬约束文件（严益昌原创代码），
  //     不允许添加 public getter/getAdapters() 方法
  //   - approve-l3-handler 需要 adapter 给从仓库 owner 发 FYI DM（不经审批流）
  //   - 未来如果能放开硬约束，首选方案：approval-manager 暴露 getAdapters() getter
  //     或 initialize() 时把 adapters 存到一个 module-scope 变量供其他 handler 取用
  // 已知风险：如果 approval-manager 内部 adapters 字段重命名或改为 Map，此处会静默返回 undefined
  // 注意：BugFixEvents 已经记录 approval 事件和 project 信息，FYI DM 发送失败不影响主审批流程
  const adapters = (mgr as unknown as { adapters?: IMAdapter[] }).adapters
  return adapters?.[0]
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s
}

/** 格式化当前时间为 yyyy-mm-dd HH:MM:SS（供钉钉卡片 created_at 变量用） */
function formatNow(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
