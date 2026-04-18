/**
 * Claude CLI 直接调用引擎
 * 从 pam-smart/pas-error-analyzer/analysis-engine.js 移植
 * 使用 claude -p + --allowed-tools + --output-format stream-json
 */
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

interface ClaudeRunEvent {
  type: 'init' | 'tool_call' | 'done'
  message: string
  data?: Record<string, unknown>
}

type EventCallback = (event: ClaudeRunEvent) => void

export async function runClaudeCli(opts: {
  prompt: string
  allowedTools?: string
  timeoutMs?: number
  onEvent?: EventCallback
  signal?: AbortSignal
}): Promise<string> {
  const { prompt, allowedTools = 'Read,Glob,Grep', timeoutMs = 5 * 60_000, onEvent, signal } = opts

  // 如果外部已取消，直接拒绝
  if (signal?.aborted) {
    throw new Error('已取消')
  }
  const tmpDir = `/tmp/chatops-claude-${Date.now()}`
  mkdirSync(tmpDir, { recursive: true })

  const timestamp = Date.now()
  const promptPath = join(tmpDir, `prompt-${timestamp}.txt`)
  const scriptPath = join(tmpDir, `run-${timestamp}.sh`)

  writeFileSync(promptPath, prompt)

  const scriptContent = `#!/bin/bash
[[ -f ~/.zshrc ]] && source ~/.zshrc
[[ -f ~/.bashrc ]] && source ~/.bashrc

cd "${tmpDir}"
unset CLAUDECODE
PROMPT=$(cat "${promptPath}")
claude -p "$PROMPT" --allowed-tools "${allowedTools}" --output-format stream-json --verbose < /dev/null
`
  writeFileSync(scriptPath, scriptContent, { mode: 0o755 })
  console.log(`[ClaudeCLI] prompt(前200字): ${prompt.substring(0, 200)}...`)

  return new Promise<string>((resolve, reject) => {
    const startTime = Date.now()
    let resultText = ''
    let buffer = ''
    let toolCallCount = 0

    const child = spawn('bash', ['-l', scriptPath], {
      cwd: tmpDir,
      env: process.env,
    })

    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)

          if (event.type === 'system' && event.subtype === 'init') {
            console.log(`  [${elapsed}s] 初始化完成, model=${event.model}`)
            onEvent?.({ type: 'init', message: `Claude 初始化完成 (${elapsed}s)` })

          } else if (event.type === 'assistant' && event.message) {
            for (const block of (event.message.content || [])) {
              if (block.type === 'tool_use') {
                toolCallCount++
                let toolDesc = block.name
                if (block.name === 'Read' && block.input?.file_path) {
                  toolDesc = `Read(${block.input.file_path})`
                } else if (block.name === 'Glob' && block.input?.pattern) {
                  toolDesc = `Glob(${block.input.pattern})`
                } else if (block.name === 'Grep' && block.input?.pattern) {
                  toolDesc = `Grep(${block.input.pattern.substring(0, 40)})`
                } else if (block.name === 'Bash' && block.input?.command) {
                  toolDesc = `Bash(${block.input.command.substring(0, 60)})`
                }
                console.log(`  [${elapsed}s] 工具#${toolCallCount}: ${toolDesc}`)
                onEvent?.({ type: 'tool_call', message: toolDesc, data: { elapsed, toolCallCount, toolName: block.name } })

              } else if (block.type === 'text' && block.text) {
                resultText = block.text
              }
            }

          } else if (event.type === 'result') {
            resultText = event.result || resultText
            const durationSec = event.duration_ms ? (event.duration_ms / 1000).toFixed(1) : elapsed
            const cost = event.total_cost_usd ? `$${event.total_cost_usd.toFixed(4)}` : '?'
            const turns = event.num_turns || '?'
            console.log(`  [${elapsed}s] 完成: 耗时=${durationSec}s, turns=${turns}, 费用=${cost}`)
            onEvent?.({ type: 'done', message: `耗时=${durationSec}s, turns=${turns}, 费用=${cost}` })
          }
        } catch {
          // 非 JSON 行，忽略
        }
      }
    })

    child.stderr.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) console.log(`  [stderr] ${msg}`)
    })

    let settled = false

    const cleanup = () => {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }

    const killChild = () => {
      try { child.kill('SIGTERM') } catch {}
      // 如果 SIGTERM 后 5 秒还没退出，强制 SIGKILL
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
      }, 5000)
    }

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[ClaudeCLI] 总耗时: ${totalTime}s (工具调用 ${toolCallCount} 次)`)

      if (code !== 0 && !resultText) {
        reject(new Error(`Claude 执行失败，退出码: ${code}`))
      } else {
        resolve(resultText)
      }
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killChild()
      cleanup()
      reject(new Error(`分析超时(${timeoutMs / 1000}秒)`))
    }, timeoutMs)

    // 外部取消信号（Pipeline 超时时触发）
    if (signal) {
      const onAbort = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        killChild()
        cleanup()
        reject(new Error('已被外部取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      // child close 时移除监听
      child.on('close', () => signal.removeEventListener('abort', onAbort))
    }
  })
}
