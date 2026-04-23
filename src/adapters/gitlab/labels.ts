import axios from 'axios'
import { resolveGitlabConfig } from '../../config/gitlab.js'

/** 更新 GitLab Issue 的标签（添加/移除） */
export async function updateIssueLabels(
  projectPath: string,
  issueIid: number,
  labels: { add?: string[]; remove?: string[] }
): Promise<void> {
  const { url: gitlabUrl, token: gitlabToken } = await resolveGitlabConfig()
  if (!gitlabUrl || !gitlabToken) return

  await axios.put(
    `${gitlabUrl}/api/v4/projects/${encodeURIComponent(projectPath)}/issues/${issueIid}`,
    {
      add_labels: labels.add?.join(',') ?? '',
      remove_labels: labels.remove?.join(',') ?? '',
    },
    { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 15_000 }
  )
  console.log(`[GitLab] Issue #${issueIid} labels: +[${labels.add?.join(',')}] -[${labels.remove?.join(',')}]`)
}

/** 更新 GitLab MR 的标签 */
export async function updateMrLabels(
  projectPath: string,
  mrIid: number,
  labels: { add?: string[]; remove?: string[] }
): Promise<void> {
  const { url: gitlabUrl, token: gitlabToken } = await resolveGitlabConfig()
  if (!gitlabUrl || !gitlabToken) return

  await axios.put(
    `${gitlabUrl}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${mrIid}`,
    {
      add_labels: labels.add?.join(',') ?? '',
      remove_labels: labels.remove?.join(',') ?? '',
    },
    { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 15_000 }
  )
  console.log(`[GitLab] MR !${mrIid} labels: +[${labels.add?.join(',')}] -[${labels.remove?.join(',')}]`)
}
