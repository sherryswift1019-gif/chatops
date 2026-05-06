// src/e2e/playbook-draft/commit-to-gitlab.ts
//
// AI 生成 playbook YAML approve 时，将其 commit 到 target project 并创 GitLab MR。
// 被 admin/routes/e2e-runs.ts approveDraft 路径 fire-and-forget 调用。
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { getE2eTargetProject, extractGitlabPath } from '../../db/repositories/e2e-target-projects.js'
import { ensureWorkspaceCloned, getWorkspacePaths } from '../workspace.js'
import { git, gitlabApi } from './git-helpers.js'

export interface CommitPlaybookResult {
  mrUrl: string | null
  committedPath: string
}

interface GitlabMrCreated {
  web_url: string
}

export async function commitPlaybookToGitlab(opts: {
  targetProjectId: string
  draftId: bigint
  yamlContent: string
  sourceBranch: string
  scenarioInput: string
}): Promise<CommitPlaybookResult> {
  const { targetProjectId, draftId, yamlContent, sourceBranch, scenarioInput } = opts

  // 1. 拿 GitLab url/token
  const { url: gitlabUrl, token } = await resolveGitlabConfig()
  if (!gitlabUrl || !token) {
    throw new Error('GitLab config missing url/token')
  }

  // 2. 拿 target project 信息
  const project = await getE2eTargetProject(targetProjectId)
  if (!project) {
    throw new Error(`E2E target project not found: ${targetProjectId}`)
  }

  // 3. 提取 GitLab repo path + apiBase
  const repoPath = extractGitlabPath(project.gitlabRepo)
  const apiBase = `${gitlabUrl.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(repoPath)}`

  // 4. 确保 workspace clone 最新
  await ensureWorkspaceCloned(project, sourceBranch)

  // 5. 获取 containerPath
  const { containerPath } = getWorkspacePaths(targetProjectId)

  // 6. 确定分支名和文件路径
  const branch = `e2e-playbook/draft-${draftId}-${Date.now()}`
  const committedPath = `docs/test-playbooks/draft-${draftId}.playbook.yaml`
  const absPath = join(containerPath, committedPath)

  // 7. 写 YAML 到 workspace
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, yamlContent, 'utf8')

  // 8. git checkout -b
  const checkoutResult = git(['checkout', '-b', branch], containerPath)
  if (checkoutResult.status !== 0) {
    throw new Error(`git checkout -b failed: ${checkoutResult.stderr}`)
  }

  // 9. git add
  const addResult = git(['add', committedPath], containerPath)
  if (addResult.status !== 0) {
    throw new Error(`git add failed: ${addResult.stderr}`)
  }

  // 10. git commit
  const title = `feat(e2e-playbook): AI 生成 — ${scenarioInput.slice(0, 60)}`
  const commitResult = git(['commit', '-m', title], containerPath)
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr}`)
  }

  // 11. git push（用 http.extraheader 注入 PRIVATE-TOKEN，无需配置 git credential）
  const pushResult = git(
    ['-c', `http.extraheader=PRIVATE-TOKEN: ${token}`, 'push', 'origin', branch],
    containerPath,
  )
  if (pushResult.status !== 0) {
    throw new Error(`git push failed: ${pushResult.stderr}`)
  }

  // 12. POST merge_requests
  const description = `由 ChatOps E2E 自动生成（draft #${draftId}）。\n\n场景描述：\n${scenarioInput}`
  const mrResp = await gitlabApi<GitlabMrCreated>(
    'POST',
    `${apiBase}/merge_requests`,
    token,
    {
      source_branch: branch,
      target_branch: sourceBranch,
      title,
      description,
      remove_source_branch: false,
    },
  )

  // 13. MR 创建失败 → warn 但仍返回（push 已成功）
  if (!mrResp.ok || !mrResp.data) {
    console.warn(`[commitPlaybookToGitlab] GitLab MR create failed ${mrResp.status}: ${mrResp.text.slice(0, 300)}`)
    return { mrUrl: null, committedPath }
  }

  // 14. MR 成功
  return { mrUrl: mrResp.data.web_url, committedPath }
}
