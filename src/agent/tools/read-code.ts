import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { readFileSync, existsSync } from 'fs'
import { resolve, relative, isAbsolute } from 'path'

const readCodeTool: AgentTool = {
  name: 'read_code',
  description: '读取 worktree 内的代码文件。传入相对于 worktree 根目录的文件路径。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于 worktree 根目录的文件路径' },
    },
    required: ['path'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { path: filePath } = params as { path: string }
    const cwd = ctx.cwd
    if (!cwd) {
      return { success: false, output: '未设置工作目录（cwd），无法读取文件' }
    }

    const absPath = resolve(cwd, filePath)
    const rel = relative(cwd, absPath)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { success: false, output: `路径越界：${filePath} 不在 worktree 范围内` }
    }

    if (!existsSync(absPath)) {
      return { success: false, output: `文件不存在：${filePath}` }
    }

    try {
      const content = readFileSync(absPath, 'utf8')
      return { success: true, output: content }
    } catch (err) {
      return { success: false, output: `读取失败：${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

registerTool(readCodeTool)
export { readCodeTool }
