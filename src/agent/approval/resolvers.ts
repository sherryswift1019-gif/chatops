/**
 * 内置 approval resolver 的业务实现——server.ts 启动时调
 * registerBuiltinApprovalResolvers() 注册到 approval-resolvers 注册表。
 *
 * 每个 resolver 封装一个"给谁审批"的策略：
 *   - primary_project_owner: L3 Bug 修复方案审批——主仓库 owner
 *   - （未来扩展：reimburse_approver / production_ops_approver / ...）
 */
import {
  registerApprovalResolver,
  type ApprovalResolverResult,
} from '../../pipeline/approval-resolvers.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { getProjectByGitlabPath } from '../../db/repositories/projects-repo.js'
import { findOwner } from '../../db/repositories/module-owners.js'
import { findByReportCode } from '../../db/repositories/bug-fix-events.js'

/**
 * L3 Bug 修复方案审批 resolver：
 *   输入: triggerParams.reportId
 *   查询: report → primaryProjectPath → project.owner_id → fallback module_owners
 *   输出: { approverIds: [主仓库 owner 的钉钉 id], description: 含涉及 project 列表的审批文案 }
 */
async function primaryProjectOwnerResolver(
  triggerParams: Record<string, unknown>,
): Promise<ApprovalResolverResult> {
  const reportId = Number(triggerParams.reportId)
  if (!Number.isFinite(reportId)) {
    throw new Error(
      `primary_project_owner resolver: triggerParams.reportId 非法 (${triggerParams.reportId})`,
    )
  }
  const report = await getBugAnalysisReportById(reportId)
  if (!report) {
    throw new Error(`primary_project_owner resolver: report ${reportId} 不存在`)
  }
  if (!report.primaryProjectPath) {
    throw new Error(
      `primary_project_owner resolver: report ${reportId} 缺 primary_project_path`,
    )
  }
  const proj = await getProjectByGitlabPath(report.primaryProjectPath)
  const ownerId =
    (proj?.ownerId && proj.ownerId !== '' ? proj.ownerId : null)
    ?? (await findOwner(report.productLineId, report.primaryProjectPath))?.ownerUserId
    ?? null
  if (!ownerId) {
    throw new Error(
      `primary_project_owner resolver: 主仓库 ${report.primaryProjectPath} 未配置负责人`,
    )
  }

  // 构造审批卡片 description——带涉及 project 列表让 owner 更容易决策
  const scopes = await findByReportCode(reportId, 'scope_identified')
  const projectsBlock = scopes.length > 0
    ? scopes.map(s => {
        const isPrimary = (s.data as Record<string, unknown>)?.isPrimary === true
        return `- ${s.projectPath}${isPrimary ? '（主仓库）' : ''}`
      }).join('\n')
    : `- ${report.primaryProjectPath}（主仓库）`
  const description = [
    '## L3 Bug 修复方案审批',
    '',
    `Issue: ${report.issueUrl}`,
    '',
    '涉及 project:',
    projectsBlock,
    '',
    `根因摘要: ${report.rootCauseSummary ?? ''}`,
  ].join('\n')

  return { approverIds: [ownerId], description }
}

export function registerBuiltinApprovalResolvers(): void {
  registerApprovalResolver('primary_project_owner', primaryProjectOwnerResolver)
  console.log('[approval-resolvers] builtin resolvers registered')
}
