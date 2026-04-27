import { useState, useEffect } from 'react'
import { Modal, Tabs, Table, Button, message } from 'antd'
import Editor from '@monaco-editor/react'
import { listRecentTriggerParams, type RecentTriggerParam } from '../../api/dryrun'

interface Props {
  open: boolean
  pipelineId: number
  pipelineDefaultTriggerParams?: Record<string, unknown>
  onCancel: () => void
  onConfirm: (payload: { triggerParams: Record<string, unknown>; triggerType: string }) => void
}

export function DryRunStartModal(p: Props) {
  const [activeTab, setActiveTab] = useState<'default' | 'history' | 'custom'>('default')
  const [history, setHistory] = useState<RecentTriggerParam[]>([])
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [customJson, setCustomJson] = useState('{}')
  const [customError, setCustomError] = useState<string | null>(null)

  useEffect(() => {
    if (p.open && activeTab === 'history') {
      listRecentTriggerParams(p.pipelineId).then(setHistory).catch(() => {})
    }
  }, [p.open, activeTab, p.pipelineId])

  function handleOk() {
    if (activeTab === 'default') {
      if (!p.pipelineDefaultTriggerParams) {
        message.warning('该流水线尚未配置默认 triggerParams，请使用其它 Tab')
        return
      }
      p.onConfirm({ triggerParams: p.pipelineDefaultTriggerParams, triggerType: 'manual' })
    } else if (activeTab === 'history') {
      const sel = history.find(h => h.runId === selectedRunId)
      if (!sel) { message.warning('请选择一条历史记录'); return }
      p.onConfirm({ triggerParams: sel.triggerParams, triggerType: sel.triggerType })
    } else {
      try {
        const parsed = JSON.parse(customJson)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setCustomError('triggerParams 必须是 JSON 对象')
          return
        }
        p.onConfirm({ triggerParams: parsed, triggerType: 'manual' })
      } catch (e) {
        setCustomError(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return (
    <Modal
      title="试运行启动"
      open={p.open}
      onCancel={p.onCancel}
      onOk={handleOk}
      width={720}
      okText="开始试运行"
    >
      <Tabs activeKey={activeTab} onChange={(k) => setActiveTab(k as 'default' | 'history' | 'custom')}>
        <Tabs.TabPane tab="默认" key="default">
          {p.pipelineDefaultTriggerParams ? (
            <pre style={{ background: '#f5f5f5', padding: 12, maxHeight: 320, overflow: 'auto' }}>
              {JSON.stringify(p.pipelineDefaultTriggerParams, null, 2)}
            </pre>
          ) : (
            <div style={{ color: '#999' }}>该流水线尚未配置默认 triggerParams</div>
          )}
        </Tabs.TabPane>

        <Tabs.TabPane tab="历史回放" key="history">
          <Table
            rowKey="runId"
            dataSource={history}
            size="small"
            rowSelection={{
              type: 'radio',
              selectedRowKeys: selectedRunId ? [selectedRunId] : [],
              onChange: (keys) => setSelectedRunId(keys[0] as number),
            }}
            columns={[
              { title: '时间', dataIndex: 'startedAt', render: (v) => new Date(v).toLocaleString() },
              { title: '触发源', dataIndex: 'triggerType' },
              { title: '触发人', dataIndex: 'triggeredBy' },
              { title: '状态', dataIndex: 'status' },
              {
                title: 'triggerParams 摘要',
                dataIndex: 'triggerParams',
                render: (v) => <code style={{ fontSize: 11 }}>{JSON.stringify(v).slice(0, 100)}</code>,
              },
            ]}
            pagination={false}
            scroll={{ y: 320 }}
          />
        </Tabs.TabPane>

        <Tabs.TabPane tab="自定义 JSON" key="custom">
          <Editor
            height="320px"
            defaultLanguage="json"
            value={customJson}
            onChange={(v) => { setCustomJson(v ?? '{}'); setCustomError(null) }}
            options={{ minimap: { enabled: false }, fontSize: 13 }}
          />
          {customError && <div style={{ color: 'red', marginTop: 4 }}>{customError}</div>}
        </Tabs.TabPane>
      </Tabs>
    </Modal>
  )
}
