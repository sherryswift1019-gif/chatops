import { useEffect, useState } from 'react'
import { Card, Table, Button, Modal, Form, Input, Tag, Space, message, theme, Select } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import {
  getCapabilities,
  createCapability,
  updateCapability,
  updateCapabilitySystemPrompt,
  resetCapabilitySystemPrompt,
} from '../api/capabilities'
import type { Capability } from '../api/capabilities'

const CATEGORY_OPTIONS = [
  { value: 'feature_dev', label: '需求开发类', color: 'blue' },
  { value: 'bug_fix',     label: 'Bug 修复类', color: 'red' },
  { value: 'ops',         label: '运维操作类', color: 'green' },
  { value: 'info_query',  label: '信息抓取类', color: 'orange' },
]

function CategoryTag({ category }: { category: string | null }) {
  const opt = CATEGORY_OPTIONS.find(o => o.value === category)
  return opt
    ? <Tag color={opt.color}>{opt.label}</Tag>
    : <Tag>未分类</Tag>
}

export default function CapabilitiesPage() {
  const { token } = theme.useToken()
  const [data, setData] = useState<Capability[]>([])
  const [loading, setLoading] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Capability | null>(null)
  const [form] = Form.useForm()
  const [promptValue, setPromptValue] = useState('')
  const [promptModified, setPromptModified] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    try { setData(await getCapabilities()) } finally { setLoading(false) }
  }

  const filteredData = categoryFilter
    ? data.filter(r => r.category === categoryFilter)
    : data

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setPromptValue('')
    setPromptModified(false)
    setModalOpen(true)
  }

  function openEdit(record: Capability) {
    setEditing(record)
    form.setFieldsValue({ ...record })
    setPromptValue(record.systemPrompt ?? record.defaultSystemPrompt ?? '')
    setPromptModified(false)
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    try {
      if (editing) {
        await updateCapability(editing.id, values)
        if (promptModified) {
          await updateCapabilitySystemPrompt(editing.id, promptValue)
        }
        message.success('更新成功')
      } else {
        const created = await createCapability(values)
        if (promptModified && promptValue) {
          await updateCapabilitySystemPrompt(created.id, promptValue)
        }
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
    { title: '业务分类', dataIndex: 'category',
      render: (v: string | null) => <CategoryTag category={v} /> },
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
      <div style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="按业务分类筛选"
          style={{ width: 180 }}
          value={categoryFilter ?? undefined}
          onChange={v => setCategoryFilter(v ?? null)}
          options={[
            ...CATEGORY_OPTIONS.map(o => ({ value: o.value, label: <Tag color={o.color}>{o.label}</Tag> })),
          ]}
        />
      </div>
      <Table rowKey="id" columns={columns} dataSource={filteredData} loading={loading} pagination={false} />

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
          <Form.Item name="category" label="业务分类">
            <Select
              allowClear
              placeholder="请选择（可选）"
              options={CATEGORY_OPTIONS.map(o => ({
                value: o.value,
                label: <Tag color={o.color}>{o.label}</Tag>,
              }))}
            />
          </Form.Item>
          <Form.Item name="toolNames" label="关联工具 (逗号分隔)" getValueFromEvent={(e) => e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean)} getValueProps={(v) => ({ value: Array.isArray(v) ? v.join(', ') : v })}>
            <Input placeholder="如: deploy_tool, rollback_tool" />
          </Form.Item>
          <Form.Item label={
            <Space>
              <span>系统提示词{!editing && '（可选）'}</span>
              {editing && (editing.systemPrompt !== editing.defaultSystemPrompt
                ? <Tag color="orange">自定义</Tag>
                : <Tag>默认</Tag>
              )}
            </Space>
          }>
            <Input.TextArea
              rows={8}
              value={promptValue}
              onChange={e => { setPromptValue(e.target.value); setPromptModified(true) }}
              placeholder={editing ? undefined : '留空则使用系统默认提示词'}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
            />
            <div style={{ marginTop: 8, display: 'flex', justifyContent: editing ? 'space-between' : 'flex-end', alignItems: 'center' }}>
              {editing && (
                <Button size="small" onClick={handleResetPrompt} disabled={editing.systemPrompt === editing.defaultSystemPrompt}>
                  恢复默认
                </Button>
              )}
              <span style={{ color: token.colorTextDescription, fontSize: 12 }}>
                支持变量: {'{{initiatorRole}}'} | 模块/服务器信息会自动注入
              </span>
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
