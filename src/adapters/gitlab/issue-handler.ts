import { getPool } from '../../db/client.js'
import {
  getBugAnalysisReportById,
  updateReportStatus,
} from '../../db/repositories/bug-analysis-reports.js'
import { createEvent } from '../../db/repositories/bug-fix-events.js'

// TODO: 保留 webhook 接收做 Bug 修复实例生命周期闭环（MR merge/close → status 同步）
//       Label/MR-created 的 capability 分发已废除，改由 Pipeline 内部驱动

interface GitLabIssueEvent {
  object_kind: 'issue'
  object_attributes: {
    iid: number
    title: string
    action: string
    labels?: { title: string }[]
  }
  project: {
    path_with_namespace: string
  }
  changes?: {
    labels?: {
      previous: { title: string }[]
      current: { title: string }[]
    }
  }
}

interface GitLabMergeRequestEvent {
  object_kind: 'merge_request'
  object_attributes: {
    iid: number
    title: string
    action: string
    source_branch: string
    target_branch: string
    labels?: { title: string }[]
  }
  project: {
    path_with_namespace: string
  }
}

/**
 * Issue webhook：老的 label 驱动 fix_bug_l3 分支已废除（由 Pipeline 驱动）。
 * 这里仅记日志，保留函数签名供 webhook-receiver 调用。
 */
export async function handleIssueEvent(event: GitLabIssueEvent): Promise<void> {
  const issueIid = event.object_attributes?.iid
  const action = event.object_attributes?.action
  console.log(`[GitLab] issue webhook ignored: #${issueIid} action=${action}`)
}

/**
 * MR webhook：仅处理 merge/close 两个终态动作，用于 Bug 修复实例生命周期闭环：
 *   - action='merge' → bug_analysis_reports.status = 'completed'
 *   - action='close' → bug_analysis_reports.status = 'aborted'
 * 其它 action（open/update/reopen/approved 等）一律忽略——由 Pipeline 自己驱动。
 */
export async function handleMergeRequestEvent(event: GitLabMergeRequestEvent): Promise<void> {
  const mrIid = event.object_attributes?.iid
  const action = event.object_attributes?.action
  const projectPath = event.project?.path_with_namespace

  if (action !== 'merge' && action !== 'close') {
    console.log(`[GitLab] MR !${mrIid} action=${action} ignored`)
    return
  }
  if (!mrIid || !projectPath) return

  // 反查 create_mr 事件 → 定位 report
  const { rows } = await getPool().query(
    `SELECT report_id FROM bug_fix_events
     WHERE code = 'create_mr'
       AND project_path = $1
       AND (data->>'mrIid')::int = $2
     ORDER BY id DESC LIMIT 1`,
    [projectPath, mrIid],
  )
  if (rows.length === 0) {
    console.log(`[GitLab] MR ${projectPath}!${mrIid} not managed by us, skip`)
    return
  }

  const reportId = rows[0].report_id as number
  const report = await getBugAnalysisReportById(reportId)
  if (!report) return

  // 幂等：已是终态则跳过，不重复写事件
  if (report.status === 'completed' || report.status === 'aborted') {
    console.log(`[GitLab] report ${reportId} already terminal (${report.status}), skip`)
    return
  }

  const targetStatus = action === 'merge' ? 'completed' : 'aborted'
  await updateReportStatus(reportId, targetStatus)
  await createEvent({
    reportId,
    projectPath,
    code: 'lifecycle_sync',
    data: { mrIid, mrAction: action, targetStatus },
  })
  console.log(`[GitLab] report ${reportId} → ${targetStatus} (MR ${action})`)
}
