import type { PipelineGraph } from './types.js'

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * 静态校验 PipelineGraph：
 *   - 节点 id 唯一
 *   - 所有 edge.source/target 指向已存在节点
 *   - 无 cycle（DFS 三色标记）
 *   - condition.kind === 'expression' 时 expression 非空
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
  for (const id of nodeIds) {
    if (color.get(id) === 0 && dfs(id)) {
      errors.push('graph contains cycle')
      break
    }
  }

  return { ok: errors.length === 0, errors }
}

function checkRequiredFields(n: PipelineGraph['nodes'][number]): string | null {
  const prefix = `node ${n.id} (stageType=${n.stageType})`
  switch (n.stageType) {
    case 'capability':
      if (!n.capabilityKey || !n.capabilityKey.trim()) {
        return `${prefix}: capabilityKey is required`
      }
      return null
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
