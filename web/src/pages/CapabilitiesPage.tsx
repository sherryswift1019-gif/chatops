import { useEffect, useState } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Switch, Tag, Space, message } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { getCapabilities, createCapability, updateCapability } from '../api/capabilities'
import type { Capability } from '../api/capabilities'

const categoryColors: Record<string, string> = { query: 'blue', action: 'orange', admin: 'red' }
const categoryLabels: Record<string, string> = { query: '查询', action: '操作', admin: '管理' }

export default function CapabilitiesPage() {
  const [data, setData] = useState<Capability[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Capability | null>(null)
  const [form] = Form.useForm()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try { setData(await getCapabilities()) } finally { setLoading(false) }
  }

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(record: Capability) {
    setEditing(record)
    form.setFieldsValue({ ...record })
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    try {
      if (editing) {
        await updateCapability(editing.id, values)
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

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '标识', dataIndex: 'key', width: 160 },
    { title: '能力名称', dataIndex: 'displayName', width: 140 },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    {
      title: '分类', dataIndex: 'category', width: 80,
      render: (v: string) => <Tag color={categoryColors[v]}>{categoryLabels[v] ?? v}</Tag>,
    },
    {
      title: '关联工具', dataIndex: 'toolNames', width: 220,
      render: (names: string[]) => (
        <Space size={[4, 4]} wrap>
          {names.map(n => <Tag key={n}>{n}</Tag>)}
        </Space>
      ),
    },
    {
      title: '需审批', dataIndex: 'needsApproval', width: 80,
      render: (v: boolean) => v ? <Tag color="red">是</Tag> : <Tag>否</Tag>,
    },
    { title: '创建时间', dataIndex: 'createdAt', width: 170, render: (v: string) => new Date(v).toLocaleString() },
    {
      title: '操作', key: 'action', width: 80,
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
        width={600}
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
            </Select>
          </Form.Item>
          <Form.Item name="toolNames" label="关联工具 (逗号分隔)" getValueFromEvent={(e) => e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean)} getValueProps={(v) => ({ value: Array.isArray(v) ? v.join(', ') : v })}>
            <Input placeholder="如: deploy_tool, rollback_tool" />
          </Form.Item>
          <Form.Item name="needsApproval" label="需审批" valuePropName="checked" initialValue={false}>
            <Switch checkedChildren="是" unCheckedChildren="否" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
