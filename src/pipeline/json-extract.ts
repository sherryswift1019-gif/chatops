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
  // 匹配所有 ```json\n...\n``` / ```\n...\n``` fence 候选（lang 可选、首尾换行可选）。
  // 真实 LLM 输出常含多个 fence（分析报告里夹 ```bash``` shell 命令 + 末尾
  // ```json``` 答案）；旧实现单次 match 必中第一个 fence，碰到 bash 在前会 parse
  // 失败，再退到步骤 3 first/last `{}` substring 把散文里的 `{{...}}` 字面引用
  // 抓进来导致 SyntaxError。
  //
  // 修法：迭代所有 fence，**优先尝试显式 `json`/`JSON` lang 标注的 block**
  // (语义最稳健)，再尝试无 lang fence；每个候选 parseStrict，第一个 plain
  // object 赢；遇 NotJsonObjectError（数组/null/primitive）立即上抛——保留
  // "fence 内是 array 也直接拒"的现有语义；只有 SyntaxError 才继续尝试下一个。
  const fenceMatches = Array.from(
    trimmed.matchAll(/```(json|JSON)?[ \t]*\n?([\s\S]*?)\n?[ \t]*```/g),
  )
  if (fenceMatches.length > 0) {
    const labeled = fenceMatches.filter((m) => m[1] && m[1] !== '')
    const unlabeled = fenceMatches.filter((m) => !m[1])
    const ordered = [...labeled, ...unlabeled]
    let lastSyntaxErr: unknown
    for (const m of ordered) {
      const content = m[2].trim()
      if (content === '') continue
      try {
        return parseStrict(content)
      } catch (e) {
        if (e instanceof NotJsonObjectError) throw e
        lastSyntaxErr = e
        // SyntaxError → 继续下一个 fence 候选
      }
    }
    // 所有 fence 候选都 parse 失败 → 落到步骤 3 兜底；lastSyntaxErr 不直接抛，
    // 让步骤 3 兜底有机会救场（first/last `{}` substring 是最后一道防线）。
    void lastSyntaxErr
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
