import { Form, Input, InputNumber, Select, Switch, Alert } from 'antd'
import { useEffect, useState } from 'react'

type Schema = Record<string, unknown>

interface Props {
  paramSchema: Schema | undefined
  value: Record<string, unknown> | undefined
  onChange: (next: Record<string, unknown>) => void
}

/**
 * 按 JSON Schema（仅支持 type=object, properties 扁平层）动态渲染表单。
 * 复杂类型 fallback 到 JSON TextArea。
 */
export function CapabilityParamsForm({ paramSchema, value, onChange }: Props) {
  const properties = getProperties(paramSchema)
  const required = getRequired(paramSchema)

  // 非 object schema fallback 为整体 JSON TextArea
  if (!properties) {
    return <JsonFallback value={value} onChange={onChange} />
  }

  const entries = Object.entries(properties)
  if (entries.length === 0) {
    return <Alert type="info" showIcon message="该 Capability 未声明参数" />
  }

  return (
    <>
      <div style={{ fontWeight: 500, marginBottom: 8 }}>Capability 参数</div>
      {entries.map(([key, propRaw]) => {
        const prop = propRaw as Record<string, unknown>
        return (
          <Form.Item
            key={key}
            label={(prop.title as string | undefined) ?? key}
            required={required.includes(key)}
            rules={required.includes(key) ? [{ required: true, message: `${key} 必填` }] : []}
            extra={typeof prop.description === 'string' ? prop.description : undefined}
          >
            {renderControl(prop, value?.[key], (next) => onChange({ ...(value ?? {}), [key]: next }))}
          </Form.Item>
        )
      })}
      <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
        字符串字段支持 {'{{vars.xxx}}'}（im_input/webhook 采集的值）、{'{{triggerParams.xxx}}'}（触发参数）
      </div>
    </>
  )
}

function renderControl(
  prop: Record<string, unknown>,
  val: unknown,
  onChange: (v: unknown) => void,
) {
  const t = prop.type as string | undefined
  const enumVals = prop.enum as unknown[] | undefined

  if (t === 'string' && enumVals) {
    return (
      <Select
        value={val as string | undefined}
        onChange={onChange}
        options={enumVals.map(e => ({ value: String(e), label: String(e) }))}
        allowClear
      />
    )
  }
  if (t === 'string') {
    return (
      <Input
        value={val as string | undefined}
        onChange={e => onChange(e.target.value)}
        placeholder={typeof prop.description === 'string' ? prop.description : undefined}
      />
    )
  }
  if (t === 'number' || t === 'integer') {
    return (
      <InputNumber
        value={val as number | undefined}
        onChange={v => onChange(v)}
        min={prop.minimum as number | undefined}
        max={prop.maximum as number | undefined}
      />
    )
  }
  if (t === 'boolean') {
    return <Switch checked={!!val} onChange={onChange} />
  }
  // 数组/对象/其它：JSON TextArea
  return <JsonField value={val} onChange={onChange} />
}

function JsonField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2))
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setText(JSON.stringify(value ?? null, null, 2))
  }, [value])
  return (
    <>
      <Input.TextArea
        rows={4}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => {
          try {
            onChange(JSON.parse(text))
            setErr(null)
          } catch (e) {
            setErr((e as Error).message)
          }
        }}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      {err && <Alert type="error" showIcon style={{ marginTop: 4 }} message={err} />}
    </>
  )
}

function JsonFallback({
  value,
  onChange,
}: {
  value: Record<string, unknown> | undefined
  onChange: (v: Record<string, unknown>) => void
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2))
  const [err, setErr] = useState<string | null>(null)
  return (
    <Form.Item label="capabilityParams (JSON)">
      <Input.TextArea
        rows={8}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => {
          try {
            const parsed = JSON.parse(text)
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              throw new Error('capabilityParams 必须是 object')
            }
            onChange(parsed)
            setErr(null)
          } catch (e) {
            setErr((e as Error).message)
          }
        }}
        style={{ fontFamily: 'monospace', fontSize: 12 }}
      />
      {err && <Alert type="error" showIcon style={{ marginTop: 4 }} message={err} />}
    </Form.Item>
  )
}

function getProperties(schema: Schema | undefined): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null
  if ((schema as { type?: unknown }).type !== 'object') return null
  const props = (schema as { properties?: unknown }).properties
  if (typeof props !== 'object' || props === null) return null
  return props as Record<string, unknown>
}

function getRequired(schema: Schema | undefined): string[] {
  if (!schema || typeof schema !== 'object') return []
  const req = (schema as { required?: unknown }).required
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === 'string') : []
}
