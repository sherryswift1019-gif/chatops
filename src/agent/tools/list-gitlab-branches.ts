import { registerTool } from './index.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { findProjectByName } from './ssh-utils.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'
import axios from 'axios'
import https from 'https'
import { appendFileSync } from 'fs'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

function toolLog(msg: string) {
  try { appendFileSync('/tmp/mcp-server.log', `[${new Date().toISOString()}] [list_gitlab_branches] ${msg}\n`) } catch { /* */ }
}

export async function listProjectBranches(gitlabPath: string): Promise<string[]> {
  const gitlab = await resolveGitlabConfig()
  if (!gitlab.url || !gitlab.token) return []
  const encodedProject = encodeURIComponent(gitlabPath)
  const agent = gitlab.skipTlsVerify ? new https.Agent({ rejectUnauthorized: false }) : undefined
  try {
    const res = await axios.get<Array<{ name: string }>>(
      `${gitlab.url}/api/v4/projects/${encodedProject}/repository/branches`,
      {
        headers: { 'PRIVATE-TOKEN': gitlab.token },
        httpsAgent: agent,
        timeout: 10000,
        params: { per_page: 100 },
      },
    )
    return res.data.map(b => b.name)
  } catch (err) {
    toolLog(`listProjectBranches ERROR for ${gitlabPath}: ${String(err)}`)
    return []
  }
}

export const listGitlabBranchesTool: AgentTool = {
  name: 'list_gitlab_branches',
  description: '列出某模块在 GitLab 上所有可用的分支。用户问"有哪些分支",或部署前需要核对分支名时调用。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project/module name (will be matched against registered projects)' },
    },
    required: ['project'],
  },
  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { project } = params as { project: string }

    let allProjects: Awaited<ReturnType<typeof listProjects>> = []
    try {
      allProjects = await listProjects()
    } catch (err) {
      return { success: false, output: `数据库查询模块失败: ${String(err)}` }
    }

    const projectRecord = findProjectByName(allProjects, project)
    if (!projectRecord) {
      const names = allProjects.length > 0
        ? allProjects.map(p => p.name).join(', ')
        : '无（数据库中没有模块）'
      return {
        success: false,
        output: `模块 "${project}" 在数据库中未找到匹配。\n已注册模块: [${names}]\n请确认模块名称是否正确。`,
      }
    }

    if (!projectRecord.gitlabPath) {
      return {
        success: false,
        output: `模块 "${projectRecord.name}" 未配置 GitLab 路径。请在管理后台的模块配置中设置 GitLab 项目路径。`,
      }
    }

    const branches = await listProjectBranches(projectRecord.gitlabPath)
    if (branches.length === 0) {
      return {
        success: true,
        output: `模块 ${projectRecord.name} (${projectRecord.gitlabPath}) 没有查到分支，或 GitLab 未配置。`,
        data: { project: projectRecord.name, gitlabPath: projectRecord.gitlabPath, branches: [] },
      }
    }

    return {
      success: true,
      output: `模块 ${projectRecord.name} (${projectRecord.gitlabPath}) 可用分支（共 ${branches.length} 个）:\n${branches.map(b => `- ${b}`).join('\n')}`,
      data: { project: projectRecord.name, gitlabPath: projectRecord.gitlabPath, branches },
    }
  },
}

registerTool(listGitlabBranchesTool)
