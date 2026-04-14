import { Form, Input, InputNumber, Select, Switch } from 'antd'
import type { FormInstance } from 'antd'

interface SchemaProperty {
  type: string
  format?: string
  title?: string
  description?: string
  enum?: string[]
  default?: unknown
  items?: { type: string }
  'x-depends-on'?: Record<string, string>
}

interface StageParamsFormProps {
  paramSchema: Record<string, unknown>
  parentFieldName: number
  form: FormInstance
}

export default function StageParamsForm({ paramSchema, parentFieldName, form }: StageParamsFormProps) {
  const properties = (paramSchema?.properties ?? {}) as Record<string, SchemaProperty>
  const required = (paramSchema?.required ?? []) as string[]

  const allParams = Form.useWatch(['stages', parentFieldName, 'params'], form) as Record<string, unknown> | undefined

  return (
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
              <Form.Item name={[parentFieldName, 'params', key]} label={label} rules={rules}>
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
  )
}
