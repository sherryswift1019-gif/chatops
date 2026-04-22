import { useEffect, useState } from 'react'
import { Card, Table, Button, Modal, Form, Input, Popconfirm, Space, message } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { getProductLines, createProductLine, updateProductLine, deleteProductLine } from '../api/product-lines'
import type { ProductLine } from '../types'

export default function ProductLineListPage() {
  const [data, setData] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ProductLine | null>(null)
  const [form] = Form.useForm()
  const navigate = useNavigate()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try { setData(await getProductLines()) } finally { setLoading(false) }
  }

  function openCreate() { setEditing(null); form.resetFields(); setModalOpen(true) }
  function openEdit(record: ProductLine) { setEditing(record); form.setFieldsValue(record); setModalOpen(true) }

  async function handleSubmit() {
    const values = await form.validateFields()
    if (editing) { await updateProductLine(editing.id, values); message.success('更新成功') }
    else { await createProductLine(values); message.success('创建成功') }
    setModalOpen(false); await load()
  }

  async function handleDelete(id: number) { await deleteProductLine(id); message.success('删除成功'); await load() }

  const columns = [
    { title: 'ID', dataIndex: 'id' },
    { title: '名称', dataIndex: 'name' },
    { title: '显示名', dataIndex: 'displayName' },
    { title: '描述', dataIndex: 'description', ellipsis: true },
    { title: '创建时间', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString() },
    {
      title: '操作',
      render: (_: unknown, record: ProductLine) => (
        <Space>
          <a onClick={() => navigate(`/product-lines/${record.id}`)}>详情</a>
          <a onClick={() => openEdit(record)}>编辑</a>
          <Popconfirm title="确认删除？" description="将级联删除关联数据" onConfirm={() => handleDelete(record.id)}>
            <a style={{ color: 'red' }}>删除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card title="产品管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增产线</Button>}>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
      <Modal title={editing ? '编辑产线' : '新增产线'} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入产线名称' }]}>
            <Input placeholder="如: pam" />
          </Form.Item>
          <Form.Item name="displayName" label="显示名" rules={[{ required: true, message: '请输入显示名' }]}>
            <Input placeholder="如: PAM 特权访问管理" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
