import { useEffect, useState } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Switch, Tag, Space, message, Tooltip, theme } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import {
  getCapabilities,
  createCapability,
  updateCapability,
  updateCapabilitySystemPrompt,
  resetCapabilitySystemPrompt,
  updateCapabilityPipelineBinding,
} from '../api/capabilities'
import type { Capability } from '../api/capabilities'
import { getTestPipelines } from '../api/test-pipelines'
import type { TestPipeline } from '../types'

const categoryColors: Record<string, string> = {
  query: 'blue', action: 'orange', admin: 'red',
  env_prep: 'cyan', verify: 'green', testing: 'purple', result: 'magenta',
}
const categoryLabels: Record<string, string> = {
  query: '查询', action: '操作', admin: '管理',
  env_prep: '环境准备', verify: '验证', testing: '测试', result: '结果处理',
}

export default function CapabilitiesPage() {
  const { token } = theme.useToken()
  const [data, setData] = useState<Capability[]>([])
  const [pipelines, setPipelines] = useState<TestPipeline[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Capability | null>(null)
  const [form] = Form.useForm()
  const [promptValue, setPromptValue] = useState('')
  const [promptModified, setPromptModified] = useState(false)
  const [pipelineBindingDirty, setPipelineBindingDirty] = useState(false)

  useEffect(() => {
    load()
    loadPipelines()
  }, [])

  async function load() {
    setLoading(true)
    try { setData(await getCapabilities()) } finally { setLoading(false) }
  }

  async function loadPipelines() {
    try { setPipelines(await getTestPipelines()) } catch { /* ignore */ }
  }

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setPromptValue('')
    setPromptModified(false)
    setPipelineBindingDirty(false)
    setModalOpen(true)
  }

  function openEdit(record: Capability) {
    setEditing(record)
    form.setFieldsValue({ ...record })
    setPromptValue(record.systemPrompt ?? '')
    setPromptModified(false)
    setPipelineBindingDirty(false)
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    try {
      if (editing) {
        const { defaultPipelineId, ...rest } = values
        await updateCapability(editing.id, rest)
        if (promptModified) {
          await updateCapabilitySystemPrompt(editing.id, promptValue)
        }
        if (pipelineBindingDirty) {
          const next = defaultPipelineId === undefined || defaultPipelineId === null
            ? null
            : Number(defaultPipelineId)
          await updateCapabilityPipelineBinding(editing.id, next)
        }
        message.success('更新成功')
      } else {
        await createCapability(values)
        message.success('创建成功')
      }
      setModalOpen(false)
      await load()
    } catch {
      message.error('操作失败')
    }
  }

  async function handleResetPrompt() {
    if (!editing) return
    try {
      const updated = await resetCapabilitySystemPrompt(editing.id)
      setPromptValue(updated.systemPrompt ?? '')
      setPromptModified(false)
      message.success('已恢复默认提示词')
    } catch {
      message.error('恢复失败')
    }
  }

  const columns = [
    { title: 'ID', dataIndex: 'id' },
    { title: '标识', dataIndex: 'key' },
    { title: '能力名称', dataIndex: 'displayName' },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    {
      title: '分类', dataIndex: 'category',
      render: (v: string) => <Tag color={categoryColors[v]}>{categoryLabels[v] ?? v}</Tag>,
    },
    { title: '类型', dataIndex: 'isSystem',
      render: (v: boolean) => <Tag color={v ? 'default' : 'blue'}>{v ? '系统' : '自定义'}</Tag> },
    {
      title: '关联工具', dataIndex: 'toolNames',
      render: (names: string[]) => (
        <Space size={[4, 4]} wrap>
          {names.map(n => <Tag key={n}>{n}</Tag>)}
        </Space>
      ),
    },
    {
      title: '提示词', dataIndex: 'systemPrompt',
      render: (v: string | null, record: Capability) => {
        const isCustom = v !== null && v !== record.defaultSystemPrompt
        return <Tag color={isCustom ? 'orange' : 'default'}>{isCustom ? '自定义' : '默认'}</Tag>
      },
    },
    {
      title: '需审批', dataIndex: 'needsApproval',
      render: (v: boolean) => v ? <Tag color="red">是</Tag> : <Tag>否</Tag>,
    },
    { title: '创建时间', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString() },
    {
      title: '操作', key: 'action',
      render: (_: unknown, record: Capability) => (
        <a onClick={() => openEdit(record)}>编辑</a>
      ),
    },
  ]

  return (
    <Card title="能力管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增能力</Button>}>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />

      <Modal
        title={editing ? '编辑能力' : '新增能力'}
        open={modalOpen}
        onOk={handleSubmit}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        width={720}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="key" label="标识 (key)" rules={[{ required: true, message: '请输入能力标识' }]}>
            <Input placeholder="如: deploy_service" disabled={!!editing} />
          </Form.Item>
          <Form.Item name="displayName" label="能力名称" rules={[{ required: true, message: '请输入能力名称' }]}>
            <Input placeholder="如: 部署服务" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} placeholder="描述该能力的用途" />
          </Form.Item>
          <Form.Item name="category" label="分类" rules={[{ required: true, message: '请选择分类' }]}>
            <Select placeholder="请选择分类">
              <Select.Option value="query">查询</Select.Option>
              <Select.Option value="action">操作</Select.Option>
              <Select.Option value="admin">管理</Select.Option>
              <Select.Option value="env_prep">环境准备</Select.Option>
              <Select.Option value="verify">验证</Select.Option>
              <Select.Option value="testing">测试</Select.Option>
              <Select.Option value="result">结果处理</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="toolNames" label="关联工具 (逗号分隔)" getValueFromEvent={(e) => e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean)} getValueProps={(v) => ({ value: Array.isArray(v) ? v.join(', ') : v })}>
            <Input placeholder="如: deploy_tool, rollback_tool" />
          </Form.Item>
          <Form.Item name="needsApproval" label="需审批" valuePropName="checked" initialValue={false}>
            <Switch checkedChildren="是" unCheckedChildren="否" />
          </Form.Item>
          {editing && (
            <Form.Item
              name="defaultPipelineId"
              label={
                <Space>
                  <span>默认 Pipeline（IM 触发）</span>
                  <Tooltip title="绑定后，IM 中触发此能力将启动对应 pipeline（通常首节点为参数澄清），具备审批/容错/回滚能力。未绑定则走 Agent 直接处理。">
                    <Tag color="blue">说明</Tag>
                  </Tooltip>
                </Space>
              }
            >
              <Select
                allowClear
                placeholder="未绑定 — 走 Agent 直接处理"
                options={pipelines.map(p => ({ value: p.id, label: p.name }))}
                onChange={() => setPipelineBindingDirty(true)}
                onClear={() => setPipelineBindingDirty(true)}
              />
            </Form.Item>
          )}
          {editing && (
            <Form.Item label={
              <Space>
                <span>系统提示词</span>
                {editing.systemPrompt !== editing.defaultSystemPrompt
                  ? <Tag color="orange">自定义</Tag>
                  : <Tag>默认</Tag>
                }
              </Space>
            }>
              <Input.TextArea
                rows={8}
                value={promptValue}
                onChange={e => { setPromptValue(e.target.value); setPromptModified(true) }}
                style={{ fontFamily: 'monospace', fontSize: 12 }}
              />
              <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Button size="small" onClick={handleResetPrompt} disabled={editing.systemPrompt === editing.defaultSystemPrompt}>
                  恢复默认
                </Button>
                <span style={{ color: token.colorTextDescription, fontSize: 12 }}>
                  支持变量: {'{{initiatorRole}}'} | 模块/服务器信息会自动注入
                </span>
              </div>
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  )
}
