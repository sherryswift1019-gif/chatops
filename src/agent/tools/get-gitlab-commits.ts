import { registerTool } from './index.js'
import { getConfig } from '../../db/repositories/system-config.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import axios from 'axios'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

async function getGitLabConfig(): Promise<{ url: string; token: string }> {
  const cfg = await getConfig('gitlab')
  if (cfg) {
    const v = cfg.value as Record<string, string>
    return { url: v.url ?? '', token: v.token ?? '' }
  }
  return { url: process.env.GITLAB_URL ?? '', token: process.env.GITLAB_TOKEN ?? '' }
}

const getGitLabCommitsTool: AgentTool = {
  name: 'get_gitlab_commits',
  description: '获取 GitLab 项目的最近提交记录。可用于关联日志错误与代码变更。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '项目名称' },
      limit: { type: 'number', description: '提交数量，默认 10' },
      since: { type: 'string', description: 'ISO 日期，筛选此时间之后的提交' },
    },
    required: ['project'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project: projectName, limit = 10, since } = params as { project: string; limit?: number; since?: string }
    try {
      // 从 projects 表查 gitlabPath
      const projects = await listProjects()
      const projectRecord = projects.find(p => p.name === projectName || p.displayName === projectName)
      const gitlabPath = projectRecord?.gitlabPath || projectName

      const gitlab = await getGitLabConfig()
      if (!gitlab.url) return { success: false, output: 'GitLab URL 未配置。请在系统配置中设置。' }

      const encodedProject = encodeURIComponent(gitlabPath)
      const res = await axios.get(
        `${gitlab.url}/api/v4/projects/${encodedProject}/repository/commits`,
        {
          headers: { 'PRIVATE-TOKEN': gitlab.token },
          params: { per_page: limit, since },
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
