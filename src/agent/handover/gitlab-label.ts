/**
 * GitLab label 添加封装（handover 流程用）。
 * 复用环境变量 GITLAB_URL / GITLAB_TOKEN（与 gitlab-issue.ts 一致）。
 */
import axios from 'axios'

function getGitlabEnv(): { url: string; token: string } {
  const url = process.env.GITLAB_URL
  const token = process.env.GITLAB_TOKEN
  if (!url || !token) {
    throw new Error('缺少 GITLAB_URL 或 GITLAB_TOKEN 环境变量')
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
  const { url, token } = getGitlabEnv()
  await axios.put(
    `${url}/api/v4/projects/${encodeURIComponent(projectPath)}/issues/${issueIid}`,
    { add_labels: label },
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 15_000 },
  )
}
