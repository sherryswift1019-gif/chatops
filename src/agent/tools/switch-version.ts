import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const switchVersionTool: AgentTool = {
  name: 'switch_version',
  description: '在当前 worktree 中切换到指定的 Git 分支或标签。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: '目标分支名或标签（如 develop、v6.7.0）' },
    },
    required: ['branch'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { branch } = params as { branch: string }
    const cwd = ctx.cwd
    if (!cwd) {
      return { success: false, output: '未设置工作目录（cwd）' }
    }

    try {
      await execFileAsync('git', ['checkout', branch], { cwd, timeout: 60_000 })
      const { stdout } = await execFileAsync('git', ['log', '--oneline', '-1'], { cwd })
      return { success: true, output: `已切换到 ${branch}，最新 commit: ${stdout.trim()}` }
    } catch (err) {
      return { success: false, output: `切换失败：${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

registerTool(switchVersionTool)
export { switchVersionTool }
