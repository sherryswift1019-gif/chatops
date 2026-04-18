import { triggerCapability } from '../../agent/coordinator.js'
import { getBugAnalysisReportByIssueId } from '../../db/repositories/bug-analysis-reports.js'
import type { TaskContext } from '../../agent/tools/types.js'

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

function getNewLabels(event: GitLabIssueEvent): string[] {
  const prev = new Set((event.changes?.labels?.previous ?? []).map(l => l.title))
  return (event.changes?.labels?.current ?? []).filter(l => !prev.has(l.title)).map(l => l.title)
}

function getCurrentLabels(event: GitLabIssueEvent): string[] {
  return (event.object_attributes.labels ?? []).map(l => l.title)
}

function buildSystemContext(event: { project: { path_with_namespace: string } }): TaskContext {
  return {
    taskId: `gitlab-webhook-${Date.now()}`,
    groupId: 'system',
    platform: 'gitlab',
    initiatorId: 'gitlab-webhook',
    initiatorRole: 'admin',
  }
}

export async function handleIssueEvent(event: GitLabIssueEvent): Promise<void> {
  const issueIid = event.object_attributes.iid
  const action = event.object_attributes.action
  const newLabels = getNewLabels(event)
  const allLabels = getCurrentLabels(event)

  console.log(`[GitLab] Issue #${issueIid} action=${action}, new labels: [${newLabels.join(',')}]`)

  // Label 状态机驱动
  if (newLabels.includes('approved')) {
    // L3 方案审批通过 → 触发修复
    const report = await getBugAnalysisReportByIssueId(issueIid)
    if (report) {
      console.log(`[GitLab] Issue #${issueIid} approved → triggering fix_bug_l3`)
      triggerCapability({
        capabilityKey: 'fix_bug_l3',
        context: buildSystemContext(event),
        extraParams: { reportId: report.id, issueId: issueIid },
      }).catch(err => console.error(`[GitLab] fix_bug_l3 trigger failed:`, err))
    }
  }
}

export async function handleMergeRequestEvent(event: GitLabMergeRequestEvent): Promise<void> {
  const mrIid = event.object_attributes.iid
  const action = event.object_attributes.action
  const projectPath = event.project.path_with_namespace
  const labels = (event.object_attributes.labels ?? []).map(l => l.title)

  console.log(`[GitLab] MR !${mrIid} action=${action}, labels: [${labels.join(',')}]`)

  // MR 创建且含 ai-generated label → 触发 AI Review
  if (action === 'open' && labels.includes('ai-generated')) {
    console.log(`[GitLab] MR !${mrIid} is ai-generated → triggering ai_review_mr`)
    triggerCapability({
      capabilityKey: 'ai_review_mr',
      context: buildSystemContext(event),
      extraParams: { mrIid, projectPath },
    }).catch(err => console.error(`[GitLab] ai_review_mr trigger failed:`, err))
  }
}
