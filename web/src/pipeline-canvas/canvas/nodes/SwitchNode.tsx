import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Tag } from 'antd'
import type { StageNode } from '../../types'

const handleBase = {
  width: 12, height: 12,
  border: '2px solid #fff',
} as const

export function SwitchNode({ data, selected }: NodeProps<StageNode>) {
  const cases = (data.params as any)?.cases ?? []
  const defaultTarget = (data.params as any)?.default

  return (
    <div style={{
      width: 180, padding: '14px 12px',
      background: '#f9f0ff',
      border: `2px solid ${selected ? '#722ed1' : '#b37feb'}`,
      borderRadius: 8,
      textAlign: 'center',
      position: 'relative',
    }}>
      <Handle type="target" position={Position.Top}
        style={{ ...handleBase, background: '#722ed1' }} />

      <div style={{ fontSize: 18, color: '#722ed1', lineHeight: 1 }}>✦ Switch</div>
      <div style={{ fontWeight: 600, fontSize: 13, marginTop: 4 }}>{data.name}</div>
      <div style={{ marginTop: 6 }}>
        <Tag color="purple">{cases.length} cases</Tag>
        {defaultTarget ? <Tag>default ✓</Tag> : <Tag color="warning">无 default</Tag>}
      </div>

      {/* cases handle：底部居中（拖出 = 创建 case） */}
      <Handle id="cases" type="source" position={Position.Bottom}
        style={{ ...handleBase, left: '40%', background: '#b37feb' }}>
      </Handle>
      <span style={{ position: 'absolute', bottom: -22, left: '30%', fontSize: 10, color: '#722ed1' }}>case</span>

      {/* default handle：底部右侧（拖出 = 设 default） */}
      <Handle id="default" type="source" position={Position.Bottom}
        style={{ ...handleBase, left: '75%', background: '#722ed1', width: 14, height: 14 }} />
      <span style={{ position: 'absolute', bottom: -22, left: '67%', fontSize: 10, color: '#722ed1', fontWeight: 600 }}>default</span>
    </div>
  )
}
