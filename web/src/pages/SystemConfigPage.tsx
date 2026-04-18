import { useEffect, useState, useRef } from 'react'
import { Card, Tabs, Form, Input, Button, Space, Select, Upload, message, Spin } from 'antd'
import { DownloadOutlined, UploadOutlined, EditOutlined, CloseOutlined } from '@ant-design/icons'
import { getSystemConfig, updateSystemConfig, exportAllData, importAllData } from '../api/system-config'
import type { SystemConfigEntry } from '../types'

type FieldType = 'text' | 'secret' | 'boolean'

interface FieldSchema {
  name: string
  label: string
  type?: FieldType
}

const CONFIG_SCHEMA: Record<string, { label: string; fields: FieldSchema[] }> = {
  dingtalk: {
    label: '钉钉配置',
    fields: [
      { name: 'clientId', label: 'Client ID' },
      { name: 'clientSecret', label: 'Client Secret', type: 'secret' },
    ],
  },
  gitlab: {
    label: 'GitLab 配置',
    fields: [
      { name: 'url', label: 'GitLab URL' },
      { name: 'token', label: 'Private Token', type: 'secret' },
      { name: 'skipTlsVerify', label: '跳过证书验证（自签名证书）', type: 'boolean' },
    ],
  },
  harbor: {
    label: 'Harbor 配置',
    fields: [
      { name: 'url', label: 'Harbor URL' },
      { name: 'registryUser', label: '用户名' },
      { name: 'registryPassword', label: '密码', type: 'secret' },
      { name: 'skipTlsVerify', label: '跳过证书验证（自签名证书）', type: 'boolean' },
      { name: 'caCert', label: 'CA 证书 (PEM 格式，可选)' },
    ],
  },
  kubernetes: {
    label: 'Kubernetes 配置',
    fields: [
      { name: 'apiServer', label: 'API Server 地址' },
      { name: 'token', label: 'Bearer Token', type: 'secret' },
      { name: 'caCert', label: 'CA 证书 (Base64)' },
      { name: 'kubeconfig', label: 'Kubeconfig (Base64)' },
    ],
  },
  claude: {
    label: 'Claude 配置',
    fields: [
      { name: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'CLAUDE_CODE_OAUTH_TOKEN', type: 'secret' },
      { name: 'ANTHROPIC_BASE_URL', label: 'ANTHROPIC_BASE_URL（可选）' },
      { name: 'model', label: '模型' },
    ],
  },
  platform: {
    label: '平台设置',
    fields: [
      { name: 'max_concurrency', label: '最大并发数（默认 10）' },
    ],
  },
}

export default function SystemConfigPage() {
  const [configs, setConfigs] = useState<Record<string, Record<string, unknown>>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  async function handleExport() {
    try {
      const data = await exportAllData()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'chatops-export.json'
      a.click()
      URL.revokeObjectURL(url)
      message.success('全量数据已导出')
    } catch { message.error('导出失败') }
  }

  function handleImportClick() {
    fileInputRef.current?.click()
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text) as Record<string, unknown>
      const result = await importAllData(data)
      const stats = result.stats
      const summary = Object.entries(stats).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`).join(', ')
      message.success(`导入成功: ${summary || '无新数据'}`)
      await loadConfigs()
    } catch { message.error('导入失败，请检查文件格式') }
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <Card title="系统配置" extra={
      <Space>
        <Button icon={<DownloadOutlined />} onClick={handleExport}>导出全量数据</Button>
        <Button icon={<UploadOutlined />} onClick={handleImportClick}>导入数据</Button>
        <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportFile} />
      </Space>
    }>
      <Tabs items={tabItems} />
    </Card>
  )
}

function ConfigForm({ configKey: _configKey, schema, values, saving, onSave }: {
  configKey: string
  schema: { fields: FieldSchema[] }
  values: Record<string, unknown>
  saving: boolean
  onSave: (values: Record<string, string>) => void
}) {
  const [form] = Form.useForm()

  // 非 secret 字段的当前值预填到表单（secret 字段被后端 mask 成 ****xxxx，不能作为 initialValue）
  useEffect(() => {
    const initial: Record<string, string> = {}
    for (const f of schema.fields) {
      const v = values[f.name]
      if (v == null || v === '') continue
      if (f.type === 'secret') continue
      initial[f.name] = String(v)
    }
    form.resetFields()
    form.setFieldsValue(initial)
  }, [values, schema, form])

  return (
    <Form form={form} layout="vertical" style={{ maxWidth: 500 }} onFinish={onSave} autoComplete="off">
      {schema.fields.map((field) => {
        const type: FieldType = field.type ?? 'text'
        return (
          <Form.Item key={field.name} name={field.name} label={field.label}>
            {type === 'secret' ? (
              <SecretInput maskedValue={values[field.name] ? String(values[field.name]) : ''} />
            ) : type === 'boolean' ? (
              <Select
                placeholder="请选择"
                allowClear
                options={[
                  { value: 'true', label: 'true（启用）' },
                  { value: 'false', label: 'false（禁用）' },
                ]}
              />
            ) : (
              <Input placeholder="未设置" autoComplete="off" />
            )}
          </Form.Item>
        )
      })}
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
      </Form.Item>
    </Form>
  )
}

/**
 * 受控 secret 输入组件。查看态仅渲染脱敏文本 + 修改按钮；
 * 点击修改后才渲染真正的 Input.Password。
 * 目的：让浏览器 DOM 在"查看"时不存在 type=password 输入框，
 * 彻底规避 Chrome/Safari 的登录凭据 autofill。
 */
function SecretInput({ value, onChange, maskedValue }: {
  value?: string
  onChange?: (v: string) => void
  maskedValue?: string
}) {
  const [editing, setEditing] = useState(false)

  // 保存成功后父组件会刷新 maskedValue：自动退回查看态
  useEffect(() => {
    setEditing(false)
  }, [maskedValue])

  if (!editing) {
    return (
      <Space size={8}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
          color: maskedValue ? '#5C6578' : '#8B93A8',
          fontStyle: maskedValue ? 'normal' : 'italic',
        }}>
          {maskedValue || '未设置'}
        </span>
        <Button
          type="link"
          size="small"
          icon={<EditOutlined />}
          onClick={() => setEditing(true)}
          style={{ paddingInline: 0 }}
        >
          {maskedValue ? '修改' : '设置'}
        </Button>
      </Space>
    )
  }

  return (
    <Space.Compact style={{ width: '100%' }}>
      <Input.Password
        value={value ?? ''}
        onChange={(e) => onChange?.(e.target.value)}
        autoFocus
        autoComplete="new-password"
        placeholder={maskedValue ? `当前 ${maskedValue}，输入新值替换` : '输入新值'}
      />
      <Button
        icon={<CloseOutlined />}
        onClick={() => {
          onChange?.('')
          setEditing(false)
        }}
        title="取消修改"
      />
    </Space.Compact>
  )
}
