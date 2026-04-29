import { Form, Input, InputNumber, Select, Switch, Alert } from 'antd'
import type { FormInstance } from 'antd'

type Schema = Record<string, unknown>

interface Props {
  schema: Schema
  form: FormInstance
}

/**
 * 按 JSON Schema（仅支持 type=object, properties 扁平层）动态渲染表单。
 * 与 CapabilityParamsForm 的区别：使用 antd Form.Item name，
 * 外部可直接调用 form.validateFields() 收集所有字段值。
 */
export function ParamSchemaForm({ schema, form: _form }: Props) {
  const properties = getProperties(schema)
  const required = getRequired(schema)

  if (!properties) {
    return <Alert type="warning" showIcon message="paramSchema 格式不合法（需要 type=object）" />
  }

  const entries = Object.entries(properties)
  if (entries.length === 0) {
    return <Alert type="info" showIcon message="该 Pipeline 未声明触发参数" />
  }

  return (
    <>
      {entries.map(([key, propRaw]) => {
        const prop = propRaw as Record<string, unknown>
        const isRequired = required.includes(key)
        return (
          <Form.Item
            key={key}
            name={key}
            label={(prop.title as string | undefined) ?? key}
            rules={isRequired ? [{ required: true, message: `${key} 必填` }] : []}
            extra={typeof prop.description === 'string' ? prop.description : undefined}
          >
            {renderControl(prop)}
          </Form.Item>
        )
      })}
    </>
  )
}

function renderControl(prop: Record<string, unknown>) {
  const t = prop.type as string | undefined
  const enumVals = prop.enum as unknown[] | undefined

  if (t === 'string' && enumVals) {
    return (
      <Select
        options={enumVals.map(e => ({ value: String(e), label: String(e) }))}
        allowClear
      />
    )
  }
  if (t === 'string') {
    return (
      <Input
        placeholder={typeof prop.description === 'string' ? prop.description : undefined}
      />
    )
  }
  if (t === 'number' || t === 'integer') {
    return (
      <InputNumber
        style={{ width: '100%' }}
        min={prop.minimum as number | undefined}
        max={prop.maximum as number | undefined}
      />
    )
  }
  if (t === 'boolean') {
    return <Switch />
  }
  // 数组/对象/其它：JSON TextArea
  return <Input.TextArea rows={4} style={{ fontFamily: 'monospace', fontSize: 12 }} />
}

function getProperties(schema: Schema): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null
  if ((schema as { type?: unknown }).type !== 'object') return null
  const props = (schema as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return null
  return props as Record<string, unknown>
}

function getRequired(schema: Schema): string[] {
  if (!schema || typeof schema !== 'object') return []
  const req = (schema as { required?: unknown }).required
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === 'string') : []
}
