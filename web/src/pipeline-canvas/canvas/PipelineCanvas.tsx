import { ReactFlow, Background, Controls, applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import type { NodeChange, EdgeChange, Connection, OnConnect, Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ulid } from 'ulidx'
import { useCallback } from 'react'
import { nodeTypes } from './nodes/nodeTypes'
import { edgeTypes } from './edges/edgeTypes'
import type { StageNode, StageEdge } from '../types'

interface Props {
  nodes: StageNode[]
  edges: StageEdge[]
  setNodes: (n: StageNode[]) => void
  setEdges: (e: StageEdge[]) => void
  onSelectNode: (id: string | null) => void
  onEdgeClick: (id: string) => void
  /** 检查某节点是否为 switch 类型（由 usePipelineGraph 提供） */
  isSwitch: (nodeId: string) => boolean
  /** 在 edge 增删后同步 switch.params.cases / params.default */
  syncSwitchParams: (switchId: string) => void
}

export function PipelineCanvas({ nodes, edges, setNodes, setEdges, onSelectNode, onEdgeClick, isSwitch, syncSwitchParams }: Props) {
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(applyNodeChanges(changes, nodes) as StageNode[])
  }, [nodes, setNodes])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    // 检测删除类型变更，找出被删 switch 源节点并同步 params
    const removedSwitchSources = new Set<string>()
    for (const ch of changes) {
      if (ch.type === 'remove') {
        const edge = edges.find(e => e.id === ch.id)
        if (edge && isSwitch(edge.source)) {
          removedSwitchSources.add(edge.source)
        }
      }
    }
    const next = applyEdgeChanges(changes, edges) as StageEdge[]
    setEdges(next)
    // 删除后同步（通过 setTimeout 确保 setEdges 先执行）
    if (removedSwitchSources.size > 0) {
      // setEdges 是同步的，但 syncSwitchParams 依赖 setState 更新后的 edges，
      // 所以用 setTimeout 0 推迟到下一 tick 读最新 edges
      setTimeout(() => {
        removedSwitchSources.forEach(syncSwitchParams)
      }, 0)
    }
  }, [edges, setEdges, isSwitch, syncSwitchParams])

  const onConnect: OnConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return
    const isDefault = c.sourceHandle === 'default'

    let next = edges
    // default handle 互斥：拖新 default 边 → 先删旧 default 边
    if (isDefault) {
      next = next.filter(e => !(e.source === c.source && (e.data?.isDefault === true || e.sourceHandle === 'default')))
    }
    const newEdge: StageEdge = {
      id: ulid(),
      source: c.source,
      target: c.target,
      type: 'conditional',
      sourceHandle: c.sourceHandle ?? undefined,
      data: isDefault ? { isDefault: true } : undefined,
    }
    const withNew = addEdge(newEdge, next) as StageEdge[]
    setEdges(withNew)

    // 增 edge 后同步 switch params（setTimeout 确保 setEdges 先执行）
    if (isSwitch(c.source)) {
      setTimeout(() => syncSwitchParams(c.source!), 0)
    }
  }, [edges, setEdges, isSwitch, syncSwitchParams])

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes} edges={edges}
        nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => onSelectNode(n.id)}
        onEdgeClick={(_, e) => onEdgeClick(e.id)}
        onPaneClick={() => onSelectNode(null)}
        fitView
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}
