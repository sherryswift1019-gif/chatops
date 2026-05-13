/**
 * im-input-agent — 决策器：判断当前 im_input stage 是否参数齐全。
 *
 * 第一版：启发式 key=value 解析 + 缺失字段提示 + enum 校验。
 * 未来可扩展：当 imInputConfig.capabilityKey 存在时 fallback 到 Claude，
 * 让 Agent 用对话式推理处理更复杂的意图。
 */

export interface ConsultInput {
  userMessage: string
  currentParams: Record<string, unknown>
  paramSchema: Record<string, unknown>
}

export interface ConsultResult {
  done: boolean
  aborted?: boolean
  params: Record<string, unknown>
  nextPrompt?: string
}

interface SchemaProperty {
  type?: string
  enum?: string[]
  title?: string
}

const ABORT_WORDS = new Set(['cancel', 'abort', '取消', '退出', 'quit'])

// 支持三种形式：key="value with space" / key='value' / key=value（无引号）
const KV_REGEX = /(\w+)\s*=\s*("[^"]*"|'[^']*'|\S+)/g

function unquote(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  return raw
}

export async function consultImInputAgent(input: ConsultInput): Promise<ConsultResult> {
  const msg = input.userMessage.trim()

  if (ABORT_WORDS.has(msg.toLowerCase())) {
    return { done: false, aborted: true, params: input.currentParams }
  }

  const props = (input.paramSchema.properties ?? {}) as Record<string, SchemaProperty>
  const required = (input.paramSchema.required ?? []) as string[]

  // 解析所有 key=value 对
  const merged: Record<string, unknown> = { ...input.currentParams }
  let matchedAny = false
  KV_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KV_REGEX.exec(msg)) !== null) {
    const key = m[1]
    const val = unquote(m[2])
    if (key in props) {
      merged[key] = val
      matchedAny = true
    }
  }

  // 单字段模式：message 不含 = 且恰好只缺一个必填项 → 整条消息作值
  if (!matchedAny && !msg.includes('=')) {
    const missing = required.filter(k => merged[k] === undefined || merged[k] === '')
    if (missing.length === 1) {
      merged[missing[0]] = msg
    }
  }

  // 校验 enum
  for (const [key, prop] of Object.entries(props)) {
    const v = merged[key]
    if (prop.enum && v !== undefined && !prop.enum.includes(v as string)) {
      const label = prop.title ?? key
      return {
        done: false,
        params: merged,
        nextPrompt: `${label} 的取值必须是：${prop.enum.join(' / ')}，请重新输入。`,
      }
    }
  }

  // 找第一个缺失的必填
  const firstMissing = required.find(k => merged[k] === undefined || merged[k] === '')
  if (firstMissing) {
    const prop = props[firstMissing]
    const label = prop?.title ?? firstMissing
    const enumHint = prop?.enum ? `（可选：${prop.enum.join(' / ')}）` : ''
    return {
      done: false,
      params: merged,
      nextPrompt: `请提供 ${label}${enumHint}。可以直接回值，或用 \`${firstMissing}=xxx\` 形式；回 \`取消\` 中止。`,
    }
  }

  return { done: true, params: merged }
}

export function parseBrainstormAnswer(raw: string): { chosenOption?: string; freeText?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { freeText: '' }

  // single letter A-Z (optionally trailing whitespace already trimmed)
  const single = trimmed.match(/^([A-Za-z])\s*$/)
  if (single) return { chosenOption: single[1].toUpperCase() }

  // letter + separator (space / ASCII comma / fullwidth comma) + text
  const composite = trimmed.match(/^([A-Za-z])[\s,，]+(.+)$/)
  if (composite) return { chosenOption: composite[1].toUpperCase(), freeText: composite[2].trim() }

  return { freeText: trimmed }
}
