import type { PipelineGraph } from './types.js'
import { parseExpression } from './expressions.js'

export interface ValidationResult {
  ok: boolean
  /** Alias for ok; used by canvas / tests */
  valid: boolean
  errors: string[]
}

/**
 * 静态校验 PipelineGraph：
 *   - 节点 id 唯一
 *   - 所有 edge.source/target 指向已存在节点
 *   - 无 cycle（DFS 三色标记）
 *   - condition.kind === 'expression' 时 expression 非空
 *   - fan_out 节点 params.body 必须非空数组
 *   - retry_when / shortCircuitWhen 表达式语法预解析（parseExpression 可解析）
 *   - {{steps.<id>.output...}} 引用必须指向自己的祖先节点
 * 允许：空图；多个不连通子图（画布编辑态）。
 */
export function validatePipelineGraph(graph: PipelineGraph): ValidationResult {
  const errors: string[] = []
  const nodeIds = new Set<string>()
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) errors.push(`duplicate node id: ${n.id}`)
    nodeIds.add(n.id)
    const fieldError = checkRequiredFields(n)
    if (fieldError) errors.push(fieldError)
  }

  const adjacency = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (!nodeIds.has(e.source)) errors.push(`edge ${e.id} source references missing node: ${e.source}`)
    if (!nodeIds.has(e.target)) errors.push(`edge ${e.id} target references missing node: ${e.target}`)
    if (e.condition?.kind === 'expression' && !e.condition.expression?.trim()) {
      errors.push(`edge ${e.id} condition.expression is empty`)
    }
    if (e.condition?.kind === 'expression' && e.condition.expression?.trim()) {
      try { parseExpression(e.condition.expression) }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`edge "${e.source}->${e.target}" expression 语法错误: ${msg}`)
      }
    }
    if (nodeIds.has(e.source) && nodeIds.has(e.target)) {
      const arr = adjacency.get(e.source) ?? []
      arr.push(e.target)
      adjacency.set(e.source, arr)
    }
  }

  // DFS cycle detection (white=0, gray=1, black=2)
  const color = new Map<string, 0 | 1 | 2>()
  for (const id of nodeIds) color.set(id, 0)
  function dfs(v: string): boolean {
    color.set(v, 1)
    for (const next of adjacency.get(v) ?? []) {
      const c = color.get(next)
      if (c === 1) return true
      if (c === 0 && dfs(next)) return true
    }
    color.set(v, 2)
    return false
  }
  let hasCycle = false
  for (const id of nodeIds) {
    if (color.get(id) === 0 && dfs(id)) {
      errors.push('graph contains cycle')
      hasCycle = true
      break
    }
  }

  // ---- Phase 3 T16 扩展 ---------------------------------------------------
  // 1) fan_out body 必须非空
  // 2) retry_when / shortCircuitWhen 表达式语法预解析
  // 3) {{steps.<id>.output...}} 引用必须是当前节点的祖先
  // 4) switch 节点字段 / target 引用 / when 表达式预解析
  // 5) outputFormat enum 校验
  for (const n of graph.nodes) {
    // 1) fan_out body 非空
    // n.stageType 静态 union 暂不含 'fan_out'(StageDefinition.stageType 未扩);
    // 实际 graph 数据可能携带 fan_out（schema-v34 已注册），松散比较即可。
    const stageTypeStr = n.stageType as string
    if (stageTypeStr === 'fan_out') {
      const params = (n as unknown as { params?: unknown }).params as
        | Record<string, unknown>
        | undefined
      const body = params?.body
      if (!Array.isArray(body) || body.length === 0) {
        errors.push(`fan_out node "${n.id}" must have non-empty body array`)
      }
    }

    // 2a) retry_when（位于节点顶层，名字未必在 PipelineNode 类型上声明，松散读取）
    const retryWhen = (n as unknown as { retryWhen?: unknown }).retryWhen
    if (typeof retryWhen === 'string' && retryWhen.trim()) {
      try {
        parseExpression(retryWhen)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        errors.push(`node "${n.id}" retry_when 语法错误: ${msg}`)
      }
    }

    // 2b) shortCircuitWhen（位于 params 内）
    const params = (n as unknown as { params?: unknown }).params as
      | Record<string, unknown>
      | undefined
    const shortCircuitWhen = params?.shortCircuitWhen
    if (typeof shortCircuitWhen === 'string' && shortCircuitWhen.trim()) {
      try {
        parseExpression(shortCircuitWhen)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        errors.push(`node "${n.id}" shortCircuitWhen 语法错误: ${msg}`)
      }
    }

    // 4) switch 节点：必填字段校验
    if (stageTypeStr === 'switch') {
      const switchParams = (n as unknown as { params?: { cases?: unknown; default?: unknown } }).params ?? {}
      if (!Array.isArray(switchParams.cases) || switchParams.cases.length === 0) {
        errors.push(`node "${n.id}" (stageType=switch): cases is required (non-empty array)`)
      }
      if (typeof switchParams.default !== 'string' || !(switchParams.default as string).trim()) {
        errors.push(`node "${n.id}" (stageType=switch): default is required`)
      }
      if (Array.isArray(switchParams.cases)) {
        ;(switchParams.cases as Array<{ when?: unknown; target?: unknown }>).forEach((c, i) => {
          if (typeof c?.when !== 'string' || !c.when.trim()) {
            errors.push(`switch "${n.id}" cases[${i}].when 必填`)
          }
          if (typeof c?.target !== 'string' || !c.target.trim()) {
            errors.push(`switch "${n.id}" cases[${i}].target 必填`)
          }
          // when 表达式预解析
          if (typeof c?.when === 'string' && c.when.trim()) {
            try { parseExpression(c.when) }
            catch (e) {
              const msg = e instanceof Error ? e.message : String(e)
              errors.push(`switch "${n.id}" cases[${i}].when 语法错误: ${msg}`)
            }
          }
        })
      }
      // target 引用合法性 + 自环检测
      const cases = Array.isArray(switchParams.cases) ? switchParams.cases : []
      ;(cases as Array<{ target?: unknown }>).forEach((c, i) => {
        if (typeof c?.target === 'string' && c.target) {
          if (c.target === n.id) {
            errors.push(`switch "${n.id}" cases[${i}].target 不能指向自己`)
          } else if (!nodeIds.has(c.target)) {
            errors.push(`switch "${n.id}" cases[${i}].target references unknown node: ${c.target}`)
          }
        }
      })
      const dt = switchParams.default
      if (typeof dt === 'string' && dt) {
        if (dt === n.id) {
          errors.push(`switch "${n.id}" default 不能指向自己`)
        } else if (!nodeIds.has(dt)) {
          errors.push(`switch "${n.id}" default references unknown node: ${dt}`)
        }
      }
    }

    // 5) outputFormat enum 校验
    const of_ = (n as unknown as { outputFormat?: unknown }).outputFormat
    if (of_ !== undefined && of_ !== 'string' && of_ !== 'json') {
      errors.push(`node "${n.id}" outputFormat 必须是 'string' 或 'json'，得到 ${JSON.stringify(of_)}`)
    }
  }

  // 3) steps 引用 DFS 校验 —— 仅在无 cycle 时做（cycle 下 ancestors 无意义）
  if (!hasCycle) {
    const ancestors = computeAllAncestors(graph)
    for (const n of graph.nodes) {
      // 收集本节点所有 string param 中出现的 steps 引用
      const params = (n as unknown as { params?: unknown }).params
      const retryWhen = (n as unknown as { retryWhen?: unknown }).retryWhen
      const refsInParams = findStepReferences(params)
      const refsInRetry = typeof retryWhen === 'string' ? findStepReferences(retryWhen) : []
      const refs = new Set([...refsInParams, ...refsInRetry])
      const allowed = ancestors.get(n.id) ?? new Set<string>()
      for (const ref of refs) {
        if (ref === n.id) continue // 自引用极不可能,但容错跳过
        if (!nodeIds.has(ref)) {
          errors.push(`node "${n.id}" references unknown step "${ref}"`)
        } else if (!allowed.has(ref)) {
          errors.push(`node "${n.id}" references non-ancestor step "${ref}"`)
        }
      }
    }
  }

  return { ok: errors.length === 0, valid: errors.length === 0, errors }
}

/**
 * 收集 nodeId 的所有祖先节点 ID（不含自身）。
 * BFS 沿 edges 反向遍历：edge.target → edge.source。
 */
export function computeAncestors(graph: PipelineGraph, nodeId: string): Set<string> {
  // 构建反向邻接表：target → source[]
  const reverseAdj = new Map<string, string[]>()
  for (const e of graph.edges) {
    const arr = reverseAdj.get(e.target) ?? []
    arr.push(e.source)
    reverseAdj.set(e.target, arr)
  }

  const ancestors = new Set<string>()
  const queue: string[] = [nodeId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const parent of reverseAdj.get(current) ?? []) {
      if (!ancestors.has(parent)) {
        ancestors.add(parent)
        queue.push(parent)
      }
    }
  }
  return ancestors
}

function checkRequiredFields(n: PipelineGraph['nodes'][number]): string | null {
  const prefix = `node ${n.id} (stageType=${n.stageType})`
  switch (n.stageType) {
    case 'llm_agent': {
      const mode = n.agentMode ?? 'capability'
      if (mode === 'capability') {
        if (!n.capabilityKey || !n.capabilityKey.trim()) {
          return `${prefix}: capabilityKey is required for agentMode='capability'`
        }
      } else if (mode === 'custom') {
        if (!n.customPrompt?.trim()) {
          return `${prefix}: customPrompt is required for agentMode='custom'`
        }
      } else {
        return `${prefix}: agentMode must be 'capability' or 'custom'`
      }
      return null
    }
    case 'wait_webhook':
      if (!n.webhookTag || !n.webhookTag.trim()) {
        return `${prefix}: webhookTag is required`
      }
      return null
    case 'im_input': {
      const cfg = n.imInputConfig
      if (!cfg || !cfg.prompt || !cfg.prompt.trim()) {
        return `${prefix}: imInputConfig.prompt is required`
      }
      if (
        typeof cfg.paramSchema !== 'object' ||
        cfg.paramSchema === null ||
        Array.isArray(cfg.paramSchema)
      ) {
        return `${prefix}: imInputConfig.paramSchema must be an object`
      }
      return null
    }
    case 'approval':
      if (!Array.isArray(n.approverIds) || n.approverIds.length === 0) {
        return `${prefix}: approverIds is required (non-empty array)`
      }
      return null
    case 'script':
      return null
    default:
      return null
  }
}

/**
 * 递归扫描任意值，找出形如 `{{steps.<id>.` 的引用 id。
 */
function findStepReferences(value: unknown): string[] {
  if (typeof value === 'string') {
    return [...value.matchAll(/\{\{\s*steps\.([a-zA-Z0-9_-]+)\./g)].map((m) => m[1])
  }
  if (Array.isArray(value)) return value.flatMap(findStepReferences)
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(findStepReferences)
  }
  return []
}

/**
 * 对每个节点计算其所有可达的祖先节点集合（基于 graph.edges 反向 DFS）。
 */
function computeAllAncestors(graph: PipelineGraph): Map<string, Set<string>> {
  // reverse adjacency: node → list of parents
  const parents = new Map<string, string[]>()
  for (const e of graph.edges) {
    const arr = parents.get(e.target) ?? []
    arr.push(e.source)
    parents.set(e.target, arr)
  }
  const cache = new Map<string, Set<string>>()
  function visit(id: string, stack: Set<string>): Set<string> {
    const cached = cache.get(id)
    if (cached) return cached
    if (stack.has(id)) return new Set() // cycle guard
    stack.add(id)
    const acc = new Set<string>()
    for (const p of parents.get(id) ?? []) {
      acc.add(p)
      for (const a of visit(p, stack)) acc.add(a)
    }
    stack.delete(id)
    cache.set(id, acc)
    return acc
  }
  for (const n of graph.nodes) visit(n.id, new Set())
  return cache
}
