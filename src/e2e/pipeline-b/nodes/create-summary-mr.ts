// src/e2e/pipeline-b/nodes/create-summary-mr.ts
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { getE2eTargetProject, extractGitlabPath } from '../../../db/repositories/e2e-target-projects.js'
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { notifyRunPassed } from '../im-notifier.js'
import type { PipelineBStateType } from '../types.js'

export async function createSummaryMrNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { runId, iterationBranch, sourceBranch, targetProjectId } = state

  // Happy path: 所有 scenario 第 1 次就 pass，没走过 e2e-fix-agent 修过任何代码 →
  // iterationBranch 跟 sourceBranch 完全相同（无新 commit），且 GitLab 上不存在该 branch
  // （init-run 只在 workspace 本地 checkout -b，不 push）。这种情况创 MR 会得到一个
  // source_branch 不存在的空 MR（state=closed/conflict），是数据噪音。
  // 直接 finalize 为 passed，不动 git/不调 GitLab API。
  const fixedCount = Object.values(state.governorState.perScenarioAttempts).filter(n => n > 1).length
  if (fixedCount === 0) {
    console.log(`[PipelineB:createSummaryMr] runId=${runId} happy path（无 scenario 走过 fix），跳过 MR 创建`)
    await updateE2eRunStatus(runId, 'passed', { finishedAt: new Date() })
    if (state.imContext) {
      notifyRunPassed(
        { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId },
        0,
        null,
      ).catch(() => {})
    }
    return { summaryMrUrl: null }
  }

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${targetProjectId}" not found`)

  const gitlabConfig = await resolveGitlabConfig()
  if (!gitlabConfig.url || !gitlabConfig.token) {
    console.warn(`[PipelineB:createSummaryMr] gitlab config incomplete, skipping MR creation`)
    await updateE2eRunStatus(runId, 'passed', { finishedAt: new Date() })
    return {}
  }

  const encodedRepo = encodeURIComponent(extractGitlabPath(project.gitlabRepo))
  const apiUrl = `${gitlabConfig.url.replace(/\/$/, '')}/api/v4/projects/${encodedRepo}/merge_requests`

  const body = {
    source_branch: iterationBranch,
    target_branch: sourceBranch,
    title: `e2e: auto-fix run #${runId}`,
    description: `由 Pipeline B (Test-and-Fix Loop) 自动创建。\n\nRun ID: ${runId}\n源分支: ${sourceBranch}\n迭代分支: ${iterationBranch}`,
    remove_source_branch: false,
  }

  let mrUrl: string | null = null
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'PRIVATE-TOKEN': gitlabConfig.token,
    }

    const fetchFn: typeof fetch = globalThis.fetch
    const response = await fetchFn(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (response.ok) {
      const data = (await response.json()) as { web_url?: string }
      mrUrl = data.web_url ?? null
      console.log(`[PipelineB:createSummaryMr] runId=${runId} MR created: ${mrUrl}`)
    } else {
      const text = await response.text()
      console.warn(`[PipelineB:createSummaryMr] GitLab API ${response.status}: ${text.slice(0, 300)}`)
    }
  } catch (err) {
    console.warn(`[PipelineB:createSummaryMr] fetch failed: ${err}`)
  }

  await updateE2eRunStatus(runId, 'passed', {
    finishedAt: new Date(),
    summaryMrUrl: mrUrl ?? undefined,
  })

  if (state.imContext) {
    notifyRunPassed(
      { adapter: state.imContext.adapter, groupId: state.imContext.groupId, runId },
      fixedCount,
      mrUrl,
    ).catch(() => {})
  }

  return { summaryMrUrl: mrUrl }
}
