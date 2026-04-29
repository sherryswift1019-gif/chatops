import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { sshExec } from '../../pipeline/ssh.js'
import { getTestServerByHost } from '../../db/repositories/test-servers.js'

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 1_800_000
const MIN_TIMEOUT_MS = 1_000

function clampTimeout(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < MIN_TIMEOUT_MS) {
    return DEFAULT_TIMEOUT_MS
  }
  if (input > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS
  return input
}

const runRemoteCommandTool: AgentTool = {
  name: 'run_remote_command',
  description:
    '通过 SSH 在远端 server 执行 shell 命令。用于诊断失败、修改文件、重启服务、重试失败命令。host 必须是 chatops 已注册的 test_servers 中的服务器（按 host 字段匹配）。',
  riskLevel: 'high',
  inputSchema: {
    type: 'object',
    properties: {
      host: { type: 'string', description: '目标服务器 IP/域名（必须在 test_servers 表里）' },
      command: { type: 'string', description: 'shell 命令，可多行，会原样传给 ssh' },
      timeoutMs: { type: 'number', description: '执行超时（默认 300000=5min，最大 1800000=30min）' },
    },
    required: ['host', 'command'],
  },

  async execute(params: unknown, _ctx: TaskContext): Promise<ToolResult> {
    const { host, command, timeoutMs } = (params ?? {}) as {
      host?: string
      command?: string
      timeoutMs?: number
    }

    if (!host || typeof host !== 'string') {
      return { success: false, output: 'host is required', data: { exitCode: -1 } }
    }
    if (!command || typeof command !== 'string') {
      return { success: false, output: 'command is required', data: { exitCode: -1 } }
    }

    const effectiveTimeout = clampTimeout(timeoutMs)

    const server = await getTestServerByHost(host)
    if (!server) {
      return {
        success: false,
        output: `host "${host}" is not registered in test_servers; ask an admin to register it first`,
        data: { exitCode: -1 },
      }
    }

    try {
      const { stdout, stderr, code } = await sshExec(
        {
          host: server.host,
          port: server.port,
          username: server.username,
          password: server.credential,
        },
        command,
        effectiveTimeout,
      )

      const out = `exit ${code}\nstdout:\n${stdout.slice(-2000)}\nstderr:\n${stderr.slice(-500)}`
      return {
        success: code === 0,
        output: out,
        data: { exitCode: code, stdout: stdout.slice(-2000), stderr: stderr.slice(-500) },
      }
    } catch (err: unknown) {
      // 不要把 server.credential / password 透出。Error.message 由 ssh2 / sshExec 产生，
      // 它本身不会包含密码（仅 host/port/timeout/握手阶段错误），但我们再做一次防御：
      // 若 message 不知何故包含凭据子串，统一替换。
      const raw = err instanceof Error ? err.message : String(err)
      const safe = raw.split(server.credential).join('***')
      return {
        success: false,
        output: `SSH error: ${safe}`,
        data: { exitCode: -1 },
      }
    }
  },
}

registerTool(runRemoteCommandTool)
export { runRemoteCommandTool }
