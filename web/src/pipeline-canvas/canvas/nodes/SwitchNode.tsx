import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Tag } from 'antd'
import type { StageNode } from '../../types'

const handleBase = {
  width: 18, height: 18,
  border: '3px solid #fff',
  boxShadow: '0 0 0 1px #722ed1',
} as const

export function SwitchNode({ data, selected }: NodeProps<StageNode>) {
  const cases = (data.params as any)?.cases ?? []
  const defaultTarget = (data.params as any)?.default

  return (
    <div style={{
      width: 200, padding: '14px 12px',
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
        style={{ ...handleBase, left: '35%', background: '#b37feb' }} />
      <span style={{ position: 'absolute', bottom: -28, left: '25%', fontSize: 11, color: '#722ed1' }}>case</span>

      {/* default handle：底部右侧（拖出 = 设 default） */}
      <Handle id="default" type="source" position={Position.Bottom}
        style={{ ...handleBase, left: '75%', background: '#722ed1' }} />
      <span style={{ position: 'absolute', bottom: -28, left: '65%', fontSize: 11, color: '#722ed1', fontWeight: 600 }}>default</span>
    </div>
  )
}
