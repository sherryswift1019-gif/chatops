/**
 * GitLab MR Note / Label API 封装（便于单元测试 mock）。
 * 仅供 reviewer.ts 使用。
 */
import axios from 'axios'

export interface PostMrNoteInput {
  projectPath: string
  mrIid: number
  body: string
}

export interface UpdateMrLabelsInput {
  projectPath: string
  mrIid: number
  labelToAdd: string
  labelsToRemove?: string[]
}

function getGitlabEnv(): { url: string; token: string } {
  const url = process.env.GITLAB_URL
  const token = process.env.GITLAB_TOKEN
  if (!url || !token) {
    throw new Error('缺少 GITLAB_URL 或 GITLAB_TOKEN 环境变量')
  }
  return { url, token }
}

/** 向 MR 追加一条评论（Note）。失败抛错。 */
export async function gitlabPostMrNote(input: PostMrNoteInput): Promise<void> {
  const { url, token } = getGitlabEnv()
  await axios.post(
    `${url}/api/v4/projects/${encodeURIComponent(input.projectPath)}/merge_requests/${input.mrIid}/notes`,
    { body: input.body },
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 15_000 },
  )
}

/** 为 MR 添加标签（同时移除冲突标签）。 */
export async function gitlabUpdateMrLabels(input: UpdateMrLabelsInput): Promise<void> {
  const { url, token } = getGitlabEnv()
  await axios.put(
    `${url}/api/v4/projects/${encodeURIComponent(input.projectPath)}/merge_requests/${input.mrIid}`,
    {
      add_labels: input.labelToAdd,
      remove_labels: (input.labelsToRemove ?? []).join(','),
    },
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 15_000 },
  )
}
