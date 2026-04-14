import { useState } from 'react'
import { Form, Input, InputNumber, Select, Switch, Button } from 'antd'
import type { FormInstance } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import AiCommandModal from './AiCommandModal'

interface SchemaProperty {
  type: string
  format?: string
  title?: string
  description?: string
  enum?: string[]
  default?: unknown
  items?: { type: string }
  'x-depends-on'?: Record<string, string>
  'x-ai-assist'?: boolean
}

interface StageParamsFormProps {
  paramSchema: Record<string, unknown>
  parentFieldName: number
  form: FormInstance
  capabilityName?: string
  targetRoles?: string[]
}

export default function StageParamsForm({ paramSchema, parentFieldName, form, capabilityName, targetRoles }: StageParamsFormProps) {
  const properties = (paramSchema?.properties ?? {}) as Record<string, SchemaProperty>
  const required = (paramSchema?.required ?? []) as string[]
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [aiTargetField, setAiTargetField] = useState('')

  const allParams = Form.useWatch(['stages', parentFieldName, 'params'], form) as Record<string, unknown> | undefined

  function openAiModal(fieldKey: string) {
    setAiTargetField(fieldKey)
    setAiModalOpen(true)
  }

  function handleAiConfirm(commands: string) {
    form.setFieldValue(['stages', parentFieldName, 'params', aiTargetField], commands)
    setAiModalOpen(false)
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {Object.entries(properties).map(([key, prop]) => {
          if (prop['x-depends-on']) {
            const deps = prop['x-depends-on']
            for (const [depKey, depValue] of Object.entries(deps)) {
              if (allParams?.[depKey] !== depValue) return null
            }
          }

          const isRequired = required.includes(key)
          const label = prop.title ?? key
          const rules = isRequired ? [{ required: true, message: `请输入${label}` }] : []

          if (prop.type === 'array' && prop.items?.type === 'string') {
            return (
              <div key={key} style={{ flex: '1 1 250px', minWidth: 200 }}>
                <Form.Item name={[parentFieldName, 'params', key]} label={label} rules={rules}>
                  <Select mode="tags" tokenSeparators={[',']} placeholder="输入后回车添加" />
                </Form.Item>
              </div>
            )
          }

          if (prop.enum) {
            return (
              <div key={key} style={{ minWidth: 130 }}>
                <Form.Item name={[parentFieldName, 'params', key]} label={label} rules={rules}
                  initialValue={prop.default}>
                  <Select options={prop.enum.map(v => ({ value: v, label: v }))} style={{ width: '100%' }} />
                </Form.Item>
              </div>
            )
          }

          if (prop.type === 'boolean') {
            return (
              <div key={key} style={{ minWidth: 100 }}>
                <Form.Item name={[parentFieldName, 'params', key]} label={label}
                  valuePropName="checked" initialValue={prop.default}>
                  <Switch />
                </Form.Item>
              </div>
            )
          }

          if (prop.type === 'integer' || prop.type === 'number') {
            return (
              <div key={key} style={{ minWidth: 100 }}>
                <Form.Item name={[parentFieldName, 'params', key]} label={label} rules={rules}
                  initialValue={prop.default}>
                  <InputNumber style={{ width: '100%' }} />
                </Form.Item>
              </div>
            )
          }

          if (prop.format === 'textarea') {
            return (
              <div key={key} style={{ flex: '1 1 100%', minWidth: 300 }}>
                <Form.Item name={[parentFieldName, 'params', key]} label={
                  <span>{label} {prop['x-ai-assist'] && (
                    <Button type="link" size="small" icon={<RobotOutlined />} onClick={() => openAiModal(key)}>
                      AI 生成
                    </Button>
                  )}</span>
                } rules={rules}>
                  <Input.TextArea rows={3} placeholder={prop.description} style={{ fontFamily: 'monospace', fontSize: 12 }} />
                </Form.Item>
              </div>
            )
          }

          return (
            <div key={key} style={{ flex: '1 1 200px', minWidth: 150 }}>
              <Form.Item name={[parentFieldName, 'params', key]} label={label} rules={rules}>
                <Input placeholder={prop.description} />
              </Form.Item>
            </div>
          )
        })}
      </div>
      <AiCommandModal
        open={aiModalOpen}
        capabilityName={capabilityName ?? ''}
        targetRoles={targetRoles ?? []}
        onConfirm={handleAiConfirm}
        onCancel={() => setAiModalOpen(false)}
      />
    </>
  )
}
