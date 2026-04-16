import { useEffect, useState } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Space, Popconfirm, message } from 'antd'
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { getModuleOwners, createModuleOwner, deleteModuleOwner } from '../api/module-owners'
import { getProductLines } from '../api/product-lines'
import type { ModuleOwner, ProductLine } from '../types'

export default function ModuleOwnersPage() {
  const [data, setData] = useState<ModuleOwner[]>([])
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [selectedPL, setSelectedPL] = useState<number | undefined>()
  const [form] = Form.useForm()

  useEffect(() => {
    getProductLines().then(setProductLines)
  }, [])

  useEffect(() => {
    if (selectedPL) load()
  }, [selectedPL])

  async function load() {
    if (!selectedPL) return
    setLoading(true)
    try { setData(await getModuleOwners(selectedPL)) } finally { setLoading(false) }
  }

  async function handleCreate() {
    const values = await form.validateFields()
    await createModuleOwner({ ...values, productLineId: selectedPL! })
    message.success('创建成功')
    setModalOpen(false)
    form.resetFields()
    await load()
  }

  async function handleDelete(id: number) {
    await deleteModuleOwner(id)
    message.success('删除成功')
    await load()
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '模块模式', dataIndex: 'modulePattern' },
    { title: '负责人 UserID', dataIndex: 'ownerUserId' },
    { title: '备份负责人', dataIndex: 'backupOwnerUserId', render: (v: string | null) => v ?? '-' },
    { title: '创建时间', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString() },
    {
      title: '操作',
      render: (_: unknown, r: ModuleOwner) => (
        <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}>
          <a style={{ color: 'red' }}>删除</a>
        </Popconfirm>
      ),
    },
  ]

  return (
    <Card
      title="模块负责人配置"
      extra={
        <Space>
          <Select
            style={{ width: 200 }}
            placeholder="选择产品线"
            value={selectedPL}
            onChange={setSelectedPL}
            options={productLines.map(pl => ({ value: pl.id, label: pl.displayName }))}
          />
          <Button icon={<ReloadOutlined />} onClick={load} disabled={!selectedPL}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { form.resetFields(); setModalOpen(true) }} disabled={!selectedPL}>
            新增
          </Button>
        </Space>
      }
    >
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />

      <Modal title="新增模块负责人" open={modalOpen} onOk={handleCreate} onCancel={() => setModalOpen(false)} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="modulePattern" label="模块模式" rules={[{ required: true }]} extra="支持通配符，如 pas-bastion-host 或 pas-*">
            <Input placeholder="pas-bastion-host" />
          </Form.Item>
          <Form.Item name="ownerUserId" label="负责人钉钉 UserID" rules={[{ required: true }]}>
            <Input placeholder="liaoss" />
          </Form.Item>
          <Form.Item name="backupOwnerUserId" label="备份负责人（可选）">
            <Input placeholder="hanff" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
