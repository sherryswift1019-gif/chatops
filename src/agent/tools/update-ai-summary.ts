import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, normalize, join, dirname } from 'path'

const updateAiSummaryTool: AgentTool = {
  name: 'update_ai_summary',
  description: '更新 worktree 中模块的 AI 摘要文档。在 docs/ai/{module}.md 中追加变更说明。',
  riskLevel: 'medium',
  inputSchema: {
    type: 'object',
    properties: {
      module: { type: 'string', description: '模块名（如 pas-secret-task）' },
      changesDescription: { type: 'string', description: '变更描述（将追加到摘要末尾）' },
    },
    required: ['module', 'changesDescription'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { module: moduleName, changesDescription } = params as { module: string; changesDescription: string }
    const cwd = ctx.cwd
    if (!cwd) return { success: false, output: '未设置工作目录（cwd）' }

    const summaryPath = resolve(cwd, 'docs', 'ai', `${moduleName}.md`)
    if (!summaryPath.startsWith(normalize(cwd))) {
      return { success: false, output: '路径越界' }
    }

    try {
      let content = ''
      if (existsSync(summaryPath)) {
        content = readFileSync(summaryPath, 'utf8')
      } else {
        mkdirSync(dirname(summaryPath), { recursive: true })
        content = `# ${moduleName} AI 摘要\n\n> 自动生成，请勿手动编辑核心内容。\n\n`
      }

      const timestamp = new Date().toISOString().split('T')[0]
      content += `\n## 变更记录 (${timestamp})\n\n${changesDescription}\n`
      writeFileSync(summaryPath, content, 'utf8')

      return { success: true, output: `AI 摘要已更新：docs/ai/${moduleName}.md` }
    } catch (err) {
      return { success: false, output: `更新摘要失败：${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

registerTool(updateAiSummaryTool)
export { updateAiSummaryTool }
