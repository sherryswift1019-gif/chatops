import dagre from '@dagrejs/dagre'
import { useCallback } from 'react'
import type { StageNode, StageEdge } from '../types'

const NODE_W = 220
const NODE_H = 80

/**
 * dagre 自动排版：top-to-bottom 布局，返回新 position 的 nodes。
 * 不修改 edges。节点宽高固定（与 StageNodeCard 对齐）。
 */
export function useAutoLayout() {
  return useCallback((nodes: StageNode[], edges: StageEdge[]): StageNode[] => {
    const g = new dagre.graphlib.Graph()
    g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60 })
    g.setDefaultEdgeLabel(() => ({}))

    for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
    for (const e of edges) g.setEdge(e.source, e.target)

    dagre.layout(g)

    return nodes.map(n => {
      const pos = g.node(n.id)
      return {
        ...n,
        position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      }
    })
  }, [])
}
