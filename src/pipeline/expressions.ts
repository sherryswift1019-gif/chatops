/**
 * Pipeline 表达式解析器（spec §4.7 v1）
 *
 * 用途：retry_when / shortCircuitWhen / 边 when 共用的布尔表达式语言。
 *
 * 支持算子：
 *   `==` `!=` `<` `<=` `>` `>=` `&&` `||` `!` `contains`
 *
 * 优先级（由低到高）：`||` < `&&` < `!` < 比较 < primary
 *
 * Primary：
 *   - 字符串字面量（单引号）：`'foo'`
 *   - 数字字面量：`504` / `0.5`
 *   - 布尔字面量：`true` / `false`
 *   - 路径：`status` / `output.error` / `steps.a.output.count`
 *   - 括号子表达式：`(...)`
 *
 * 不支持（v1）：函数、map/filter、负数前缀、字符串转义。
 *
 * 路径解析约定：从 ctx 根开始按段下钻；段名只允许 `[A-Za-z_][A-Za-z0-9_]*`。
 */

export type Expr =
  | { type: 'literal'; value: string | number | boolean }
  | { type: 'path'; segments: string[] }
  | {
      type: 'binop'
      op: '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||' | 'contains'
      left: Expr
      right: Expr
    }
  | { type: 'not'; expr: Expr }

interface Token {
  type: 'op' | 'lparen' | 'rparen' | 'string' | 'number' | 'bool' | 'ident'
  value: string
}

const MULTI_CHAR_OPS = ['==', '!=', '<=', '>=', '&&', '||'] as const
const SINGLE_CHAR_OPS = ['<', '>', '!'] as const
const KEYWORD_OPS = new Set(['contains'])
const KEYWORD_BOOLS = new Set(['true', 'false'])

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]

    // 空白
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }

    // 括号
    if (c === '(') {
      tokens.push({ type: 'lparen', value: '(' })
      i++
      continue
    }
    if (c === ')') {
      tokens.push({ type: 'rparen', value: ')' })
      i++
      continue
    }

    // 多字符算子（== != <= >= && ||）必须先于单字符算子匹配
    let matched = false
    for (const op of MULTI_CHAR_OPS) {
      if (src.startsWith(op, i)) {
        tokens.push({ type: 'op', value: op })
        i += op.length
        matched = true
        break
      }
    }
    if (matched) continue

    // 单字符算子（< > !）
    for (const op of SINGLE_CHAR_OPS) {
      if (c === op) {
        tokens.push({ type: 'op', value: op })
        i++
        matched = true
        break
      }
    }
    if (matched) continue

    // 字符串字面量（单引号，不支持转义）
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      if (j === -1) {
        throw new Error(`parse error at ${i}: unterminated string literal`)
      }
      tokens.push({ type: 'string', value: src.slice(i + 1, j) })
      i = j + 1
      continue
    }

    // 数字字面量（整数 / 小数）
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) {
        j++
      }
      tokens.push({ type: 'number', value: src.slice(i, j) })
      i = j
      continue
    }

    // 标识符 / 关键字 / 路径段（首字符 a-z / A-Z / _，后续 a-z / A-Z / 0-9 / _ / . / [ / ]）
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i + 1
      while (
        j < src.length &&
        ((src[j] >= 'a' && src[j] <= 'z') ||
          (src[j] >= 'A' && src[j] <= 'Z') ||
          (src[j] >= '0' && src[j] <= '9') ||
          src[j] === '_' ||
          src[j] === '.' ||
          src[j] === '[' ||
          src[j] === ']')
      ) {
        j++
      }
      const word = src.slice(i, j)
      if (KEYWORD_OPS.has(word)) {
        tokens.push({ type: 'op', value: word })
      } else if (KEYWORD_BOOLS.has(word)) {
        tokens.push({ type: 'bool', value: word })
      } else {
        tokens.push({ type: 'ident', value: word })
      }
      i = j
      continue
    }

    throw new Error(`parse error at ${i}: unexpected character '${c}' (no matching operator)`)
  }
  return tokens
}

const COMPARE_OPS = new Set(['==', '!=', '<', '<=', '>', '>=', 'contains'])

export function parseExpression(src: string): Expr {
  const tokens = tokenize(src)
  let pos = 0

  function peek(): Token | undefined {
    return tokens[pos]
  }

  function eat(type: Token['type'], value?: string): Token | undefined {
    const t = tokens[pos]
    if (!t) return undefined
    if (t.type !== type) return undefined
    if (value !== undefined && t.value !== value) return undefined
    pos++
    return t
  }

  function expect(type: Token['type'], value?: string): Token {
    const t = tokens[pos]
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(
        `parse error at ${pos}: expected ${type}${value !== undefined ? `(${value})` : ''}, got ${t?.type ?? 'EOF'}${t ? `(${t.value})` : ''}`,
      )
    }
    pos++
    return t
  }

  function parseOr(): Expr {
    let left = parseAnd()
    while (peek()?.type === 'op' && peek()?.value === '||') {
      pos++
      const right = parseAnd()
      left = { type: 'binop', op: '||', left, right }
    }
    return left
  }

  function parseAnd(): Expr {
    let left = parseNot()
    while (peek()?.type === 'op' && peek()?.value === '&&') {
      pos++
      const right = parseNot()
      left = { type: 'binop', op: '&&', left, right }
    }
    return left
  }

  function parseNot(): Expr {
    if (peek()?.type === 'op' && peek()?.value === '!') {
      pos++
      const inner = parseNot()
      return { type: 'not', expr: inner }
    }
    return parseCompare()
  }

  function parseCompare(): Expr {
    const left = parsePrimary()
    const t = peek()
    if (t && t.type === 'op' && COMPARE_OPS.has(t.value)) {
      pos++
      const right = parsePrimary()
      return {
        type: 'binop',
        op: t.value as
          | '=='
          | '!='
          | '<'
          | '<='
          | '>'
          | '>='
          | 'contains',
        left,
        right,
      }
    }
    return left
  }

  function parsePrimary(): Expr {
    const t = peek()
    if (!t) {
      throw new Error(`parse error at ${pos}: unexpected end of input`)
    }

    if (t.type === 'lparen') {
      pos++
      const inner = parseOr()
      expect('rparen')
      return inner
    }

    if (t.type === 'string') {
      pos++
      return { type: 'literal', value: t.value }
    }

    if (t.type === 'number') {
      pos++
      const n = Number(t.value)
      if (Number.isNaN(n)) {
        throw new Error(`parse error at ${pos - 1}: invalid number literal '${t.value}'`)
      }
      return { type: 'literal', value: n }
    }

    if (t.type === 'bool') {
      pos++
      return { type: 'literal', value: t.value === 'true' }
    }

    if (t.type === 'ident') {
      pos++
      // 把 ident（包含 `.` `[` `]`）切成 segments；v1 仅支持点切分，[idx] 暂不参与
      // expr 路径解析里 segments 是字符串数组（resolvePathInExpr 按字面 key 下钻）
      const segments = t.value.split('.').filter((s) => s.length > 0)
      return { type: 'path', segments }
    }

    throw new Error(
      `parse error at ${pos}: unexpected token ${t.type}(${t.value})`,
    )
  }

  const expr = parseOr()
  if (pos !== tokens.length) {
    const trailing = tokens[pos]
    throw new Error(
      `parse error: trailing tokens at ${pos} (${trailing?.type}:${trailing?.value})`,
    )
  }
  return expr
}

export function evalExpression(
  src: string | Expr,
  ctx: Record<string, unknown>,
): boolean {
  const ast = typeof src === 'string' ? parseExpression(src) : src
  return Boolean(evalNode(ast, ctx))
}

function evalNode(e: Expr, ctx: Record<string, unknown>): unknown {
  switch (e.type) {
    case 'literal':
      return e.value
    case 'path':
      return resolvePathInExpr(ctx, e.segments)
    case 'not':
      return !evalNode(e.expr, ctx)
    case 'binop': {
      const l = evalNode(e.left, ctx)
      const r = evalNode(e.right, ctx)
      switch (e.op) {
        case '==':
          return l === r
        case '!=':
          return l !== r
        case '<':
          return (l as number) < (r as number)
        case '<=':
          return (l as number) <= (r as number)
        case '>':
          return (l as number) > (r as number)
        case '>=':
          return (l as number) >= (r as number)
        case '&&':
          return Boolean(l) && Boolean(r)
        case '||':
          return Boolean(l) || Boolean(r)
        case 'contains':
          return String(l).includes(String(r))
      }
    }
  }
}

function resolvePathInExpr(
  ctx: Record<string, unknown>,
  segments: string[],
): unknown {
  let cursor: unknown = ctx
  for (const s of segments) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[s]
  }
  return cursor
}
