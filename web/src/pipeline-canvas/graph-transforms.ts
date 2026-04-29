import type { StageNode, StageEdge, PipelineGraphWire, ConditionEdgeData } from './types'

export function wireToNodes(w: PipelineGraphWire): StageNode[] {
  return w.nodes.map(n => ({
    id: n.id,
    type: n.stageType,
    position: n.position,
    data: { ...n },
  }))
}

export function wireToEdges(w: PipelineGraphWire): StageEdge[] {
  return w.edges.map(e => ({
    id: e.id, source: e.source, target: e.target,
    type: 'conditional',
    sourceHandle: e.sourceHandle,
    data: {
      ...(e.condition ? { condition: e.condition } : {}),
      ...(e.sourceHandle === 'default' ? { isDefault: true } : {}),
    } as ConditionEdgeData | undefined,
  }))
}
