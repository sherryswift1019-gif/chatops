import { ReactFlow, Background, Controls, applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react'
import type { NodeChange, EdgeChange, Connection, OnConnect } from '@xyflow/react'
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
}

export function PipelineCanvas({ nodes, edges, setNodes, setEdges, onSelectNode, onEdgeClick }: Props) {
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(applyNodeChanges(changes, nodes) as StageNode[])
  }, [nodes, setNodes])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges(applyEdgeChanges(changes, edges) as StageEdge[])
  }, [edges, setEdges])

  const onConnect: OnConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return
    const newEdge: StageEdge = {
      id: ulid(), source: c.source, target: c.target,
      type: 'conditional',
    }
    setEdges(addEdge(newEdge, edges) as StageEdge[])
  }, [edges, setEdges])

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
