import { useState } from 'react'
import { Modal, Input, Button, message } from 'antd'
import { generateCommands } from '../api/ai'

interface AiCommandModalProps {
  open: boolean
  capabilityName: string
  targetRoles: string[]
  onConfirm: (commands: string) => void
  onCancel: () => void
}

export default function AiCommandModal({ open, capabilityName, targetRoles, onConfirm, onCancel }: AiCommandModalProps) {
  const [intent, setIntent] = useState('')
  const [result, setResult] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleGenerate() {
    if (!intent.trim()) { message.warning('请输入意图描述'); return }
    setLoading(true)
    try {
      const { commands } = await generateCommands({ intent: intent.trim(), capabilityName, targetRoles })
      setResult(commands)
    } catch {
      message.error('AI 生成失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  function handleConfirm() {
    onConfirm(result)
    setIntent('')
    setResult('')
  }

  function handleCancel() {
    onCancel()
    setIntent('')
    setResult('')
  }

  return (
    <Modal
      title="AI 生成命令"
      open={open}
      onCancel={handleCancel}
      footer={null}
      width={600}
      destroyOnClose
    >
      <div style={{ marginBottom: 12 }}>
        <div style={{ marginBottom: 4, fontSize: 13, color: '#666' }}>描述你想要执行的操作：</div>
        <Input.TextArea
          rows={2}
          value={intent}
          onChange={e => setIntent(e.target.value)}
          placeholder="如：停止 nginx 服务，清理 /var/log/nginx 下超过 7 天的日志"
          onPressEnter={e => { if (e.ctrlKey) handleGenerate() }}
        />
        <Button type="primary" loading={loading} onClick={handleGenerate} style={{ marginTop: 8 }}>
          生成命令
        </Button>
      </div>
      {result && (
        <div>
          <div style={{ marginBottom: 4, fontSize: 13, color: '#666' }}>生成结果（可编辑）：</div>
          <Input.TextArea
            rows={6}
            value={result}
            onChange={e => setResult(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          <Button type="primary" onClick={handleConfirm} style={{ marginTop: 8 }}>
            确认填入
          </Button>
        </div>
      )}
    </Modal>
  )
}
