import { useState, useCallback, useRef } from 'react'
import type { StageNode, StageEdge, PipelineGraphWire, StageFields, ConditionEdgeData } from '../types'

interface State {
  nodes: StageNode[]
  edges: StageEdge[]
  dirty: boolean
}

const MAX_UNDO = 50

/**
 * Canvas 状态 hook：nodes/edges CRUD + 脏标记 + 简单撤销栈。
 * `toWire()` 把画布内部表示打回后端 wire 格式。
 */
export function usePipelineGraph(initial: PipelineGraphWire) {
  const [state, setState] = useState<State>(() => ({
    nodes: wireToNodes(initial),
    edges: wireToEdges(initial),
    dirty: false,
  }))
  const undoStack = useRef<Array<{ nodes: StageNode[]; edges: StageEdge[] }>>([])

  const pushHistory = useCallback((snap: { nodes: StageNode[]; edges: StageEdge[] }) => {
    undoStack.current.push(snap)
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift()
  }, [])

  const setNodes = useCallback((next: StageNode[]) => {
    setState(s => ({ ...s, nodes: next, dirty: true }))
  }, [])

  const setEdges = useCallback((next: StageEdge[]) => {
    setState(s => ({ ...s, edges: next, dirty: true }))
  }, [])

  const replaceGraph = useCallback((wire: PipelineGraphWire) => {
    setState(_s => ({ nodes: wireToNodes(wire), edges: wireToEdges(wire), dirty: false }))
    undoStack.current = []
  }, [])

  const updateNodeData = useCallback((id: string, data: Partial<StageFields>) => {
    setState(s => {
      pushHistory({ nodes: s.nodes, edges: s.edges })
      return {
        ...s,
        nodes: s.nodes.map(n => n.id === id ? { ...n, type: data.stageType ?? n.type, data: { ...n.data, ...data } } : n),
        dirty: true,
      }
    })
  }, [pushHistory])

  const updateEdgeCondition = useCallback((id: string, data: ConditionEdgeData | undefined) => {
    setState(s => {
      pushHistory({ nodes: s.nodes, edges: s.edges })
      return {
        ...s,
        edges: s.edges.map(e => e.id === id ? { ...e, data } : e),
        dirty: true,
      }
    })
  }, [pushHistory])

  const undo = useCallback(() => {
    const prev = undoStack.current.pop()
    if (!prev) return
    setState(s => ({ ...s, nodes: prev.nodes, edges: prev.edges, dirty: true }))
  }, [])

  const resetDirty = useCallback(() => setState(s => ({ ...s, dirty: false })), [])

  const toWire = useCallback((): PipelineGraphWire => ({
    nodes: state.nodes.map(n => ({ ...n.data, position: n.position })),
    edges: state.edges.map(e => ({
      id: e.id, source: e.source, target: e.target,
      condition: e.data?.condition,
    })),
  }), [state])

  return {
    nodes: state.nodes, edges: state.edges, dirty: state.dirty,
    setNodes, setEdges, replaceGraph,
    updateNodeData, updateEdgeCondition,
    undo, resetDirty, toWire,
  }
}

function wireToNodes(w: PipelineGraphWire): StageNode[] {
  return w.nodes.map(n => ({
    id: n.id,
    type: n.stageType,
    position: n.position,
    data: { ...n },
  }))
}
function wireToEdges(w: PipelineGraphWire): StageEdge[] {
  return w.edges.map(e => ({
    id: e.id, source: e.source, target: e.target,
    type: 'conditional',
    data: e.condition ? { condition: e.condition } : undefined,
  }))
}
