import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const runTestsTool: AgentTool = {
  name: 'run_tests',
  description: '在 worktree 内运行测试命令。返回 stdout/stderr 和退出码。',
  riskLevel: 'medium',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '测试命令（如 mvn test -pl pas-secret-task）' },
      timeout: { type: 'number', description: '超时时间（毫秒），默认 300000' },
    },
    required: ['command'],
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const { command, timeout } = params as { command: string; timeout?: number }
    const cwd = ctx.cwd
    if (!cwd) return { success: false, output: '未设置工作目录（cwd）' }

    const timeoutMs = timeout ?? 300_000

    try {
      const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs })
      return {
        success: true,
        output: `测试通过\n\nstdout:\n${stdout.slice(-2000)}\n\nstderr:\n${stderr.slice(-500)}`,
        data: { exitCode: 0 },
      }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number }
      return {
        success: false,
        output: `测试失败（exit ${e.code ?? 'unknown'}）\n\nstdout:\n${(e.stdout ?? '').slice(-2000)}\n\nstderr:\n${(e.stderr ?? '').slice(-500)}`,
        data: { exitCode: e.code ?? 1 },
      }
    }
  },
}

registerTool(runTestsTool)
export { runTestsTool }
