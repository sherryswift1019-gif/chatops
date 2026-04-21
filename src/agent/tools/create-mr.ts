import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import axios from 'axios'
import { resolveGitlabConfig } from '../../config/gitlab.js'

const createMrTool: AgentTool = {
  name: 'create_mr',
  description: '在 GitLab 项目中创建 Merge Request。返回 MR 编号和 URL。',
  riskLevel: 'high',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'GitLab 项目路径' },
      title: { type: 'string', description: 'MR 标题' },
      description: { type: 'string', description: 'MR 描述（Markdown）' },
      sourceBranch: { type: 'string', description: '源分支（如 fix/issue-234）' },
      targetBranch: { type: 'string', description: '目标分支（如 develop）' },
      labels: { type: 'string', description: '逗号分隔的标签' },
    },
    required: ['projectPath', 'title', 'sourceBranch', 'targetBranch'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { projectPath, title, description, sourceBranch, targetBranch, labels } = params as {
      projectPath: string; title: string; description?: string
      sourceBranch: string; targetBranch: string; labels?: string
    }

    const { url: gitlabUrl, token: gitlabToken } = await resolveGitlabConfig()
    if (!gitlabUrl || !gitlabToken) {
      return { success: false, output: '缺少 GitLab 配置（请在 admin UI 或 .env 中设置 URL 和 Token）' }
    }

    try {
      const response = await axios.post(
        `${gitlabUrl}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests`,
        {
          title,
          description: description ?? '',
          source_branch: sourceBranch,
          target_branch: targetBranch,
          labels: labels ?? '',
          remove_source_branch: false,
        },
        { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 30_000 }
      )

      const mr = response.data
      return {
        success: true,
        output: `MR !${mr.iid} 已创建：${mr.web_url}`,
        data: { iid: mr.iid, url: mr.web_url, id: mr.id },
      }
    } catch (err) {
      return { success: false, output: `创建 MR 失败：${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

registerTool(createMrTool)
export { createMrTool }
