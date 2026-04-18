/**
 * GitLab Merge Request API 封装（便于单元测试 mock）。
 * 仅供 mr-handler.ts 使用。
 */
import axios from 'axios'

export interface CreateMrInput {
  projectPath: string
  sourceBranch: string
  targetBranch: string
  title: string
  description: string
  labels?: string
}

export interface CreatedMr {
  iid: number
  url: string
}

function getGitlabEnv(): { url: string; token: string } {
  const url = process.env.GITLAB_URL
  const token = process.env.GITLAB_TOKEN
  if (!url || !token) {
    throw new Error('缺少 GITLAB_URL 或 GITLAB_TOKEN 环境变量')
  }
  return { url, token }
}

/** 创建 GitLab Merge Request。失败抛错（由调用方决定是否落 DB）。 */
export async function gitlabCreateMr(input: CreateMrInput): Promise<CreatedMr> {
  const { url, token } = getGitlabEnv()
  const response = await axios.post(
    `${url}/api/v4/projects/${encodeURIComponent(input.projectPath)}/merge_requests`,
    {
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title: input.title,
      description: input.description,
      labels: input.labels ?? 'ai-generated',
      remove_source_branch: false,
    },
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 30_000 },
  )
  const mr = response.data
  return { iid: mr.iid as number, url: mr.web_url as string }
}
