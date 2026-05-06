// src/e2e/pipeline-a/nodes/commit-pr.ts
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { updateE2eSpecStatus } from '../../../db/repositories/e2e-specs.js'
import { getE2eTargetProject, extractGitlabPath } from '../../../db/repositories/e2e-target-projects.js'
import { getWorkspacePaths } from './baseline-sandbox.js'
import { git, gitlabApi } from '../../playbook-draft/git-helpers.js'
import type { PipelineAStateType } from '../types.js'

interface GitlabMr {
  iid: number
  web_url: string
  detailed_merge_status?: string
  pipeline?: { status?: string } | null
  head_pipeline?: { status?: string } | null
}

export async function commitAndPrNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const spec = state.specs[state.currentSpecIndex]
  if (!spec) {
    return {}
  }

  if (!spec.scriptPath || !spec.generatedContent) {
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  const { url: gitlabUrl, token } = await resolveGitlabConfig()
  if (!gitlabUrl || !token) {
    console.error('[PipelineA:commitPr] GitLab config 缺失（url/token）')
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }
  const project = await getE2eTargetProject(spec.targetProjectId)
  if (!project) {
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }
  const repoPath = extractGitlabPath(project.gitlabRepo)
  const apiBase = `${gitlabUrl.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(repoPath)}`

  const { containerPath } = getWorkspacePaths(spec.targetProjectId)

  // 写测试文件到 workspace（target project 克隆目录）
  const testFilePath = join(containerPath, spec.scriptPath)
  mkdirSync(dirname(testFilePath), { recursive: true })
  writeFileSync(testFilePath, spec.generatedContent, 'utf8')

  // git checkout -b 创建分支
  const branchName = `e2e-playbook/${spec.specId}-${Date.now()}`
  const checkoutResult = git(['checkout', '-b', branchName], containerPath)
  if (checkoutResult.status !== 0) {
    console.error(`[PipelineA:commitPr] checkout failed: ${checkoutResult.stderr}`)
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // git add
  const addResult = git(['add', spec.scriptPath], containerPath)
  if (addResult.status !== 0) {
    console.error(`[PipelineA:commitPr] add failed: ${addResult.stderr}`)
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // git commit
  const commitResult = git(['commit', '-m', `feat(e2e-playbook): 自动生成 playbook — ${spec.title}`], containerPath)
  if (commitResult.status !== 0) {
    console.error(`[PipelineA:commitPr] commit failed: ${commitResult.stderr}`)
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // git push（用 http.extraheader 注入 PRIVATE-TOKEN，无需配置 git credential）
  const pushResult = git(
    ['-c', `http.extraheader=PRIVATE-TOKEN: ${token}`, 'push', 'origin', branchName],
    containerPath,
  )
  if (pushResult.status !== 0) {
    console.error(`[PipelineA:commitPr] push failed: ${pushResult.stderr}`)
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  // GitLab REST API 创 MR（替代 glab CLI，base image 没装 glab）
  const createMrResp = await gitlabApi<GitlabMr>(
    'POST',
    `${apiBase}/merge_requests`,
    token,
    {
      source_branch: branchName,
      target_branch: state.baseBranch,
      title: `feat(e2e-playbook): 自动生成 playbook — ${spec.title}`,
      description: '由 Pipeline A 自动生成 playbook YAML，已过 baseline self-correct 验证',
      remove_source_branch: false,
    },
  )

  if (!createMrResp.ok || !createMrResp.data) {
    console.error(`[PipelineA:commitPr] GitLab MR create failed ${createMrResp.status}: ${createMrResp.text.slice(0, 300)}`)
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  const prUrl = createMrResp.data.web_url
  const mrIid = createMrResp.data.iid

  await updateE2eSpecStatus(spec.specId, 'pr_open', {
    generatedPrUrl: prUrl,
    generatedArtifactPath: spec.scriptPath,
    lastGeneratedAt: new Date(),
  })

  // 异步启动 auto merge（不阻塞主流程）
  void autoMergePr(apiBase, mrIid, spec.specId, token)

  return {
    completedSpecs: [{ specId: spec.specId, status: 'pr_open', prUrl }],
    baselineAttempts: 0,
    staticCheckAttempts: 0,
    sandboxHandle: null,
  }
}

async function autoMergePr(apiBase: string, mrIid: number, specId: bigint, token: string): Promise<void> {
  let ciPassed = false
  const maxAttempts = 60 // 30 min with 30s interval
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 30_000))

    const viewResp = await gitlabApi<GitlabMr>('GET', `${apiBase}/merge_requests/${mrIid}`, token)
    if (!viewResp.ok || !viewResp.data) {
      console.warn(`[PipelineA:autoMerge] mr view ${mrIid} failed (attempt ${i + 1}): ${viewResp.status}`)
      continue
    }

    const mr = viewResp.data
    const pipelineStatus = mr.head_pipeline?.status ?? mr.pipeline?.status
    if (mr.detailed_merge_status === 'mergeable' || pipelineStatus === 'success') {
      ciPassed = true
      break
    }
    if (pipelineStatus === 'failed') {
      console.warn(`[PipelineA:autoMerge] CI failed for MR ${mrIid}`)
      break
    }
  }

  if (!ciPassed) {
    console.warn(`[PipelineA:autoMerge] CI timed out for MR ${mrIid}`)
    return
  }

  // CI passed, merge the MR
  const mergeResp = await gitlabApi<GitlabMr>(
    'PUT',
    `${apiBase}/merge_requests/${mrIid}/merge`,
    token,
    { squash: true, should_remove_source_branch: true },
  )
  if (mergeResp.ok) {
    await updateE2eSpecStatus(specId, 'committed')
    console.log(`[PipelineA:autoMerge] successfully merged MR ${mrIid} for spec ${specId}`)
  } else {
    console.warn(`[PipelineA:autoMerge] failed to merge MR ${mrIid}: ${mergeResp.status} ${mergeResp.text.slice(0, 200)}`)
  }
}
