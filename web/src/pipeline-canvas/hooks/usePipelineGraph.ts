import { useState, useCallback, useRef } from 'react'
import type { StageNode, StageEdge, PipelineGraphWire, StageFields, ConditionEdgeData } from '../types'
import { wireToNodes, wireToEdges } from '../graph-transforms'

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

  /** 检查某 id 是否为 switch 节点 */
  const isSwitch = useCallback((nodeId: string): boolean => {
    return state.nodes.find(n => n.id === nodeId)?.data.stageType === 'switch'
  }, [state.nodes])

  /**
   * 同步 switch 节点的 params.cases + params.default，
   * 从当前 edges 状态中推导（edges 是 cases 的视觉呈现，params 是数据源）。
   */
  const syncSwitchParams = useCallback((switchId: string) => {
    setState(s => {
      const switchEdges = s.edges.filter(e => e.source === switchId)
      const cases: Array<{ when: string; target: string }> = []
      let defaultTarget: string | undefined

      const switchNode = s.nodes.find(n => n.id === switchId)
      const existingCases = ((switchNode?.data.params as any)?.cases ?? []) as Array<{ when: string; target: string }>

      for (const e of switchEdges) {
        if (e.data?.isDefault || e.sourceHandle === 'default') {
          defaultTarget = e.target
        } else {
          // 复用已有 when（若没有则空串）
          const existing = existingCases.find((c) => c.target === e.target)
          cases.push({ when: existing?.when ?? '', target: e.target })
        }
      }

      return {
        ...s,
        nodes: s.nodes.map(n => n.id === switchId
          ? { ...n, data: { ...n.data, params: { ...(n.data.params as any), cases, default: defaultTarget } } }
          : n),
        dirty: true,
      }
    })
  }, [])

  /**
   * 移动 switch 节点 cases 数组的某个 case，并同步重排 edges 顺序。
   * fromIdx: 当前位置，toIdx: 目标位置（由 EdgeConditionPopover 上移/下移按钮调用）。
   */
  const moveCase = useCallback((switchId: string, fromIdx: number, toIdx: number) => {
    setState(s => {
      const switchNode = s.nodes.find(n => n.id === switchId)
      if (!switchNode) return s
      const cases = [...(((switchNode.data.params as any)?.cases ?? []) as Array<{ when: string; target: string }>)]
      if (toIdx < 0 || toIdx >= cases.length) return s

      // Swap cases array
      const [moved] = cases.splice(fromIdx, 1)
      cases.splice(toIdx, 0, moved)

      const newNodes = s.nodes.map(n => n.id === switchId
        ? { ...n, data: { ...n.data, params: { ...(n.data.params as any), cases } } }
        : n)

      // Reorder edges: keep non-switch-case edges in place, reorder case edges to match cases array
      const caseEdges = s.edges.filter(e => e.source === switchId && !e.data?.isDefault && e.sourceHandle !== 'default')
      const otherEdges = s.edges.filter(e => !(e.source === switchId && !e.data?.isDefault && e.sourceHandle !== 'default'))

      // Reorder caseEdges to match cases array order
      const reorderedCaseEdges = cases
        .map(c => caseEdges.find(e => e.target === c.target))
        .filter((e): e is StageEdge => e !== undefined)

      // Append any caseEdges not found in cases (safety fallback)
      const usedIds = new Set(reorderedCaseEdges.map(e => e.id))
      const remainingEdges = caseEdges.filter(e => !usedIds.has(e.id))

      const newEdges = [...otherEdges, ...reorderedCaseEdges, ...remainingEdges]

      return { ...s, nodes: newNodes, edges: newEdges, dirty: true }
    })
  }, [])

  /**
   * 删除一条 edge：从 edges 列表移除；若 source 是 switch 节点，
   * 同步重算 params.cases / params.default（与 React Flow onEdgesChange 删除路径一致）。
   */
  const deleteEdge = useCallback((edgeId: string) => {
    setState(s => {
      const edge = s.edges.find(e => e.id === edgeId)
      if (!edge) return s
      pushHistory({ nodes: s.nodes, edges: s.edges })
      const nextEdges = s.edges.filter(e => e.id !== edgeId)
      const sourceIsSwitch = s.nodes.find(n => n.id === edge.source)?.data.stageType === 'switch'
      const next = { ...s, edges: nextEdges, dirty: true }
      if (sourceIsSwitch) {
        // 直接在这里复算，避免依赖外部 setTimeout
        const switchEdges = nextEdges.filter(e => e.source === edge.source)
        const cases: Array<{ when: string; target: string }> = []
        let defaultTarget: string | undefined
        const switchNode = s.nodes.find(n => n.id === edge.source)
        const existingCases = ((switchNode?.data.params as any)?.cases ?? []) as Array<{ when: string; target: string }>
        for (const e of switchEdges) {
          if (e.data?.isDefault || e.sourceHandle === 'default') {
            defaultTarget = e.target
          } else {
            const existing = existingCases.find(c => c.target === e.target)
            cases.push({ when: existing?.when ?? '', target: e.target })
          }
        }
        next.nodes = s.nodes.map(n => n.id === edge.source
          ? { ...n, data: { ...n.data, params: { ...(n.data.params as any), cases, default: defaultTarget } } }
          : n)
      }
      return next
    })
  }, [pushHistory])

  /**
   * 删除一个节点：移除节点本身 + 所有以该节点为 source/target 的 edges；
   * 对受影响的 switch 节点重新同步 params.cases / params.default。
   */
  const deleteNode = useCallback((nodeId: string) => {
    setState(s => {
      const node = s.nodes.find(n => n.id === nodeId)
      if (!node) return s
      pushHistory({ nodes: s.nodes, edges: s.edges })

      const removedEdges = s.edges.filter(e => e.source === nodeId || e.target === nodeId)
      const nextEdges = s.edges.filter(e => e.source !== nodeId && e.target !== nodeId)
      const nextNodes = s.nodes.filter(n => n.id !== nodeId)

      // 收集需要 resync 的 switch source（只看 target 端被删除的边的 source）
      const affectedSwitches = new Set<string>()
      for (const e of removedEdges) {
        if (e.target === nodeId && e.source !== nodeId) {
          const src = nextNodes.find(n => n.id === e.source)
          if (src?.data.stageType === 'switch') affectedSwitches.add(e.source)
        }
      }

      let syncedNodes = nextNodes
      for (const switchId of affectedSwitches) {
        const switchEdges = nextEdges.filter(e => e.source === switchId)
        const cases: Array<{ when: string; target: string }> = []
        let defaultTarget: string | undefined
        const switchNode = s.nodes.find(n => n.id === switchId)
        const existingCases = ((switchNode?.data.params as any)?.cases ?? []) as Array<{ when: string; target: string }>
        for (const e of switchEdges) {
          if (e.data?.isDefault || e.sourceHandle === 'default') {
            defaultTarget = e.target
          } else {
            const existing = existingCases.find(c => c.target === e.target)
            cases.push({ when: existing?.when ?? '', target: e.target })
          }
        }
        syncedNodes = syncedNodes.map(n => n.id === switchId
          ? { ...n, data: { ...n.data, params: { ...(n.data.params as any), cases, default: defaultTarget } } }
          : n)
      }

      return { ...s, nodes: syncedNodes, edges: nextEdges, dirty: true }
    })
  }, [pushHistory])

  /**
   * 写回某条 switch case 的 when 表达式。
   */
  const updateSwitchCaseWhen = useCallback((switchId: string, caseIdx: number, when: string) => {
    setState(s => {
      const switchNode = s.nodes.find(n => n.id === switchId)
      if (!switchNode) return s
      const cases = [...(((switchNode.data.params as any)?.cases ?? []) as Array<{ when: string; target: string }>)]
      if (caseIdx < 0 || caseIdx >= cases.length) return s
      cases[caseIdx] = { ...cases[caseIdx], when }
      return {
        ...s,
        nodes: s.nodes.map(n => n.id === switchId
          ? { ...n, data: { ...n.data, params: { ...(n.data.params as any), cases } } }
          : n),
        dirty: true,
      }
    })
  }, [])

  const toWire = useCallback((): PipelineGraphWire => ({
    nodes: state.nodes.map(n => ({ ...n.data, position: n.position })),
    edges: state.edges.map(e => ({
      id: e.id, source: e.source, target: e.target,
      condition: e.data?.condition,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    })),
  }), [state])

  return {
    nodes: state.nodes, edges: state.edges, dirty: state.dirty,
    setNodes, setEdges, replaceGraph,
    updateNodeData, updateEdgeCondition,
    isSwitch, syncSwitchParams, moveCase, updateSwitchCaseWhen,
    deleteEdge, deleteNode,
    undo, resetDirty, toWire,
  }
}
