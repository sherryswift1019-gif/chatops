import { useEffect, useState } from 'react'
import { Card, Table, Button, Modal, Form, Input, InputNumber, Select, Popconfirm, Space, Tag, message } from 'antd'
import { PlusOutlined, ApiOutlined } from '@ant-design/icons'
import { getTestServers, createTestServer, updateTestServer, deleteTestServer, testServerConnection } from '../api/test-servers'
import { getProductLines, getProductLineEnvs } from '../api/product-lines'
import { getEnvironments } from '../api/environments'
import type { TestServer, ProductLine, Environment } from '../types'

export default function TestServersPage() {
  const [data, setData] = useState<TestServer[]>([])
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [serverEnvMap, setServerEnvMap] = useState<Map<number, string[]>>(new Map())
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TestServer | null>(null)
  const [form] = Form.useForm()

  useEffect(() => { load(); loadProductLines() }, [])

  async function load() {
    setLoading(true)
    try { setData(await getTestServers()) } finally { setLoading(false) }
  }
  async function loadProductLines() {
    try {
      const [pls, envs] = await Promise.all([getProductLines(), getEnvironments()])
      setProductLines(pls)
      // Build reverse map: serverId → [env labels]
      const envNameMap = new Map<number, string>(envs.map(e => [e.id, e.displayName]))
      const plNameMap = new Map<number, string>(pls.map(p => [p.id, p.displayName]))
      const map = new Map<number, string[]>()
      await Promise.all(pls.map(async pl => {
        const plEnvs = await getProductLineEnvs(pl.id)
        for (const pe of plEnvs) {
          if (pe.runtime !== 'docker' || !pe.connectionConfig) continue
          const cfg = pe.connectionConfig as Record<string, unknown>
          const ids = (cfg.serverIds as number[]) ?? []
          const label = `${plNameMap.get(pl.id) ?? pl.id} / ${envNameMap.get(pe.envId) ?? pe.envId}`
          for (const sid of ids) {
            if (!map.has(sid)) map.set(sid, [])
            map.get(sid)!.push(label)
          }
        }
      }))
      setServerEnvMap(map)
    } catch { /* */ }
  }

  function openCreate() { setEditing(null); form.resetFields(); setModalOpen(true) }
  function openEdit(r: TestServer) { setEditing(r); form.setFieldsValue(r); setModalOpen(true) }

  async function handleSubmit() {
    const values = await form.validateFields()
    if (editing) {
      await updateTestServer(editing.id, values)
      message.success('更新成功')
    } else {
      await createTestServer(values)
      message.success('创建成功')
    }
    setModalOpen(false); await load()
  }

  async function handleDelete(id: number) {
    await deleteTestServer(id); message.success('删除成功'); await load()
  }

  async function handleTestConnection(id: number) {
    const hide = message.loading('正在测试连接...')
    try {
      const res = await testServerConnection(id)
      hide()
      if (res.success) message.success(`连接成功: ${res.output}`)
      else message.error(`连接失败: ${res.output}`)
    } catch (err) { hide(); message.error('连接测试失败') }
  }

  const statusColors: Record<string, string> = { idle: 'green', in_use: 'blue', offline: 'red' }
  const statusLabels: Record<string, string> = { idle: '空闲', in_use: '使用中', offline: '离线' }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '名称', dataIndex: 'name' },
    { title: '地址', render: (_: unknown, r: TestServer) => `${r.host}:${r.port}` },
    { title: '用户', dataIndex: 'username', width: 100 },
    { title: '角色', dataIndex: 'role', width: 100, render: (v: string) => v ? <Tag>{v}</Tag> : '-' },
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={statusColors[v]}>{statusLabels[v] ?? v}</Tag> },
    { title: '产线', dataIndex: 'productLineId', width: 100, render: (v: number) => productLines.find(p => p.id === v)?.displayName ?? v },
    {
      title: '关联环境', key: 'envs', width: 180,
      render: (_: unknown, r: TestServer) => {
        const envLabels = serverEnvMap.get(r.id)
        if (!envLabels?.length) return <span style={{ color: '#999' }}>-</span>
        return envLabels.map((label, i) => <Tag key={i} color="blue">{label}</Tag>)
      },
    },
    {
      title: '操作', width: 200,
      render: (_: unknown, r: TestServer) => (
        <Space>
          <a onClick={() => handleTestConnection(r.id)}><ApiOutlined /> 测试</a>
          <a onClick={() => openEdit(r)}>编辑</a>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}><a style={{ color: 'red' }}>删除</a></Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card title="测试服务器管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增服务器</Button>}>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
      <Modal title={editing ? '编辑服务器' : '新增服务器'} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)} destroyOnClose width={600}>
        <Form form={form} layout="vertical">
          <Form.Item name="productLineId" label="所属产线" rules={[{ required: true }]}>
            <Select options={productLines.map(p => ({ value: p.id, label: p.displayName }))} placeholder="选择产线" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="如: db-server-01" /></Form.Item>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="host" label="主机地址" rules={[{ required: true }]} style={{ flex: 1 }}><Input placeholder="192.168.1.10" /></Form.Item>
            <Form.Item name="port" label="SSH端口" initialValue={22}><InputNumber min={1} max={65535} /></Form.Item>
          </Space>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="username" label="用户名" rules={[{ required: true }]} style={{ flex: 1 }}><Input placeholder="root" /></Form.Item>
            <Form.Item name="authType" label="认证方式" initialValue="password">
              <Select options={[{ value: 'password', label: '密码' }, { value: 'key', label: '私钥' }]} />
            </Form.Item>
          </Space>
          <Form.Item name="credential" label="密码/私钥" rules={[{ required: true }]}><Input.Password placeholder="SSH密码或私钥内容" /></Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}><Input placeholder="如: db, app, test" /></Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
