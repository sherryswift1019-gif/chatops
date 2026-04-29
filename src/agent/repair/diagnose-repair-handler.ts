import { registerCapabilityHandler } from '../coordinator.js'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { createPorygon } from '@snack-kit/porygon'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { appendFile, mkdir } from 'node:fs/promises'
import { buildClaudeEnv } from '../claude-config.js'
import { resolveDataDir } from '../../pipeline/data-dir.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface DiagnoseParams {
  failedCommand: string
  stdout: string
  stderr: string
  serverHost: string
  maxRetries?: number
}

export function buildDiagnosePrompt(params: DiagnoseParams): string {
  const { failedCommand, stdout, stderr, serverHost, maxRetries = 4 } = params
  return `你是一个 DevOps 故障修复专家。以下命令在服务器 ${serverHost} 上执行失败，请分析原因并施以修复，然后重新执行该命令，最多重试 ${maxRetries} 次。

## 失败的命令
\`\`\`
${failedCommand}
\`\`\`

## 标准输出（stdout）
\`\`\`
${stdout || '（空）'}
\`\`\`

## 错误输出（stderr）
\`\`\`
${stderr || '（空）'}
\`\`\`

## 执行要求
1. 通过 run_remote_command 在 ${serverHost} 上诊断根因（例：\`run_remote_command(host: "${serverHost}", command: "ls -la /opt/foo && systemctl status bar")\`）；查询产线/服务整体状态用 check_environment_status，查产线日志用 get_logs
2. 施以修复（清残留文件 / 停冲突进程 / 修复依赖等），同样通过 run_remote_command 执行写操作
3. 重新执行上述命令（用 run_remote_command），检查退出码
4. 若仍失败则再次分析修复，最多重试 ${maxRetries} 次
5. 最终以 JSON 格式返回：{"success": true/false, "attempts": N, "summary": "修复摘要"}`
}

const TASK_ID_RE = /^pipeline-(\d+)-stage-(\d+)$/

/**
 * 把 capability taskId 解析为 (runId, stageIndex)。
 * pipeline executor 拼成 `pipeline-<runId>-stage-<stageIndex>`，其它 caller
 * （如 dry-run / Agent 内嵌）走别的格式 → 返回 null，调用方退化为只 console.log。
 */
function resolveLogPath(taskId: string): string | null {
  const m = TASK_ID_RE.exec(taskId)
  if (!m) return null
  const runId = m[1]
  const stageIdx = Number(m[2])
  const dataDir = resolveDataDir()
  const fileName = `${String(stageIdx + 1).padStart(2, '0')}-capability.log`
  return join(dataDir, runId, fileName)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…[truncated, total=${s.length}]`
}

/**
 * 把一条 AgentMessage 序列化为单行人类可读 log。
 * 返回 null 表示该类型不需要落盘（如 stream_chunk 与 assistant 重复）。
 */
function formatMessage(msg: any): string | null {
  const ts = new Date(typeof msg?.timestamp === 'number' ? msg.timestamp : Date.now()).toISOString()
  const type = String(msg?.type ?? 'unknown')
  switch (type) {
    case 'stream_chunk':
      // chunked 模式下 stream_chunk 内容会在 assistant.text 里完整重复，跳过避免重复噪音
      return null
    case 'assistant': {
      const text = typeof msg.text === 'string' ? msg.text : ''
      return `[${ts}] [assistant] ${truncate(text.replace(/\r?\n/g, '\\n'), 2000)}\n`
    }
    case 'tool_use': {
      const toolName = String(msg.toolName ?? '?')
      let input = ''
      try {
        input = JSON.stringify(msg.input ?? {})
      } catch {
        input = '<unserializable>'
      }
      let line = `[${ts}] [tool_use] ${toolName} input=${truncate(input, 1000)}`
      if (typeof msg.output === 'string' && msg.output.length > 0) {
        line += ` output=${truncate(msg.output.replace(/\r?\n/g, '\\n'), 1000)}`
      }
      return `${line}\n`
    }
    case 'result': {
      const text = typeof msg.text === 'string' ? msg.text : ''
      return `[${ts}] [result] ${truncate(text.replace(/\r?\n/g, '\\n'), 4000)}\n`
    }
    case 'error': {
      const message = typeof msg.message === 'string' ? msg.message : ''
      const code = typeof msg.code === 'string' ? ` code=${msg.code}` : ''
      return `[${ts}] [error] ${truncate(message, 2000)}${code}\n`
    }
    case 'system': {
      const model = typeof msg.model === 'string' ? ` model=${msg.model}` : ''
      return `[${ts}] [system]${model}\n`
    }
    default:
      return `[${ts}] [${type}]\n`
  }
}

async function handleDiagnoseAndRepair(opts: TriggerOptions): Promise<TriggerResult> {
  const p = (opts.extraParams ?? {}) as Partial<DiagnoseParams>
  const params: DiagnoseParams = {
    failedCommand: String(p.failedCommand ?? ''),
    stdout: String(p.stdout ?? ''),
    stderr: String(p.stderr ?? ''),
    serverHost: String(p.serverHost ?? ''),
    maxRetries: typeof p.maxRetries === 'number' ? p.maxRetries : 4,
  }

  if (!params.failedCommand || !params.serverHost) {
    return { success: false, error: 'diagnose_and_repair: failedCommand 和 serverHost 必填' }
  }

  const mcpServerPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'mcp-server.ts')

  const porygon = createPorygon({
    defaultBackend: 'claude',
    backends: {
      claude: {
        model: 'sonnet',
        interactive: false,
        cliPath: join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'claude'),
      },
    },
    defaults: { maxTurns: 30 },
  })

  // 解析 log 路径；非 pipeline 调用方（taskId 不匹配）只走 console.log，不落盘
  const logPath = resolveLogPath(opts.context.taskId ?? '')
  let logDirEnsured = false

  async function writeLogLine(line: string): Promise<void> {
    if (!logPath) return
    try {
      if (!logDirEnsured) {
        await mkdir(dirname(logPath), { recursive: true })
        logDirEnsured = true
      }
      // appendFile 每次是独立 syscall，写完即落盘 → 即时可被 tail -f 看到
      await appendFile(logPath, line)
    } catch (err) {
      // 落盘失败不阻塞主流程，仅 console.error 留痕
      console.error('[diagnose_and_repair] failed to append log:', err)
    }
  }

  let finalText: string | null = null
  let lastAssistantText = ''
  let errorMessage: string | null = null

  try {
    const claudeEnv = await buildClaudeEnv()
    const request = {
      prompt: buildDiagnosePrompt(params),
      timeoutMs: ((params.maxRetries ?? 4) + 1) * 5 * 60_000,
      mcpServers: {
        'chatops-tools': {
          command: 'node',
          args: ['--import', 'tsx/esm', mcpServerPath],
          env: {
            ...(process.env as Record<string, string>),
            CHATOPS_TASK_CONTEXT: JSON.stringify(opts.context),
            CHATOPS_ALLOWED_TOOLS: 'check_environment_status,get_logs,run_remote_command',
            DATABASE_URL: process.env.DATABASE_URL ?? '',
            ...claudeEnv,
          },
        },
      },
      disallowedTools: ['Bash', 'Edit', 'Write', 'Glob', 'Grep', 'Read', 'WebSearch', 'WebFetch'],
      envVars: claudeEnv,
    }

    for await (const msg of porygon.query(request as any)) {
      const m = msg as any
      const line = formatMessage(m)
      if (line) {
        console.log(`[diagnose_and_repair] ${line.trimEnd()}`)
        await writeLogLine(line)
      }

      switch (m?.type) {
        case 'assistant':
          if (typeof m.text === 'string' && m.text.length > 0) {
            lastAssistantText = m.text
          }
          break
        case 'result':
          finalText = typeof m.text === 'string' ? m.text : lastAssistantText
          break
        case 'error':
          errorMessage = typeof m.message === 'string' ? m.message : 'agent error'
          break
      }

      // 收到终态消息立即 break，不再消费后续——LLM 已经给出最终结论
      if (finalText !== null || errorMessage !== null) break
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  if (errorMessage !== null) {
    return { success: false, error: errorMessage }
  }

  // 没收到 'result' 消息（有些 backend 不发）→ fallback 用最后一条 assistant 文本
  const output = (finalText ?? lastAssistantText ?? '').trim()
  return { success: true, output }
}

registerCapabilityHandler('diagnose_and_repair', handleDiagnoseAndRepair)
