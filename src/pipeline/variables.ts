/**
 * 变量模板约定（script 与 capability 节点语义统一）
 *
 * - `{{vars.xxx}}`：读取 `state.runtimeVars`（由 im_input / wait_webhook
 *   节点写入）与 `pipeline.variables`（流水线配置自定义变量）的合并值。
 *   script 节点走 resolveVariables（本文件），capability 节点走
 *   resolveCapabilityParams（src/pipeline/executor-hooks.ts）。
 * - `{{triggerParams.xxx}}`：script + capability 节点都识别，读取流水线触发时
 *   透传的 triggerParams（webhook/IM/手动触发的输入参数）。
 * - 未匹配的模板：保留字面字符串。
 *
 * capability 第一版仅支持整值替换（^{{...}}$），不支持嵌入式模板
 * （如 "foo-{{vars.x}}"）。
 *
 * phase 3 扩展（spec §4.2 / §4.5）：
 * - 点记法 + JSONPath 子集：`{{steps.x.output.rows[0].id}}`
 * - 内置过滤器：`{{x | urlEncode}}` / `| jsonStringify` / `| lower` / `| upper`
 * - fan_out scope 注入：当 `ctx.scopes.<head>` 存在时优先从 scopes 解析
 *   （priority: scopes > steps > vars > triggerParams）
 *
 * ⚠️ v1 不支持 `array[*].field` glob——超出本期范围，需要再扩展。
 */
export interface VariableContext {
  productLine: { name: string; displayName: string }
  pipeline: { id: number; name: string }
  run: { id: number; triggeredBy: string; triggerType: string }
  stage: { name: string; index: number }
  server: { host: string; port: number; username: string; name: string; role: string }
  vars: Record<string, string>
  triggerParams?: Record<string, unknown>
  /**
   * Per-node structured outputs keyed by node id, mirrored from
   * `state.stepOutputs` at the call site. Drives `{{steps.<id>.output.x}}`
   * resolution. resolvePath already supports this; the field declaration
   * makes the contract explicit and removes the need for `as any` at
   * caller sites that previously had to bypass the missing field.
   */
  steps?: Record<string, unknown>
  /**
   * fan_out 子运行注入的 scope 对象（spec §4.5 priority: scopes > steps >
   * vars > triggerParams）。外层 graph dispatch 永远是空。资料层 resolvePath
   * 已经在用，类型补齐避免调用方 `as any`。
   */
  scopes?: Record<string, unknown>
}

export interface VariableDefinition {
  key: string
  description: string
  category: string
}

export const VARIABLE_CATALOG: VariableDefinition[] = [
  // 产线
  { key: 'productLine.name', description: '产线标识名', category: '产线' },
  { key: 'productLine.displayName', description: '产线显示名', category: '产线' },
  // 流水线
  { key: 'pipeline.id', description: '流水线ID', category: '流水线' },
  { key: 'pipeline.name', description: '流水线名称', category: '流水线' },
  // 执行
  { key: 'run.id', description: '执行ID', category: '执行' },
  { key: 'run.triggeredBy', description: '触发人', category: '执行' },
  { key: 'run.triggerType', description: '触发方式', category: '执行' },
  // 阶段
  { key: 'stage.name', description: '当前阶段名称', category: '阶段' },
  { key: 'stage.index', description: '当前阶段序号', category: '阶段' },
  // 服务器
  { key: 'server.host', description: '服务器IP', category: '服务器' },
  { key: 'server.port', description: '服务器端口', category: '服务器' },
  { key: 'server.username', description: '用户名', category: '服务器' },
  { key: 'server.name', description: '服务器名称', category: '服务器' },
  { key: 'server.role', description: '服务器角色', category: '服务器' },
  // 自定义
  { key: 'vars.*', description: '自定义变量，在流水线配置中定义', category: '自定义' },
]

const FILTERS: Record<string, (v: unknown) => string> = {
  urlEncode: (v) => encodeURIComponent(String(v)),
  jsonStringify: (v) => JSON.stringify(v),
  lower: (v) => String(v).toLowerCase(),
  upper: (v) => String(v).toUpperCase(),
}

/**
 * Replace all `{{xxx}}` (with optional `| filter`) templates in script.
 * Supports dot-notation paths and JSONPath array index:
 *   `{{server.host}}` / `{{steps.x.output.rows[0].id}}`
 * Filters: `urlEncode` / `jsonStringify` / `lower` / `upper`.
 * Unresolved variables are left as-is (literal placeholder preserved).
 */
export function resolveVariables(template: string, ctx: VariableContext): string {
  return template.replace(/\{\{\s*([^}|]+?)(?:\s*\|\s*(\w+))?\s*\}\}/g, (raw, expr: string, filter?: string) => {
    const value = resolvePath(ctx as unknown as Record<string, unknown>, expr.trim())
    if (value === undefined) return raw // 未解析保留 {{...}}
    if (filter) {
      const fn = FILTERS[filter]
      if (!fn) throw new Error(`unknown variable filter: ${filter}`)
      return fn(value)
    }
    return typeof value === 'string' ? value : JSON.stringify(value).replace(/^"|"$/g, '')
  })
}

interface PathPart {
  kind: 'name' | 'index'
  name?: string
  index?: number
}

/**
 * Walk a dotted/bracketed path through a context object, honouring the same
 * priority chain as `resolveVariables` (`scopes > steps > vars > triggerParams`).
 *
 * Exported so capability-param resolution can share the exact same path
 * semantics as script-template resolution. Returns `undefined` for unresolved
 * paths so callers can decide between "preserve literal" and "throw".
 */
export function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  // 优先级: scopes > steps > vars > triggerParams (spec §4.5)
  // 简化实现：若 obj.scopes[<head>] 命中,则从 scopes 取 head；否则从 obj 取 head。
  const parts = parsePath(path)
  if (parts.length === 0) return undefined

  const scopes = (obj.scopes ?? {}) as Record<string, unknown>
  const head = parts[0]
  let cursor: unknown = head.kind === 'name' && head.name !== undefined && head.name in scopes
    ? scopes
    : obj

  for (const p of parts) {
    if (cursor == null || typeof cursor !== 'object') return undefined
    if (p.kind === 'name' && p.name !== undefined) {
      cursor = (cursor as Record<string, unknown>)[p.name]
    } else if (p.kind === 'index' && p.index !== undefined) {
      cursor = (cursor as unknown[])[p.index]
    }
  }
  return cursor
}

function parsePath(path: string): PathPart[] {
  const parts: PathPart[] = []
  let i = 0
  while (i < path.length) {
    if (path[i] === '.') {
      i++
      continue
    }
    if (path[i] === '[') {
      const j = path.indexOf(']', i)
      if (j === -1) return []
      const idx = parseInt(path.slice(i + 1, j), 10)
      if (Number.isNaN(idx)) return []
      parts.push({ kind: 'index', index: idx })
      i = j + 1
      continue
    }
    let j = i
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++
    parts.push({ kind: 'name', name: path.slice(i, j) })
    i = j
  }
  return parts
}
