import { useState, useEffect } from 'react'
import { Modal, Tabs, Checkbox, message } from 'antd'
import Editor from '@monaco-editor/react'
import type { DryRunChunk } from './useDryRunSSE'

interface Props {
  chunk: DryRunChunk | null  // type='decision-needed' chunk
  onSubmit: (decision: { decision: 'real' | 'stub' | 'manual'; manualOutput?: Record<string, unknown>; remember: boolean }) => void
  onCancel: () => void
}

export function SideEffectDecisionModal({ chunk, onSubmit, onCancel }: Props) {
  const [activeTab, setActiveTab] = useState<'real' | 'stub' | 'manual'>('real')
  const [remember, setRemember] = useState(false)
  const [manualJson, setManualJson] = useState('{}')

  useEffect(() => {
    if (!chunk) return
    const last = chunk.lastDecision as 'real' | 'stub' | 'manual' | null
    setActiveTab(last ?? 'real')
    setRemember(false)
    const lastManual = chunk.lastManualOutput as Record<string, unknown> | null
    const initial = lastManual ?? (chunk.schemaTemplate as Record<string, unknown> | undefined) ?? {}
    setManualJson(JSON.stringify(initial, null, 2))
  }, [chunk])

  if (!chunk) return null

  function handleOk() {
    if (activeTab === 'real') {
      onSubmit({ decision: 'real', remember })
    } else if (activeTab === 'stub') {
      onSubmit({ decision: 'stub', manualOutput: chunk!.schemaTemplate as Record<string, unknown>, remember })
    } else {
      try {
        const parsed = JSON.parse(manualJson) as Record<string, unknown>
        onSubmit({ decision: 'manual', manualOutput: parsed, remember })
      } catch (e) {
        void message.error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return (
    <Modal
      title={`副作用节点决策：${chunk.nodeId}（${chunk.stageType as string}）`}
      open
      onCancel={onCancel}
      onOk={handleOk}
      width={680}
      okText="确认"
    >
      <Tabs activeKey={activeTab} onChange={(k) => setActiveTab(k as 'real' | 'stub' | 'manual')}>
        <Tabs.TabPane tab="真跑" key="real">
          <div style={{ color: '#666' }}>
            会真实调用该节点的实现（IM API / DB / SSH 等）。慎用。
          </div>
          <pre style={{ background: '#f5f5f5', padding: 12, marginTop: 8, fontSize: 12 }}>
            params: {JSON.stringify(chunk.params, null, 2)}
          </pre>
        </Tabs.TabPane>

        <Tabs.TabPane tab="Stub" key="stub">
          <div style={{ color: '#666' }}>使用 schema 默认值跳过执行（不产生副作用）：</div>
          <pre style={{ background: '#f5f5f5', padding: 12, marginTop: 8, maxHeight: 240, overflow: 'auto' }}>
            {JSON.stringify(chunk.schemaTemplate, null, 2)}
          </pre>
        </Tabs.TabPane>

        <Tabs.TabPane tab="手填" key="manual">
          <Editor
            height="280px"
            defaultLanguage="json"
            value={manualJson}
            onChange={(v) => setManualJson(v ?? '{}')}
            options={{ minimap: { enabled: false }, fontSize: 13 }}
          />
        </Tabs.TabPane>
      </Tabs>

      <Checkbox
        checked={remember}
        onChange={(e) => setRemember(e.target.checked)}
        style={{ marginTop: 12 }}
      >
        记住此节点的选择（下次同节点试跑预选 + 预填）
      </Checkbox>
    </Modal>
  )
}
