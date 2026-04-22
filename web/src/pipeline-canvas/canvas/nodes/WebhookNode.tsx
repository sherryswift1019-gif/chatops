import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { StageNodeCard } from './StageNodeCard'

export function WebhookNode({ data }: NodeProps<StageNode>) {
  return <StageNodeCard color="#8c8c8c" typeLabel="等待 Webhook" title={data.name}
    footer={data.webhookTag ? `tag: ${data.webhookTag}` : '未设置 tag'} />
}
