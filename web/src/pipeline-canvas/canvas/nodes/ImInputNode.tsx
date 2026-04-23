import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { StageNodeCard } from './StageNodeCard'

export function ImInputNode({ data }: NodeProps<StageNode>) {
  const cfg = data.imInputConfig
  const requiredCount = Array.isArray((cfg?.paramSchema as { required?: unknown })?.required)
    ? ((cfg?.paramSchema as { required?: unknown[] }).required!).length
    : 0
  const footer = cfg?.prompt
    ? `采集 ${requiredCount} 个参数`
    : '未配置'
  return (
    <StageNodeCard color="#13c2c2" typeLabel="IM 参数采集" title={data.name} footer={footer} />
  )
}
