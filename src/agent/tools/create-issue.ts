import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import axios from 'axios'
import { resolveGitlabConfig } from '../../config/gitlab.js'

const createIssueTool: AgentTool = {
  name: 'create_issue',
  description: '在 GitLab 项目中创建 Issue。传入标题、描述、标签。返回 Issue 编号和 URL。',
  riskLevel: 'medium',
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { type: 'string', description: 'GitLab 项目路径（如 PAM/java-code/pas）' },
      title: { type: 'string', description: 'Issue 标题' },
      description: { type: 'string', description: 'Issue 描述（Markdown）' },
      labels: { type: 'string', description: '逗号分隔的标签（如 needs-analysis,level-l1）' },
    },
    required: ['projectPath', 'title'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { projectPath, title, description, labels } = params as {
      projectPath: string
      title: string
      description?: string
      labels?: string
    }

    const { url: gitlabUrl, token: gitlabToken } = await resolveGitlabConfig()
    if (!gitlabUrl || !gitlabToken) {
      return { success: false, output: '缺少 GitLab 配置（请在 admin UI 或 .env 中设置 URL 和 Token）' }
    }

    const encodedPath = encodeURIComponent(projectPath)

    try {
      const response = await axios.post(
        `${gitlabUrl}/api/v4/projects/${encodedPath}/issues`,
        { title, description: description ?? '', labels: labels ?? '' },
        {
          headers: { 'PRIVATE-TOKEN': gitlabToken },
          timeout: 30_000,
        }
      )

      const issue = response.data
      return {
        success: true,
        output: `Issue #${issue.iid} 已创建：${issue.web_url}`,
        data: { iid: issue.iid, url: issue.web_url, id: issue.id },
      }
    } catch (err) {
      return { success: false, output: `创建 Issue 失败：${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

registerTool(createIssueTool)
export { createIssueTool }
