import { registerTool } from './index.js'
import { config } from '../../config.js'
import axios from 'axios'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

const getGitLabCommitsTool: AgentTool = {
  name: 'get_gitlab_commits',
  description: 'Get recent commits for a GitLab project. Useful for correlating log errors with code changes.',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'GitLab project path, e.g. group/repo' },
      limit: { type: 'number', description: 'Number of commits, default 10' },
      since: { type: 'string', description: 'ISO date string to filter commits after this time' },
    },
    required: ['project'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project, limit = 10, since } = params as { project: string; limit?: number; since?: string }
    try {
      const encodedProject = encodeURIComponent(project)
      const res = await axios.get(
        `${config.GITLAB_URL}/api/v4/projects/${encodedProject}/repository/commits`,
        {
          headers: { 'PRIVATE-TOKEN': config.GITLAB_TOKEN },
          params: { per_page: limit, since },
        }
      )
      const commits = res.data as Array<{ short_id: string; title: string; author_name: string; created_at: string }>
      if (commits.length === 0) return { success: true, output: 'No commits found' }
      const lines = commits.map(c =>
        `- ${c.short_id} | ${c.created_at.slice(0, 16)} | ${c.author_name} | ${c.title}`
      )
      return { success: true, output: `Recent commits for ${project}:\n${lines.join('\n')}`, data: commits }
    } catch (err) {
      return { success: false, output: `Failed to fetch commits: ${String(err)}` }
    }
  },
}

registerTool(getGitLabCommitsTool)
export { getGitLabCommitsTool }
