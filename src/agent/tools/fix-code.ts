import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { writeFileSync, mkdirSync } from 'fs'
import { resolve, relative, isAbsolute, dirname } from 'path'

const fixCodeTool: AgentTool = {
  name: 'fix_code',
  description: '修改 worktree 内的代码文件。传入文件路径和新内容。',
  riskLevel: 'high',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对于 worktree 根目录的文件路径' },
      content: { type: 'string', description: '文件的完整新内容' },
    },
    required: ['path', 'content'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { path: filePath, content } = params as { path: string; content: string }
    const cwd = ctx.cwd
    if (!cwd) return { success: false, output: '未设置工作目录（cwd）' }

    const absPath = resolve(cwd, filePath)
    const rel = relative(cwd, absPath)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { success: false, output: `路径越界：${filePath}` }
    }

    try {
      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, content, 'utf8')
      return { success: true, output: `已写入 ${filePath}（${content.length} 字符）` }
    } catch (err) {
      return { success: false, output: `写入失败：${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

registerTool(fixCodeTool)
export { fixCodeTool }
