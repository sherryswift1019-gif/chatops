/**
 * Claude CLI / Porygon 两条调用路径的统一 Executor 抽象。
 *
 * 使用场景：analyze_bug / fix_bug_lN / ai_review_mr 需要在两种后端调用方式间切换，
 * 不影响业务代码结构。
 *
 * 选择规则：
 * - process.env.CLAUDE_EXECUTOR 显式指定为 'cli' 或 'porygon' → 按指定选择
 * - 未指定时：NODE_ENV=test → cli（避免单测触碰外网/依赖真 Claude 后端）；其他 → porygon
 * - 非法值（既不是 cli 也不是 porygon）→ 立即抛错，不静默 fallback
 */
import { createPorygon, type Porygon } from '@snack-kit/porygon'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runClaudeCli } from './claude-cli.js'
import { buildClaudeEnv } from './claude-config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export interface RunClaudeOpts {
  prompt: string
  /** 工具白名单（逗号分隔，如 'Read,Glob,Grep'）；未设时允许所有 Claude 内置工具 */
  allowedTools?: string
  /** 空闲超时 ms；Porygon 的默认是进程无输出超过此时间则终止，收到输出重置计时器 */
  timeoutMs?: number
  signal?: AbortSignal
  onEvent?: (e: { type: string; message: string; data?: Record<string, unknown> }) => void
  /** Claude 子进程工作目录；传值时 Glob/Grep/Read 以此为根（如 worktree.path）。未传时用默认 cwd。 */
  cwd?: string
}

export interface ClaudeExecutor {
  run(opts: RunClaudeOpts): Promise<string>
}

/** 直接 spawn `claude -p` 子进程的实现（原 runClaudeCli 路径） */
export class CliExecutor implements ClaudeExecutor {
  async run(opts: RunClaudeOpts): Promise<string> {
    return runClaudeCli({
      prompt: opts.prompt,
      allowedTools: opts.allowedTools,
      timeoutMs: opts.timeoutMs,
      onEvent: opts.onEvent,
      signal: opts.signal,
      cwd: opts.cwd,
    })
  }
}

/** @snack-kit/porygon 的实现：走 Agent SDK 协议，拿到 structured stream */
export class PorygonExecutor implements ClaudeExecutor {
  private porygon: Porygon | null = null

  private getPorygon(): Porygon {
    if (!this.porygon) {
      this.porygon = createPorygon({
        defaultBackend: 'claude',
        backends: {
          claude: {
            model: 'opus',  // 2026-04-21 从 sonnet 切 opus（深度推理优势，成本 ~5x）
            interactive: false,
            cliPath: join(__dirname, '..', '..', 'node_modules', '.bin', 'claude'),
          },
        },
        defaults: {
          timeoutMs: 20 * 60_000, // 20 分钟 idle（和 runClaudeCli 对齐）
          maxTurns: 30,
        },
      })
    }
    return this.porygon
  }

  async run(opts: RunClaudeOpts): Promise<string> {
    const onlyTools = opts.allowedTools
      ? opts.allowedTools.split(',').map(s => s.trim()).filter(Boolean)
      : undefined

    const claudeEnv = await buildClaudeEnv()

    let resultText = ''
    let assistantComplete = ''
    let toolCallCount = 0

    opts.onEvent?.({ type: 'init', message: 'Porygon query starting' })

    for await (const msg of this.getPorygon().query({
      prompt: opts.prompt,
      ...(onlyTools ? { onlyTools } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      envVars: claudeEnv,
    })) {
      switch (msg.type) {
        case 'tool_use':
          toolCallCount += 1
          opts.onEvent?.({
            type: 'tool_call',
            message: msg.toolName,
            data: { toolName: msg.toolName, count: toolCallCount },
          })
          break
        case 'assistant':
          // AgentAssistantMessage.turnComplete=true → text 已是累计完整；非 true 时可能是拆分
          // Claude adapter streamingMode='chunked' 场景：只在 turnComplete=true 时取 text
          if (msg.turnComplete && msg.text) assistantComplete = msg.text
          break
        case 'result':
          // Porygon 保证 result 是最后一条消息，text 是最终结果（优先用它）
          resultText = msg.text
          opts.onEvent?.({
            type: 'done',
            message: `耗时=${((msg.durationMs ?? 0) / 1000).toFixed(1)}s${
              msg.costUsd ? `, 费用=$${msg.costUsd.toFixed(4)}` : ''
            }`,
            data: {
              durationMs: msg.durationMs,
              costUsd: msg.costUsd,
              inputTokens: msg.inputTokens,
              outputTokens: msg.outputTokens,
            },
          })
          break
        case 'error':
          throw new Error(`Porygon error: ${msg.message}`)
      }
    }

    return resultText || assistantComplete
  }
}

let _executor: ClaudeExecutor | null = null

export function getClaudeExecutor(): ClaudeExecutor {
  if (_executor) return _executor
  const mode = resolveMode(process.env.CLAUDE_EXECUTOR, process.env.NODE_ENV)
  _executor = mode === 'porygon' ? new PorygonExecutor() : new CliExecutor()
  return _executor
}

function resolveMode(
  envVar: string | undefined,
  nodeEnv: string | undefined,
): 'cli' | 'porygon' {
  if (envVar === 'cli' || envVar === 'porygon') return envVar
  if (envVar) {
    throw new Error(
      `CLAUDE_EXECUTOR=${envVar} 非法，合法值为 "cli" 或 "porygon"。` +
      ` 未设时：NODE_ENV=test 默认 cli（单测不触外部），其他默认 porygon。`,
    )
  }
  return nodeEnv === 'test' ? 'cli' : 'porygon'
}

/** 仅供测试使用：重置模块级缓存的 executor 实例 */
export function resetExecutorForTest(): void {
  _executor = null
}
