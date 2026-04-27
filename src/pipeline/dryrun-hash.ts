import { createHash } from 'node:crypto'
import { computeAncestors } from './graph-validation.js'
import type { PipelineGraph } from './types.js'

export function computeUpstreamHash(graph: PipelineGraph, targetNodeId: string): string {
  const ancestors = computeAncestors(graph, targetNodeId)
  const sorted = [...ancestors].sort()
  const fingerprint = sorted.map(id => {
    const n = graph.nodes.find(x => x.id === id)
    if (!n) return { id }
    return {
      id: n.id,
      stageType: n.stageType,
      params: (n as { params?: unknown }).params,
      capabilityKey: (n as { capabilityKey?: string }).capabilityKey,
      outputFormat: (n as { outputFormat?: string }).outputFormat,
      script: (n as { script?: string }).script,
    }
  })
  const upstreamEdges = graph.edges
    .filter(e => ancestors.has(e.source) && ancestors.has(e.target))
    .map(e => ({ source: e.source, target: e.target, condition: e.condition }))
    .sort((a, b) => `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`))

  const payload = JSON.stringify({ nodes: fingerprint, edges: upstreamEdges })
  return createHash('sha256').update(payload).digest('hex')
}
