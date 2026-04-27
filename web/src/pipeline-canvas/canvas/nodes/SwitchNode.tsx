import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Tag, Button } from 'antd'
import { PlayCircleOutlined } from '@ant-design/icons'
import type { CSSProperties } from 'react'
import type { StageNode } from '../../types'

const handleBase = {
  width: 18, height: 18,
  border: '3px solid #fff',
  boxShadow: '0 0 0 1px #722ed1',
} as const

type DryRunPhase = 'idle' | 'running' | 'success' | 'failed' | 'awaiting-external'

const phaseBorders: Record<DryRunPhase, string> = {
  idle: '',
  running: '2px solid #1677ff',
  success: '2px solid #52c41a',
  failed: '2px solid #f5222d',
  'awaiting-external': '2px dashed #faad14',
}

export function SwitchNode({ data, selected }: NodeProps<StageNode>) {
  const cases = (data.params as any)?.cases ?? []
  const defaultTarget = (data.params as any)?.default
  const onRunHere: (() => void) | undefined = (data as any).__onRunHere
  const dryRunPhase: DryRunPhase = (data as any).__dryRunPhase ?? 'idle'

  const divStyle: CSSProperties = {
    width: 200, padding: '14px 12px',
    background: '#f9f0ff',
    border: phaseBorders[dryRunPhase] || `2px solid ${selected ? '#722ed1' : '#b37feb'}`,
    borderRadius: 8,
    textAlign: 'center',
    position: 'relative',
    animation: dryRunPhase === 'awaiting-external' ? 'pulse 1.5s infinite' : undefined,
  }

  return (
    <div style={divStyle}>
      <Handle type="target" position={Position.Top}
        style={{ ...handleBase, background: '#722ed1' }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <div style={{ fontSize: 18, color: '#722ed1', lineHeight: 1 }}>✦ Switch</div>
        {onRunHere && (
          <Button type="text" size="small" icon={<PlayCircleOutlined />}
            onClick={(e) => { e.stopPropagation(); onRunHere() }}
            title="试运行至此" />
        )}
      </div>
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
