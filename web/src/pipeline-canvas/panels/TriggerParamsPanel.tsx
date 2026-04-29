import { useState } from 'react'
import { Button, Input, Space, Typography, message } from 'antd'
import axios from 'axios'

interface Props {
  pipelineId: number
  paramSchema: Record<string, unknown> | null
  imPrompt: string | null
  onSaved: (paramSchema: Record<string, unknown> | null, imPrompt: string | null) => void
}

export function TriggerParamsPanel({ pipelineId, paramSchema, imPrompt, onSaved }: Props) {
  const [schemaText, setSchemaText] = useState(
    paramSchema ? JSON.stringify(paramSchema, null, 2) : ''
  )
  const [prompt, setPrompt] = useState(imPrompt ?? '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    let schema: Record<string, unknown> | null = null
    if (schemaText.trim()) {
      try { schema = JSON.parse(schemaText) }
      catch { void message.error('paramSchema JSON 格式有误'); return }
    }
    setSaving(true)
    try {
      await axios.put(`/admin/test-pipelines/${pipelineId}/settings`, {
        paramSchema: schema,
        imPrompt: prompt.trim() || null,
      })
      onSaved(schema, prompt.trim() || null)
      void message.success('已保存')
    } catch {
      void message.error('保存失败')
    } finally { setSaving(false) }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        触发参数 Schema（JSON Schema 格式）。空白表示此流水线无需参数采集。
      </Typography.Text>
      <Input.TextArea
        rows={10}
        value={schemaText}
        onChange={e => setSchemaText(e.target.value)}
        placeholder={'{\n  "properties": { "env": { "title": "环境", "enum": ["dev","prod"] } },\n  "required": ["env"]\n}'}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      <Typography.Text>IM 引导语（可选）</Typography.Text>
      <Input
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        placeholder="留空则自动从 Schema 生成"
      />
      <Button type="primary" loading={saving} onClick={handleSave}>保存</Button>
    </Space>
  )
}
