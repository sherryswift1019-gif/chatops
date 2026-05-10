/**
 * 生产 SkillExecutor 实现。
 * 每次调用创建独立 Porygon 实例，用 qi-tools MCP server 取代标准 chatops-tools。
 */
import { createPorygon } from '@snack-kit/porygon'
import { buildClaudeEnv } from '../agent/claude-config.js'
import type { SkillExecutor, SkillExecutorResult } from './skill-runner.js'

export function createProductionSkillExecutor(): SkillExecutor {
  return {
    async execute(opts): Promise<SkillExecutorResult> {
      const claudeEnv = await buildClaudeEnv()
      const startedAt = Date.now()

      const porygon = createPorygon({
        defaultBackend: 'claude',
        backends: { claude: { interactive: false } },
      })

      let textBuffer = ''
      let assistantBuffer = ''
      let inputTokens = 0
      let outputTokens = 0

      try {
        const queryIter = porygon.query({
          prompt: opts.prompt,
          appendSystemPrompt: opts.systemPrompt,
          cwd: opts.cwd,
          mcpServers: {
            'qi-tools': {
              command: 'node',
              args: ['--import', 'tsx/esm', opts.mcpServerPath],
              env: {
                ...(process.env as Record<string, string>),
                ...opts.env,
                DATABASE_URL: process.env.DATABASE_URL ?? '',
                ...claudeEnv,
              },
            },
          },
          // skill agent 需要完整的文件系统工具，不禁用内置工具
          disallowedTools: [],
          envVars: { ...claudeEnv, ...opts.env },
          maxTurns: opts.maxTurns ?? 100,
        })

        const consume = async (): Promise<void> => {
          for await (const msg of queryIter) {
            if (msg.type === 'assistant' && 'text' in msg) {
              assistantBuffer += String((msg as { text: string }).text)
            } else if (msg.type === 'result' && 'text' in msg) {
              textBuffer += String((msg as { text: string }).text)
            }
            if ('usage' in msg && msg.usage) {
              const u = msg.usage as { input_tokens?: number; output_tokens?: number }
              if (u.input_tokens) inputTokens += u.input_tokens ?? 0
              if (u.output_tokens) outputTokens += u.output_tokens ?? 0
            }
          }
          if (!textBuffer && assistantBuffer) {
            textBuffer = assistantBuffer
          }
        }

        const abortPromise = opts.signal
          ? new Promise<never>((_, reject) => {
              opts.signal!.addEventListener('abort', () => {
                queryIter.return?.(undefined).catch(() => {})
                reject(new Error('skill executor aborted'))
              }, { once: true })
            })
          : null

        if (opts.timeoutMs && opts.timeoutMs > 0) {
          let timer: NodeJS.Timeout | undefined
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              queryIter.return?.(undefined).catch(() => {})
              reject(new Error(`skill executor timed out after ${opts.timeoutMs}ms`))
            }, opts.timeoutMs)
          })
          const races = [consume(), timeoutPromise, ...(abortPromise ? [abortPromise] : [])]
          try {
            await Promise.race(races)
          } finally {
            if (timer) clearTimeout(timer)
          }
        } else if (abortPromise) {
          await Promise.race([consume(), abortPromise])
        } else {
          await consume()
        }

        return {
          rawOutput: textBuffer,
          inputTokens,
          outputTokens,
          durationMs: Date.now() - startedAt,
          errorMessage: null,
        }
      } catch (err) {
        return {
          rawOutput: textBuffer,
          inputTokens,
          outputTokens,
          durationMs: Date.now() - startedAt,
          errorMessage: err instanceof Error ? err.message : String(err),
        }
      } finally {
        await porygon.dispose().catch(() => {})
      }
    },
  }
}
