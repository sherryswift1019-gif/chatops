import { Handle, Position } from '@xyflow/react'
import { Card, Tag } from 'antd'
import type { CSSProperties, ReactNode } from 'react'

interface Props {
  color: string
  typeLabel: string
  title: string
  footer?: ReactNode
}
export function StageNodeCard({ color, typeLabel, title, footer }: Props) {
  const barStyle: CSSProperties = {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: color,
    borderTopLeftRadius: 6, borderBottomLeftRadius: 6,
  }
  return (
    <Card size="small" style={{ width: 220, position: 'relative' }} styles={{ body: { padding: '8px 12px' } }}>
      <div style={barStyle} />
      <Handle type="target" position={Position.Top} />
      <Tag color={color}>{typeLabel}</Tag>
      <div style={{ fontWeight: 500, marginTop: 4 }}>{title || <span style={{ color: '#aaa' }}>未命名</span>}</div>
      {footer && <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{footer}</div>}
      <Handle type="source" position={Position.Bottom} />
    </Card>
  )
}
