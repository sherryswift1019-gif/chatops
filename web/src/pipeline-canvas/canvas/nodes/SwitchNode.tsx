import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Tag } from 'antd'
import type { StageNode } from '../../types'

export function SwitchNode({ data, selected }: NodeProps<StageNode>) {
  const cases = (data.params as any)?.cases ?? []
  const defaultTarget = (data.params as any)?.default

  return (
    <div style={{
      width: 160, padding: 12,
      background: '#f9f0ff',
      border: `2px solid ${selected ? '#722ed1' : '#b37feb'}`,
      clipPath: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)',  // 菱形
      textAlign: 'center',
    }}>
      <Handle type="target" position={Position.Top} />
      <div style={{ fontSize: 18, color: '#722ed1' }}>✦</div>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{data.name}</div>
      <Tag color="purple">{cases.length} cases</Tag>
      {defaultTarget ? <Tag>default ✓</Tag> : <Tag color="warning">无 default</Tag>}

      {/* cases handle：底部居中 */}
      <Handle id="cases" type="source" position={Position.Bottom}
        style={{ left: '50%', background: '#b37feb' }} />
      {/* default handle：底部右侧（紫色高亮，可见 label） */}
      <Handle id="default" type="source" position={Position.Bottom}
        style={{ left: '85%', background: '#722ed1', width: 12, height: 12 }} />
    </div>
  )
}
