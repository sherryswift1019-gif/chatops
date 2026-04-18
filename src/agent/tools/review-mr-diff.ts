import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import axios from 'axios'

const reviewMrDiffTool: AgentTool = {
  name: 'review_mr_diff',
  description: '读取 GitLab Merge Request 的 diff 内容，用于代码审查。返回变更文件列表和各文件的 diff。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'GitLab 项目路径' },
      mrIid: { type: 'number', description: 'MR 的 IID（项目内编号）' },
    },
    required: ['projectPath', 'mrIid'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { projectPath, mrIid } = params as { projectPath: string; mrIid: number }

    const gitlabUrl = process.env.GITLAB_URL
    const gitlabToken = process.env.GITLAB_TOKEN
    if (!gitlabUrl || !gitlabToken) {
      return { success: false, output: '缺少 GITLAB_URL 或 GITLAB_TOKEN' }
    }

    const encodedPath = encodeURIComponent(projectPath)

    try {
      const [mrRes, changesRes] = await Promise.all([
        axios.get(`${gitlabUrl}/api/v4/projects/${encodedPath}/merge_requests/${mrIid}`, {
          headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000,
        }),
        axios.get(`${gitlabUrl}/api/v4/projects/${encodedPath}/merge_requests/${mrIid}/changes`, {
          headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000,
        }),
      ])

      const mr = mrRes.data
      const changes = changesRes.data.changes ?? []

      let output = `## MR !${mr.iid}: ${mr.title}\n\n`
      output += `**Source**: ${mr.source_branch} → **Target**: ${mr.target_branch}\n`
      output += `**Files changed**: ${changes.length}\n\n`

      for (const change of changes) {
        output += `### ${change.new_path}\n\`\`\`diff\n${change.diff}\n\`\`\`\n\n`
      }

      return {
        success: true,
        output,
        data: { iid: mr.iid, filesChanged: changes.length },
      }
    } catch (err) {
      return { success: false, output: `读取 MR diff 失败：${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

registerTool(reviewMrDiffTool)
export { reviewMrDiffTool }
