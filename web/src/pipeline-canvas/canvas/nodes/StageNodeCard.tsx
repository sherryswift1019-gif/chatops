import { Handle, Position } from '@xyflow/react'
import { Card, Tag, Button } from 'antd'
import { PlayCircleOutlined } from '@ant-design/icons'
import type { CSSProperties, ReactNode } from 'react'

interface Props {
  color: string
  typeLabel: string
  title: string
  footer?: ReactNode
  onRunHere?: () => void
  dryRunPhase?: 'idle' | 'running' | 'success' | 'failed' | 'awaiting-external'
}

const handleStyle: CSSProperties = {
  width: 18, height: 18,
  border: '3px solid #fff',
  background: '#1677ff',
  boxShadow: '0 0 0 1px #1677ff',
}

const phaseBorders: Record<NonNullable<Props['dryRunPhase']>, string> = {
  idle: '',
  running: '2px solid #1677ff',
  success: '2px solid #52c41a',
  failed: '2px solid #f5222d',
  'awaiting-external': '2px dashed #faad14',
}

export function StageNodeCard({ color, typeLabel, title, footer, onRunHere, dryRunPhase = 'idle' }: Props) {
  const barStyle: CSSProperties = {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: color,
    borderTopLeftRadius: 6, borderBottomLeftRadius: 6,
  }
  const cardStyle: CSSProperties = {
    width: 220, position: 'relative',
    border: phaseBorders[dryRunPhase] || undefined,
    animation: dryRunPhase === 'awaiting-external' ? 'pulse 1.5s infinite' : undefined,
  }
  return (
    <Card size="small" style={cardStyle} styles={{ body: { padding: '8px 12px' } }}>
      <div style={barStyle} />
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Tag color={color}>{typeLabel}</Tag>
        {onRunHere && (
          <Button type="text" size="small" icon={<PlayCircleOutlined />}
            onClick={(e) => { e.stopPropagation(); onRunHere() }}
            title="试运行至此" />
        )}
      </div>
      <div style={{ fontWeight: 500, marginTop: 4 }}>{title || <span style={{ color: '#aaa' }}>未命名</span>}</div>
      {footer && <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{footer}</div>}
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </Card>
  )
}
