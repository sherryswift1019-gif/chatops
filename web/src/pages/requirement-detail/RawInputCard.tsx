import { useState } from 'react'
import { Button, Typography } from 'antd'

const { Text } = Typography

interface Props {
  rawInput: string
}

export function RawInputCard({ rawInput }: Props) {
  const [expanded, setExpanded] = useState(false)
  const isShort = rawInput.length <= 100
  const showExpand = !isShort && !expanded

  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid #EEF0F4',
      borderRadius: 8,
      padding: 16,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text strong style={{ fontSize: 14 }}>原始输入</Text>
        {!isShort && (
          <Button type="link" size="small" onClick={() => setExpanded(e => !e)} style={{ padding: 0 }}>
            {expanded ? '折叠' : '展开'}
          </Button>
        )}
      </div>
      <div
        style={{
          fontSize: 13,
          color: '#1A1F2E',
          background: '#F6F7FA',
          padding: '8px 12px',
          borderRadius: 6,
          whiteSpace: 'pre-wrap',
          maxHeight: showExpand ? 80 : undefined,
          overflow: showExpand ? 'hidden' : undefined,
          position: 'relative',
        }}
      >
        {rawInput}
        {showExpand && (
          <div style={{
            position: 'absolute',
            bottom: 0, left: 0, right: 0,
            height: 24,
            background: 'linear-gradient(to bottom, transparent, #F6F7FA)',
            pointerEvents: 'none',
          }} />
        )}
      </div>
    </div>
  )
}
