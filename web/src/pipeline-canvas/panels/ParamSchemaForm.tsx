import type { ReactNode } from 'react'
import { Form, Input, Select, Switch, InputNumber } from 'antd'

interface SchemaProperty {
  type?: string
  enum?: string[]
  title?: string
  description?: string
}

interface JsonSchema {
  properties?: Record<string, SchemaProperty>
  required?: string[]
}

interface Props {
  schema: JsonSchema
  /** antd Form instance, passed in by the caller for external submit */
  form: ReturnType<typeof Form.useForm>[0]
  initialValues?: Record<string, unknown>
}

export function ParamSchemaForm({ schema, form, initialValues }: Props) {
  const props = schema.properties ?? {}
  const required = schema.required ?? []

  return (
    <Form form={form} layout="vertical" initialValues={initialValues}>
      {Object.entries(props).map(([key, prop]) => {
        const isRequired = required.includes(key)
        const label = prop.title ?? key
        const rules = isRequired ? [{ required: true, message: `请填写 ${label}` }] : []

        let input: ReactNode
        if (prop.enum) {
          input = (
            <Select showSearch options={prop.enum.map(v => ({ value: v, label: v }))} />
          )
        } else if (prop.type === 'boolean') {
          input = <Switch />
        } else if (prop.type === 'number' || prop.type === 'integer') {
          input = <InputNumber style={{ width: '100%' }} />
        } else {
          input = <Input />
        }

        return (
          <Form.Item
            key={key}
            name={key}
            label={label}
            rules={rules}
            tooltip={prop.description}
            valuePropName={prop.type === 'boolean' ? 'checked' : 'value'}
          >
            {input}
          </Form.Item>
        )
      })}
    </Form>
  )
}
