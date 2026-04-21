import { registerTool } from './index.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { findProjectByName } from './ssh-utils.js'
import axios from 'axios'
import https from 'https'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

const getGitLabCommitsTool: AgentTool = {
  name: 'get_gitlab_commits',
  description: '获取模块的 GitLab 最近提交记录。可用于关联日志错误与代码变更。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '模块名称' },
      limit: { type: 'number', description: '提交数量，默认 10' },
      since: { type: 'string', description: 'ISO 日期，筛选此时间之后的提交' },
    },
    required: ['project'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project: projectName, limit = 10, since } = params as { project: string; limit?: number; since?: string }
    try {
      const projects = await listProjects()
      const projectRecord = findProjectByName(projects, projectName)
      const gitlabPath = projectRecord?.gitlabPath || projectName

      const gitlab = await resolveGitlabConfig()
      if (!gitlab.url) return { success: false, output: 'GitLab URL 未配置。请在系统配置中设置。' }

      const httpsAgent = new https.Agent({
        rejectUnauthorized: !gitlab.skipTlsVerify,
      })

      const encodedProject = encodeURIComponent(gitlabPath)
      const res = await axios.get(
        `${gitlab.url}/api/v4/projects/${encodedProject}/repository/commits`,
        {
          headers: { 'PRIVATE-TOKEN': gitlab.token },
          params: { per_page: limit, since },
          httpsAgent,
        }
      )
      const commits = res.data as Array<{ short_id: string; title: string; author_name: string; created_at: string }>
      if (commits.length === 0) return { success: true, output: `${projectName} 没有找到提交记录` }
      const lines = commits.map(c =>
        `- ${c.short_id} | ${c.created_at.slice(0, 16)} | ${c.author_name} | ${c.title}`
      )
      return { success: true, output: `${projectName} 最近提交:\n${lines.join('\n')}`, data: commits }
    } catch (err) {
      return { success: false, output: `GitLab 提交记录获取失败: ${String(err)}` }
    }
  },
}

registerTool(getGitLabCommitsTool)
export { getGitLabCommitsTool }
