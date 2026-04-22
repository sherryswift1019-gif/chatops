import type { NodeProps } from '@xyflow/react'
import type { StageNode } from '../../types'
import { StageNodeCard } from './StageNodeCard'

export function ScriptNode({ data }: NodeProps<StageNode>) {
  const preview = (data.script ?? '').split('\n')[0].slice(0, 40)
  return <StageNodeCard color="#1677ff" typeLabel="运行脚本" title={data.name} footer={preview || '无脚本'} />
}
