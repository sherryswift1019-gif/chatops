import { useEffect, useState } from 'react'
import { Card, Tabs, Form, Input, Button, message, Spin } from 'antd'
import { getSystemConfig, updateSystemConfig } from '../api/system-config'
import type { SystemConfigEntry } from '../types'

const CONFIG_SCHEMA: Record<string, { label: string; fields: { name: string; label: string; secret?: boolean }[] }> = {
  dingtalk: {
    label: '钉钉配置',
    fields: [
      { name: 'clientId', label: 'Client ID' },
      { name: 'clientSecret', label: 'Client Secret', secret: true },
    ],
  },
  gitlab: {
    label: 'GitLab 配置',
    fields: [
      { name: 'url', label: 'GitLab URL' },
      { name: 'token', label: 'Private Token', secret: true },
    ],
  },
  harbor: {
    label: 'Harbor 配置',
    fields: [
      { name: 'url', label: 'Harbor URL' },
      { name: 'username', label: '用户名' },
      { name: 'password', label: '密码', secret: true },
      { name: 'skipTlsVerify', label: '跳过证书验证 (自签名证书设为 true)' },
      { name: 'caCert', label: 'CA 证书 (PEM 格式，可选)' },
    ],
  },
  kubernetes: {
    label: 'Kubernetes 配置',
    fields: [
      { name: 'apiServer', label: 'API Server 地址' },
      { name: 'token', label: 'Bearer Token', secret: true },
      { name: 'caCert', label: 'CA 证书 (Base64)' },
      { name: 'kubeconfig', label: 'Kubeconfig (Base64)' },
    ],
  },
  claude: {
    label: 'Claude 配置',
    fields: [
      { name: 'apiKey', label: 'API Key', secret: true },
      { name: 'model', label: '模型' },
    ],
  },
}

export default function SystemConfigPage() {
  const [configs, setConfigs] = useState<Record<string, Record<string, unknown>>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    loadConfigs()
  }, [])

  async function loadConfigs() {
    setLoading(true)
    try {
      const data: SystemConfigEntry[] = await getSystemConfig()
      const map: Record<string, Record<string, unknown>> = {}
      for (const entry of data) {
        map[entry.key] = entry.value
      }
      setConfigs(map)
    } finally {
      setLoading(false)
    }
  }

  async function handleSave(key: string, values: Record<string, string>) {
    setSaving(key)
    try {
      // Only send non-empty values
      const payload: Record<string, string> = {}
      for (const [k, v] of Object.entries(values)) {
        if (v && v.trim()) payload[k] = v.trim()
      }
      if (Object.keys(payload).length === 0) {
        message.warning('没有需要保存的内容')
        return
      }
      await updateSystemConfig(key, payload)
      message.success('保存成功')
      await loadConfigs()
    } catch {
      message.error('保存失败')
    } finally {
      setSaving(null)
    }
  }

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '100px auto' }} />

  const tabItems = Object.entries(CONFIG_SCHEMA).map(([key, schema]) => ({
    key,
    label: schema.label,
    children: (
      <ConfigForm
        configKey={key}
        schema={schema}
        values={configs[key] ?? {}}
        saving={saving === key}
        onSave={(values) => handleSave(key, values)}
      />
    ),
  }))

  return (
    <Card title="系统配置">
      <Tabs items={tabItems} />
    </Card>
  )
}

function ConfigForm({ configKey: _configKey, schema, values, saving, onSave }: {
  configKey: string
  schema: { fields: { name: string; label: string; secret?: boolean }[] }
  values: Record<string, unknown>
  saving: boolean
  onSave: (values: Record<string, string>) => void
}) {
  const [form] = Form.useForm()

  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 500 }} onFinish={onSave}>
      {schema.fields.map((field) => (
        <Form.Item key={field.name} name={field.name} label={field.label}>
          {field.secret ? (
            <Input.Password placeholder={values[field.name] ? String(values[field.name]) : '未设置'} />
          ) : (
            <Input placeholder={values[field.name] ? String(values[field.name]) : '未设置'} />
          )}
        </Form.Item>
      ))}
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
      </Form.Item>
    </Form>
  )
}
