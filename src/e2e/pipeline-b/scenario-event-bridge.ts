// E2E pipeline-b 场景/修复 runner 共用的 Porygon onMessage → bus 桥接
//
// 抽出 e2e-scenario/runner.ts 和 e2e-fix/runner.ts 重复的 onMessage 处理逻辑：
//   - tool_use → bus.emit('tool_use', { step, toolName, argsSummary })
//   - assistant（msg.text 非空）→ bus.emit('assistant_text', { text: truncate(?, 1024) })
//   - error（msg.message 非空）→ bus.emit('agent_error', { message: truncate(?, 1024) })
//   - 其他类型 ignore
//
// 注意：
//   - stepCounter 由桥接闭包维护，每个 phase 独立计数
//   - summarizeArgs 防御 BigInt / 循环引用 / JSON.stringify 抛错
//   - 长字符串走 truncate，末尾带省略号 '…'

import { emit, type ScenarioEvent } from './scenario-event-bus.js'

export type PorygonMessage = {
  type: string
  toolName?: string
  input?: unknown
  text?: string
  message?: string
}

const TEXT_MAX = 1024
const ARGS_TOTAL_MAX = 240
const ARGS_VALUE_MAX = 120

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

export function summarizeArgs(input: unknown): string {
  try {
    if (input === null || input === undefined) {
      return truncate(String(input), ARGS_TOTAL_MAX)
    }
    if (typeof input !== 'object') {
      return truncate(String(input), ARGS_TOTAL_MAX)
    }
    const parts: string[] = []
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      let valueStr: string
      try {
        valueStr = JSON.stringify(v)
        if (valueStr === undefined) valueStr = String(v)
      } catch {
        valueStr = String(v)
      }
      parts.push(`${k}=${truncate(valueStr, ARGS_VALUE_MAX)}`)
    }
    return truncate(parts.join(' '), ARGS_TOTAL_MAX)
  } catch {
    try {
      return truncate(String(input), ARGS_TOTAL_MAX)
    } catch {
      return ''
    }
  }
}

export function createOnMessageBridge(
  runId: bigint,
  phase: 'scenario' | 'fix',
): (msg: PorygonMessage) => void {
  let stepCounter = 0
  return (msg: PorygonMessage) => {
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'tool_use': {
        stepCounter += 1
        const event: ScenarioEvent = {
          type: 'tool_use',
          runId: runId.toString(),
          phase,
          step: stepCounter,
          toolName: msg.toolName ?? 'unknown',
          argsSummary: summarizeArgs(msg.input),
          ts: Date.now(),
        }
        emit(runId, event)
        break
      }
      case 'assistant': {
        if (msg.text === undefined || msg.text === null || msg.text === '') return
        const event: ScenarioEvent = {
          type: 'assistant_text',
          runId: runId.toString(),
          phase,
          text: truncate(String(msg.text), TEXT_MAX),
          ts: Date.now(),
        }
        emit(runId, event)
        break
      }
      case 'error': {
        if (msg.message === undefined || msg.message === null || msg.message === '') return
        const event: ScenarioEvent = {
          type: 'agent_error',
          runId: runId.toString(),
          phase,
          message: truncate(String(msg.message), TEXT_MAX),
          ts: Date.now(),
        }
        emit(runId, event)
        break
      }
      default:
        // 其他 message 类型 ignore（system / result / progress 等）
        return
    }
  }
}
