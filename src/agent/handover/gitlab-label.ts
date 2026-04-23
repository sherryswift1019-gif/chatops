/**
 * GitLab label 添加封装（handover 流程用）。
 * 读配置走 resolveGitlabConfig（DB 优先，env 回退）。
 */
import axios from 'axios'
import { resolveGitlabConfig } from '../../config/gitlab.js'

async function getGitlabEnv(): Promise<{ url: string; token: string }> {
  const { url, token } = await resolveGitlabConfig()
  if (!url || !token) {
    throw new Error('缺少 GitLab url 或 token 配置（system_config.gitlab / GITLAB_URL / GITLAB_TOKEN）')
  }
  return { url, token }
}

/**
 * 给 GitLab Issue 追加 label（不替换现有 label，用 add_labels 增量添加）。
 * 失败抛错，由调用方决定是否降级（handover 里通常 catch 后记告警日志，不中断主流程）。
 */
export async function gitlabAddIssueLabel(
  projectPath: string,
  issueIid: number,
  label: string,
): Promise<void> {
  const { url, token } = await getGitlabEnv()
  await axios.put(
    `${url}/api/v4/projects/${encodeURIComponent(projectPath)}/issues/${issueIid}`,
    { add_labels: label },
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 15_000 },
  )
}
