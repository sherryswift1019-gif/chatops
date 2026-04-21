/**
 * GitLab MR API 封装（便于单元测试 mock）。
 * 供 mr-state-reconciler.ts 和未来需要查 MR 状态的调用方使用。
 *
 * 样式对齐现有 gitlab-issue.ts：统一经 resolveGitlabConfig（DB 优先 + env fallback）。
 */
import axios from 'axios'
import { resolveGitlabConfig } from '../../config/gitlab.js'

export type GitLabMrState = 'opened' | 'closed' | 'merged' | 'locked'

export interface GitLabMr {
  iid: number
  state: GitLabMrState
  merged_at: string | null
  merged_by: { username: string; name: string } | null
  closed_at: string | null
  closed_by: { username: string; name: string } | null
  web_url: string
}

async function getGitlabEnv(): Promise<{ url: string; token: string }> {
  const { url, token } = await resolveGitlabConfig()
  if (!url || !token) {
    throw new Error('缺少 GitLab 配置（请在 admin UI 或 .env 中设置 URL 和 Token）')
  }
  return { url, token }
}

/** 查单个 MR 的 state 和 merged_by / closed_by 信息（对账用）。失败抛错。 */
export async function gitlabGetMr(params: {
  projectPath: string
  mrIid: number
}): Promise<GitLabMr> {
  const { url, token } = await getGitlabEnv()
  const { data } = await axios.get<GitLabMr>(
    `${url}/api/v4/projects/${encodeURIComponent(params.projectPath)}/merge_requests/${params.mrIid}`,
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 15_000 },
  )
  return data
}
