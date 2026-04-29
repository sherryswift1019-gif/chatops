/**
 * Robust JSON-object extraction for LLM stage outputs.
 *
 * 使用场景：pipeline llm_agent stage 当 outputFormat='json' 时，把 LLM 文本
 * 输出 parse 成对象写到 stepOutputs。LLM（Claude/各家）即便提示"只返回 JSON"
 * 也常包 markdown fence、附带前后散文，这是已知不可 100% 抑制的行为。
 *
 * 行为（按严格性递减尝试，第一个成功的赢）：
 *   1. 严格 JSON.parse(raw.trim())
 *   2. 剥 ```json\n...\n``` / ```\n...\n``` markdown fence 后再 parse
 *   3. 找 first `{` 到 last `}` substring 再 parse
 *   4. 上面任一步 parse 出非 plain object（null / array / primitive）→ NotJsonObjectError
 *   5. 全部失败 → 抛最后一次 SyntaxError-like 错误
 *
 * 不会做的：模糊到极致（比如把 "intent: rollback" 这种非 JSON 强行解析）。
 */

export class NotJsonObjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotJsonObjectError'
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 把任意候选字符串当 JSON 解析；若解析成功但结果不是 plain object，
 * 抛 NotJsonObjectError；若解析失败，把原始 SyntaxError 透出（调用方
 * 自行决定下一步尝试或最终上报）。
 */
function parseStrict(candidate: string): Record<string, unknown> {
  const v = JSON.parse(candidate) as unknown
  if (!isPlainObject(v)) {
    throw new NotJsonObjectError('输出必须是 JSON 对象')
  }
  return v
}

export function extractJsonObject(raw: string): Record<string, unknown> {
  if (typeof raw !== 'string') {
    throw new SyntaxError('extractJsonObject: raw input is not a string')
  }
  const trimmed = raw.trim()
  if (trimmed === '') {
    throw new SyntaxError('extractJsonObject: empty input')
  }

  // 步骤 1：严格 parse
  try {
    return parseStrict(trimmed)
  } catch (e) {
    if (e instanceof NotJsonObjectError) throw e
    // SyntaxError → 落到步骤 2
  }

  // 步骤 2：剥 markdown fence
  // 匹配 ```json\n...\n``` 或 ```\n...\n```（lang 可选、首尾换行可选）
  const fenceMatch = trimmed.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch && fenceMatch[1].trim() !== '') {
    try {
      return parseStrict(fenceMatch[1].trim())
    } catch (e) {
      if (e instanceof NotJsonObjectError) throw e
      // SyntaxError → 落到步骤 3
    }
  }

  // 步骤 3：找 first `{` 到 last `}` substring
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) {
    const sub = trimmed.slice(first, last + 1)
    // parseStrict 失败让原 SyntaxError 抛出，作为最终错误
    return parseStrict(sub)
  }

  // 走到这里说明 trimmed 既不是合法 JSON、也无 fence、也无 `{...}` 子串。
  // 重新跑严格 parse 让 V8 给一份原汁原味的 SyntaxError 上抛。
  return parseStrict(trimmed)
}
