import { useEffect, useState } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Switch, Popconfirm, Space, Tag, InputNumber, message } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { getTestPipelines, createTestPipeline, updateTestPipeline, deleteTestPipeline } from '../api/test-pipelines'
import { getProductLines } from '../api/product-lines'
import type { TestPipeline, ProductLine } from '../types'

const STAGE_TYPES = [
  { value: 'cleanup', label: '环境清理' },
  { value: 'download', label: '下载软件包' },
  { value: 'install', label: '安装部署' },
  { value: 'health_check', label: '健康检查' },
  { value: 'test', label: '执行测试' },
  { value: 'report', label: '生成报告' },
  { value: 'custom', label: '自定义命令' },
]

export default function TestPipelinesPage() {
  const [data, setData] = useState<TestPipeline[]>([])
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TestPipeline | null>(null)
  const [form] = Form.useForm()

  useEffect(() => { load(); loadProductLines() }, [])

  async function load() {
    setLoading(true)
    try { setData(await getTestPipelines()) } finally { setLoading(false) }
  }
  async function loadProductLines() {
    try { setProductLines(await getProductLines()) } catch { /* */ }
  }

  function openCreate() {
    setEditing(null); form.resetFields()
    form.setFieldsValue({ enabled: true, stages: [{ type: 'cleanup', name: '环境清理', parallel: false, timeoutSeconds: 300, retryCount: 0, onFailure: 'stop', targetRoles: [], params: {} }] })
    setModalOpen(true)
  }
  function openEdit(r: TestPipeline) {
    setEditing(r)
    form.setFieldsValue({ ...r, serverRolesJson: JSON.stringify(r.serverRoles, null, 2) })
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    const payload = {
      ...values,
      serverRoles: values.serverRolesJson ? JSON.parse(values.serverRolesJson) : {},
    }
    delete payload.serverRolesJson
    if (editing) {
      await updateTestPipeline(editing.id, payload)
      message.success('更新成功')
    } else {
      await createTestPipeline(payload)
      message.success('创建成功')
    }
    setModalOpen(false); await load()
  }

  async function handleDelete(id: number) {
    await deleteTestPipeline(id); message.success('删除成功'); await load()
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: '名称', dataIndex: 'name' },
    { title: '产线', dataIndex: 'productLineId', width: 100, render: (v: number) => productLines.find(p => p.id === v)?.displayName ?? v },
    { title: '阶段数', width: 80, render: (_: unknown, r: TestPipeline) => r.stages.length },
    { title: '定时', dataIndex: 'schedule', width: 120, render: (v: string) => v || '-' },
    { title: '状态', dataIndex: 'enabled', width: 80, render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '禁用'}</Tag> },
    {
      title: '操作', width: 150,
      render: (_: unknown, r: TestPipeline) => (
        <Space>
          <a onClick={() => openEdit(r)}>编辑</a>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}><a style={{ color: 'red' }}>删除</a></Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card title="测试流水线管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增流水线</Button>}>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
      <Modal title={editing ? '编辑流水线' : '新增流水线'} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)} destroyOnClose width={800}>
        <Form form={form} layout="vertical">
          <Form.Item name="productLineId" label="所属产线" rules={[{ required: true }]}>
            <Select options={productLines.map(p => ({ value: p.id, label: p.displayName }))} placeholder="选择产线" />
          </Form.Item>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="name" label="名称" rules={[{ required: true }]} style={{ flex: 1 }}><Input placeholder="如: 回归测试" /></Form.Item>
            <Form.Item name="schedule" label="定时(cron)"><Input placeholder="如: 0 2 * * *" style={{ width: 200 }} /></Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
          </Space>
          <Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="serverRolesJson" label="服务器角色定义 (JSON)" rules={[{ required: true }]}>
            <Input.TextArea rows={3} placeholder='{"db": {"count": 1}, "app": {"count": 1}, "test": {"count": 1}}' />
          </Form.Item>

          <div style={{ marginBottom: 8, fontWeight: 500 }}>阶段配置</div>
          <Form.List name="stages">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...rest }) => (
                  <Card key={key} size="small" style={{ marginBottom: 8 }} extra={<DeleteOutlined onClick={() => remove(name)} style={{ color: 'red' }} />}>
                    <Space style={{ display: 'flex', flexWrap: 'wrap' }}>
                      <Form.Item {...rest} name={[name, 'name']} label="阶段名称" rules={[{ required: true }]}><Input style={{ width: 150 }} /></Form.Item>
                      <Form.Item {...rest} name={[name, 'type']} label="类型" rules={[{ required: true }]}>
                        <Select options={STAGE_TYPES} style={{ width: 130 }} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, 'timeoutSeconds']} label="超时(秒)"><InputNumber min={10} style={{ width: 100 }} /></Form.Item>
                      <Form.Item {...rest} name={[name, 'retryCount']} label="重试次数"><InputNumber min={0} max={5} style={{ width: 80 }} /></Form.Item>
                      <Form.Item {...rest} name={[name, 'onFailure']} label="失败策略">
                        <Select options={[{ value: 'stop', label: '停止' }, { value: 'continue', label: '继续' }]} style={{ width: 90 }} />
                      </Form.Item>
                    </Space>
                    <Form.Item {...rest} name={[name, 'paramsJson']} label="参数 (JSON)">
                      <Input.TextArea rows={2} placeholder='{"script": "/opt/app/uninstall.sh"}' />
                    </Form.Item>
                  </Card>
                ))}
                <Button type="dashed" onClick={() => add({ type: 'custom', name: '', parallel: false, timeoutSeconds: 300, retryCount: 0, onFailure: 'stop', targetRoles: [], params: {} })} block icon={<PlusOutlined />}>
                  添加阶段
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
    </Card>
  )
}
