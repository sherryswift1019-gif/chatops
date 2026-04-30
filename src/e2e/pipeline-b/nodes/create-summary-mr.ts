// src/e2e/pipeline-b/nodes/create-summary-mr.ts
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import type { PipelineBStateType } from '../types.js'

export async function createSummaryMrNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { runId, iterationBranch, sourceBranch, targetProjectId } = state

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${targetProjectId}" not found`)

  const gitlabConfig = await resolveGitlabConfig()
  if (!gitlabConfig.url || !gitlabConfig.token) {
    console.warn(`[PipelineB:createSummaryMr] gitlab config incomplete, skipping MR creation`)
    await updateE2eRunStatus(runId, 'passed', { finishedAt: new Date() })
    return {}
  }

  const encodedRepo = encodeURIComponent(project.gitlabRepo)
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

  return { summaryMrUrl: mrUrl }
}
