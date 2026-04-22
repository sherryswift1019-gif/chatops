import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { StageNodeCard } from './StageNodeCard'

export function ApprovalNode({ data }: NodeProps<StageNode>) {
  const count = (data.approverIds ?? []).length
  return <StageNodeCard color="#faad14" typeLabel="人员审批" title={data.name}
    footer={`${count} 位审批人`} />
}
