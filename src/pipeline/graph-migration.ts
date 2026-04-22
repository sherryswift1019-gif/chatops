import { ulid } from 'ulidx'
import type { StageDefinition, PipelineGraph, PipelineNode, PipelineEdge } from './types.js'

/**
 * 把旧的 StageDefinition[] 转换为线性 PipelineGraph（纯函数）。
 * - 用于 graph IS NULL 时 repository 层的内存 fallback
 * - 也用于画布首次保存前的"打开即展示"
 * position.y 等差递增，x 固定，方便 dagre 后续接管。
 */
export function linearizeStages(stages: StageDefinition[]): PipelineGraph {
  const nodes: PipelineNode[] = stages.map((stage, i) => ({
    ...stage,
    id: ulid(),
    position: { x: 200, y: 100 + i * 120 },
  }))
  const edges: PipelineEdge[] = []
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ id: ulid(), source: nodes[i].id, target: nodes[i + 1].id })
  }
  return { nodes, edges }
}
