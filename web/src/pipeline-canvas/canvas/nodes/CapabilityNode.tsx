import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { StageNodeCard } from './StageNodeCard'

export function CapabilityNode({ data }: NodeProps<StageNode>) {
  return <StageNodeCard color="#722ed1" typeLabel="Agent Capability" title={data.name}
    footer={data.capabilityKey || '未选择'} />
}
