import { registerCapabilityHandler } from '../coordinator.js'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { createPorygon } from '@snack-kit/porygon'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { buildClaudeEnv } from '../claude-config.js'

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
1. 使用可用的 SSH 工具连入 ${serverHost} 诊断根因
2. 施以修复（清残留文件 / 停冲突进程 / 修复依赖等）
3. 重新执行上述命令，检查退出码
4. 若仍失败则再次分析修复，最多重试 ${maxRetries} 次
5. 最终以 JSON 格式返回：{"success": true/false, "attempts": N, "summary": "修复摘要"}`
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

  const maxRetries = params.maxRetries ?? 4

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

  try {
    // porygon timeoutMs 是 idle timeout（无输出则超时），非 wall-clock 总时长
    const result = await porygon.run({
      prompt: buildDiagnosePrompt(params),
      timeoutMs: (maxRetries + 1) * 5 * 60_000,
      disallowedTools: ['Edit', 'Write', 'Glob', 'Grep', 'Read'],
      envVars: await buildClaudeEnv(),
    })
    return { success: true, output: result.trim() }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

registerCapabilityHandler('diagnose_and_repair', handleDiagnoseAndRepair)
