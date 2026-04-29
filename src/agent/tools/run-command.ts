import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const runCommandTool: AgentTool = {
  name: 'run_command',
  description: '在工作区执行 shell 命令。配置了运行容器时自动路由进容器内执行。',
  riskLevel: 'medium',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'shell 命令（如 mvn test / pytest / go build）' },
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
      let stdout: string, stderr: string
      if (ctx.dockerContainerName) {
        const dockerCmd = `docker exec ${ctx.dockerContainerName} sh -c "cd ${cwd} && ${command}"`
        const r = await execAsync(dockerCmd, { timeout: timeoutMs })
        stdout = r.stdout; stderr = r.stderr
      } else {
        const r = await execAsync(command, { cwd, timeout: timeoutMs })
        stdout = r.stdout; stderr = r.stderr
      }
      return {
        success: true,
        output: `命令执行成功\n\nstdout:\n${stdout.slice(-2000)}\n\nstderr:\n${stderr.slice(-500)}`,
        data: { exitCode: 0 },
      }
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number }
      return {
        success: false,
        output: `命令失败（exit ${e.code ?? 'unknown'}）\n\nstdout:\n${(e.stdout ?? '').slice(-2000)}\n\nstderr:\n${(e.stderr ?? '').slice(-500)}`,
        data: { exitCode: e.code ?? 1 },
      }
    }
  },
}

registerTool(runCommandTool)
export { runCommandTool }
