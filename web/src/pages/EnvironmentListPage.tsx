import { useEffect, useState } from 'react'
import { Card, Table, Button, Modal, Form, Input, InputNumber, Select, Tag, Popconfirm, Space, message } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { getEnvironments, createEnvironment, updateEnvironment, deleteEnvironment } from '../api/environments'
import type { Environment } from '../types'

export default function EnvironmentListPage() {
  const [data, setData] = useState<Environment[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Environment | null>(null)
  const [form] = Form.useForm()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try { setData(await getEnvironments()) } finally { setLoading(false) }
  }

  function openCreate() {
    setEditing(null)
    form.resetFields()
    setModalOpen(true)
  }

  function openEdit(record: Environment) {
    setEditing(record)
    form.setFieldsValue(record)
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    if (editing) {
      await updateEnvironment(editing.id, values)
      message.success('更新成功')
    } else {
      await createEnvironment(values)
      message.success('创建成功')
    }
    setModalOpen(false)
    await load()
  }

  async function handleDelete(id: number) {
    await deleteEnvironment(id)
    message.success('删除成功')
    await load()
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '名称', dataIndex: 'name' },
    { title: '显示名', dataIndex: 'displayName' },
    { title: '运行时', dataIndex: 'defaultRuntime', width: 110,
      render: (v: string) => <Tag color={v === 'kubernetes' ? 'blue' : 'green'}>{v === 'kubernetes' ? 'Kubernetes' : 'Docker'}</Tag> },
    { title: '排序', dataIndex: 'sortOrder', width: 80 },
    { title: '创建时间', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString() },
    {
      title: '操作', width: 150,
      render: (_: unknown, record: Environment) => (
        <Space>
          <a onClick={() => openEdit(record)}>编辑</a>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: 'red' }}>删除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card title="环境管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增环境</Button>}>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
      <Modal title={editing ? '编辑环境' : '新增环境'} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入环境名称' }]}>
            <Input placeholder="如: dev, staging, prod" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名" rules={[{ required: true, message: '请输入显示名' }]}>
            <Input placeholder="如: 开发环境" />
          </Form.Item>
          <Form.Item name="defaultRuntime" label="运行时" rules={[{ required: true, message: '请选择运行时' }]} initialValue="docker">
            <Select>
              <Select.Option value="docker">Docker</Select.Option>
              <Select.Option value="kubernetes">Kubernetes</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item name="sortOrder" label="排序" initialValue={0}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
