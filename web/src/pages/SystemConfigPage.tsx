import { useEffect, useState, useRef } from 'react'
import { Card, Tabs, Form, Input, Button, Space, Select, Upload, message, Spin, Alert, Modal } from 'antd'
import { DownloadOutlined, UploadOutlined, EditOutlined, CloseOutlined, ReloadOutlined, ApiOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import {
  getSystemConfig, updateSystemConfig, exportAllData, importAllData,
  getDingTalkStatus, testGitLabConnection, testHarborConnection,
} from '../api/system-config'
import type { SystemConfigEntry, DingTalkStatus, ConnectionTestResult } from '../types'

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
        extraHeader={key === 'dingtalk' ? <DingTalkStatusBanner /> : null}
        extraActions={
          key === 'gitlab' ? ({ isDirty, saving }) => <TestConnectionButton target="gitlab" isDirty={isDirty} saving={saving} />
          : key === 'harbor' ? ({ isDirty, saving }) => <TestConnectionButton target="harbor" isDirty={isDirty} saving={saving} />
          : undefined
        }
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

function ConfigForm({ configKey: _configKey, schema, values, saving, onSave, extraHeader, extraActions }: {
  configKey: string
  schema: { fields: FieldSchema[] }
  values: Record<string, unknown>
  saving: boolean
  onSave: (values: Record<string, string>) => void
  extraHeader?: React.ReactNode
  extraActions?: (state: { isDirty: boolean; saving: boolean }) => React.ReactNode
}) {
  const [form] = Form.useForm()
  const [isDirty, setIsDirty] = useState(false)

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
    setIsDirty(false)
  }, [values, schema, form])

  return (
    <div style={{ maxWidth: 500 }}>
      {extraHeader}
      <Form
        form={form}
        layout="vertical"
        onFinish={onSave}
        onValuesChange={() => setIsDirty(true)}
        autoComplete="off"
      >
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
          <Space>
            <Button type="primary" htmlType="submit" loading={saving}>保存</Button>
            {extraActions?.({ isDirty, saving })}
          </Space>
        </Form.Item>
      </Form>
    </div>
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

/**
 * 钉钉 Stream 连接状态条：定期轮询 /system-config/dingtalk/status，
 * 把 connected / startError / 最近事件时间可视化。
 */
function DingTalkStatusBanner() {
  const [status, setStatus] = useState<DingTalkStatus | null>(null)
  const [loading, setLoading] = useState(false)

  async function fetchStatus() {
    setLoading(true)
    try {
      const data = await getDingTalkStatus()
      setStatus(data)
    } catch {
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStatus()
    const timer = setInterval(fetchStatus, 15000)
    return () => clearInterval(timer)
  }, [])

  const { type, message: msg, description } = resolveStatusDisplay(status)

  return (
    <Alert
      type={type}
      showIcon
      style={{ marginBottom: 16 }}
      message={
        <Space>
          <span>{msg}</span>
          <Button
            type="link"
            size="small"
            icon={<ReloadOutlined spin={loading} />}
            onClick={fetchStatus}
            style={{ paddingInline: 0 }}
          >
            刷新
          </Button>
        </Space>
      }
      description={description}
    />
  )
}

function resolveStatusDisplay(status: DingTalkStatus | null): {
  type: 'info' | 'success' | 'warning' | 'error'
  message: string
  description?: string
} {
  if (!status) return { type: 'info', message: '连接状态加载中…' }
  if (!status.configured) {
    return { type: 'info', message: '钉钉未配置', description: '请填写 Client ID 与 Client Secret 并保存，然后重启服务以启用 Stream 连接' }
  }
  if (status.needsRestart) {
    const base = status.connected ? '当前 Stream 连接使用的是旧凭证' : '凭证已更新但服务未重启'
    return {
      type: 'warning',
      message: '配置已修改，需重启服务生效',
      description: `${base}，请重启 chatops 进程以应用新的 Client ID / Secret`,
    }
  }
  if (!status.started) {
    const extra = status.startError ? `启动失败：${status.startError}` : '已配置，但 adapter 尚未启动（需重启服务以生效）'
    return { type: 'error', message: '未连接', description: extra }
  }
  if (status.connected) {
    const age = status.lastEventAt ? Math.max(0, Math.round((Date.now() - status.lastEventAt) / 1000)) : null
    const desc = age !== null
      ? `最近事件：${age} 秒前`
      : '启动中，尚未收到事件（正常现象，约 1 分钟内应收到心跳）'
    return { type: 'success', message: '已连接（Stream 模式）', description: desc }
  }
  return {
    type: 'error',
    message: '可能已断开连接',
    description: status.lastEventAt
      ? `最近事件已超过 120 秒（${new Date(status.lastEventAt).toLocaleString()}），请检查网络或钉钉凭证`
      : '启动后超过 60 秒仍未收到任何事件，请检查网络或钉钉凭证',
  }
}

/**
 * "测试连接"按钮：调后端用当前保存的配置发起一次最轻量请求，
 * 成功回显用户名，失败回显 HTTP 错误。
 * 当表单有未保存的修改时，先弹确认框提醒用户实际测试的是已保存的旧值。
 */
function TestConnectionButton({ target, isDirty, saving }: { target: 'gitlab' | 'harbor'; isDirty: boolean; saving: boolean }) {
  const [loading, setLoading] = useState(false)

  async function runTest() {
    const hide = message.loading('正在测试连接...', 0)
    setLoading(true)
    try {
      const result: ConnectionTestResult = target === 'gitlab'
        ? await testGitLabConnection()
        : await testHarborConnection()
      hide()
      if (result.ok && result.user) {
        message.success(`连接成功：用户 ${result.user.username}${result.user.name && result.user.name !== result.user.username ? `（${result.user.name}）` : ''}`)
      } else {
        message.error(`连接失败：${result.error ?? '未知错误'}`)
      }
    } catch (err) {
      hide()
      message.error(`连接失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }

  function handleClick() {
    if (isDirty) {
      Modal.confirm({
        title: '表单有未保存的修改',
        icon: <ExclamationCircleOutlined />,
        content: '测试连接会使用服务器上已保存的配置，而不是当前填写的内容。建议先点击"保存"。是否仍要用已保存的配置测试？',
        okText: '用已保存配置测试',
        cancelText: '取消',
        onOk: runTest,
      })
      return
    }
    void runTest()
  }

  return (
    <Button
      icon={<ApiOutlined />}
      loading={loading}
      disabled={saving}
      title={saving ? '正在保存，请稍候再测试' : undefined}
      onClick={handleClick}
    >
      测试连接
    </Button>
  )
}
