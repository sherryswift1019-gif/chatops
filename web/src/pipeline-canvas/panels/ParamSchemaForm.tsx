import { Form, Input, InputNumber, Select, Switch } from 'antd'
import type { FormInstance } from 'antd'

interface Props {
  schema: Record<string, unknown>
  form: FormInstance
}

/**
 * 按 JSON Schema (object + properties) 渲染 Ant Design Form.Item 列表。
 * 用于 SchedulesPanel 预设参数输入，配合外部 Form 实例做 validateFields。
 */
export function ParamSchemaForm({ schema }: Props) {
  const properties = getProperties(schema)
  const required = getRequired(schema)

  if (!properties || Object.keys(properties).length === 0) {
    return null
  }

  return (
    <>
      {Object.entries(properties).map(([key, propRaw]) => {
        const prop = propRaw as Record<string, unknown>
        const isRequired = required.includes(key)
        return (
          <Form.Item
            key={key}
            name={key}
            label={(prop.title as string | undefined) ?? key}
            required={isRequired}
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
        min={prop.minimum as number | undefined}
        max={prop.maximum as number | undefined}
      />
    )
  }
  if (t === 'boolean') {
    return <Switch />
  }
  // fallback: string input
  return <Input />
}

function getProperties(schema: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof schema !== 'object' || schema === null) return null
  if ((schema as { type?: unknown }).type !== 'object') return null
  const props = (schema as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return null
  return props as Record<string, unknown>
}

function getRequired(schema: Record<string, unknown>): string[] {
  const req = (schema as { required?: unknown }).required
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === 'string') : []
}
