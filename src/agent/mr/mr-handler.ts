import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import type { BugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import {
  createEvent,
  findDistinctProjects,
  findLatest,
  findPrimaryCreateIssue,
} from '../../db/repositories/bug-fix-events.js'
import { gitlabCreateMr } from './gitlab-mr.js'

interface ProjectToMr {
  path: string
  branch: string
  targetBranch: string
  isPrimary: boolean
}

/**
 * create_mr capability handler：按 project 循环创建 MR。
 * - 主仓库 MR description 写 `Closes #<issueIid>`
 * - 从仓库 MR description 写 `Related to <primaryPath>#<issueIid>`
 * - 幂等：若某 project 已有 create_mr 成功事件则跳过
 */
export async function handleCreateMr(opts: TriggerOptions): Promise<TriggerResult> {
  const reportId = Number(opts.extraParams?.reportId)
  if (!reportId) {
    return { success: false, error: 'missing_reportId', output: '参数错误: 缺少 reportId' }
  }

  const report = await getBugAnalysisReportById(reportId)
  if (!report) {
    return { success: false, error: 'report_not_found', output: `报告 ${reportId} 不存在` }
  }

  const primaryIssue = await findPrimaryCreateIssue(reportId)
  if (!primaryIssue) {
    return { success: false, error: 'no_primary_issue', output: '找不到主 Issue 事件，无法关联 MR' }
  }
  const mainIssueIid = (primaryIssue.data as Record<string, unknown>).issueIid as number
  const primaryProjectPath = primaryIssue.projectPath ?? report.primaryProjectPath ?? ''

  // 找所有 fix_attempt 成功的 project
  const projects = await findDistinctProjects(reportId)
  const projectsToMr: ProjectToMr[] = []
  for (const p of projects) {
    const latest = await findLatest(reportId, p, 'fix_attempt')
    if (!latest || latest.status !== 'success') continue
    const data = latest.data as Record<string, unknown>
    const branch = typeof data.branch === 'string' ? data.branch : ''
    const targetBranch = typeof data.targetBranch === 'string' ? data.targetBranch : 'master'
    projectsToMr.push({
      path: p,
      branch,
      targetBranch,
      isPrimary: p === primaryProjectPath,
    })
  }

  if (projectsToMr.length === 0) {
    return { success: false, error: 'no_successful_fixes', output: '无成功修复的 project，不创建 MR' }
  }

  const multiProjectCount = projectsToMr.length
  const results: Array<{ path: string; mrIid: number; mrUrl: string; skipped: boolean }> = []
  const errors: Array<{ path: string; error: string }> = []

  for (const p of projectsToMr) {
    // 幂等检查：若已有 create_mr 成功事件则跳过
    const existing = await findLatest(reportId, p.path, 'create_mr')
    if (existing && existing.status === 'success') {
      const d = existing.data as Record<string, unknown>
      results.push({
        path: p.path,
        mrIid: d.mrIid as number,
        mrUrl: (d.mrUrl as string) ?? '',
        skipped: true,
      })
      continue
    }

    const description = buildMrDescription({
      isPrimary: p.isPrimary,
      mainIssueIid,
      primaryProjectPath,
      multiProjectCount,
    })
    const title = buildMrTitle(report, p.path)

    try {
      const mr = await gitlabCreateMr({
        projectPath: p.path,
        sourceBranch: p.branch,
        targetBranch: p.targetBranch,
        title,
        description,
      })
      await createEvent({
        reportId,
        projectPath: p.path,
        code: 'create_mr',
        status: 'success',
        data: { mrIid: mr.iid, mrUrl: mr.url, branch: p.branch, isPrimary: p.isPrimary },
      })
      results.push({ path: p.path, mrIid: mr.iid, mrUrl: mr.url, skipped: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[create_mr] project ${p.path} failed:`, msg)
      await createEvent({
        reportId,
        projectPath: p.path,
        code: 'create_mr',
        status: 'failed',
        data: { error: msg, branch: p.branch, isPrimary: p.isPrimary },
      })
      errors.push({ path: p.path, error: msg })
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      error: 'gitlab_api_error',
      output: `部分 project 创建 MR 失败: ${errors.map(e => `${e.path} (${e.error})`).join('; ')}`,
    }
  }

  const summary = results.map(r => `${r.path}#${r.mrIid}${r.skipped ? '(已存在)' : ''}`).join(', ')
  return {
    success: true,
    output: `创建 ${results.length} 个 MR: ${summary}`,
  }
}

function buildMrDescription(p: {
  isPrimary: boolean
  mainIssueIid: number
  primaryProjectPath: string
  multiProjectCount: number
}): string {
  const lines: string[] = []
  if (p.multiProjectCount > 1) {
    lines.push(`⚠️ 此修复涉及 ${p.multiProjectCount} 个服务，请协调各 MR 的合并顺序。`)
    lines.push('主仓库 MR 合并后会关闭 Issue；请优先合并主仓库 MR。')
    lines.push('')
  }
  if (p.isPrimary) {
    lines.push(`Closes #${p.mainIssueIid}`)
  } else {
    lines.push(`Related to ${p.primaryProjectPath}#${p.mainIssueIid}`)
  }
  lines.push('')
  lines.push('本 MR 由 ChatOps AI 助手自动创建。')
  return lines.join('\n')
}

function buildMrTitle(report: BugAnalysisReport, projectPath: string): string {
  const summary = (report.rootCauseSummary ?? 'Bug 修复').trim().replace(/\n+/g, ' ').slice(0, 60)
  return `[${report.level.toUpperCase()}] ${summary} (${projectPath})`
}

export function registerCreateMrHandler(): void {
  registerCapabilityHandler('create_mr', handleCreateMr)
  console.log('[CreateMr] create_mr handler registered')
}
