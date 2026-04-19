/**
 * GitLab Issue API 封装（便于单元测试 mock）。
 * 仅供 analyzer.ts 使用。
 */
import axios from 'axios'

export interface CreateIssueInput {
  projectPath: string
  title: string
  description: string
  labels?: string
}

export interface CreatedIssue {
  iid: number
  url: string
}

export interface PostIssueNoteInput {
  projectPath: string
  issueIid: number
  body: string
}

export interface PostedIssueNote {
  noteId: number
  issueUrl: string
}

function getGitlabEnv(): { url: string; token: string } {
  const url = process.env.GITLAB_URL
  const token = process.env.GITLAB_TOKEN
  if (!url || !token) {
    throw new Error('缺少 GITLAB_URL 或 GITLAB_TOKEN 环境变量')
  }
  return { url, token }
}

/** 创建 GitLab Issue。失败抛错（由调用方决定是否落 DB）。 */
export async function gitlabCreateIssue(input: CreateIssueInput): Promise<CreatedIssue> {
  const { url, token } = getGitlabEnv()
  const response = await axios.post(
    `${url}/api/v4/projects/${encodeURIComponent(input.projectPath)}/issues`,
    { title: input.title, description: input.description, labels: input.labels ?? '' },
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 15_000 },
  )
  const issue = response.data
  return { iid: issue.iid, url: issue.web_url }
}

/** 向现有 Issue 追加评论（用于 reuseIssueId 模式）。 */
export async function gitlabPostIssueNote(input: PostIssueNoteInput): Promise<PostedIssueNote> {
  const { url, token } = getGitlabEnv()
  const response = await axios.post(
    `${url}/api/v4/projects/${encodeURIComponent(input.projectPath)}/issues/${input.issueIid}/notes`,
    { body: input.body },
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 15_000 },
  )
  const issueUrl = `${url}/${input.projectPath}/-/issues/${input.issueIid}`
  return { noteId: response.data.id as number, issueUrl }
}

/** 读取现有 Issue 的 description。失败抛错，由调用方决定是否降级。 */
export async function gitlabGetIssue(
  projectPath: string,
  issueIid: number,
): Promise<{ description: string }> {
  const { url, token } = getGitlabEnv()
  const response = await axios.get(
    `${url}/api/v4/projects/${encodeURIComponent(projectPath)}/issues/${issueIid}`,
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 15_000 },
  )
  return { description: (response.data?.description as string | null) ?? '' }
}

/** PUT 更新现有 Issue 的 description（用于 reuseIssueId 场景同步 body banner）。 */
export async function gitlabUpdateIssue(
  projectPath: string,
  issueIid: number,
  payload: { description: string },
): Promise<void> {
  const { url, token } = getGitlabEnv()
  await axios.put(
    `${url}/api/v4/projects/${encodeURIComponent(projectPath)}/issues/${issueIid}`,
    { description: payload.description },
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 15_000 },
  )
}
