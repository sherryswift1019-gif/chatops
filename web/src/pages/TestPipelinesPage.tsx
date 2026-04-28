import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Table, Button, Modal, Form, Input, Switch, Popconfirm, Space, Tag, message } from 'antd'
import { DeleteOutlined, EditOutlined, ExportOutlined, ImportOutlined, PartitionOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { getTestPipelines, getTestPipeline, createTestPipeline, updateTestPipeline, deleteTestPipeline } from '../api/test-pipelines'
import { triggerTestRun } from '../api/test-runs'
import type { TestPipeline } from '../types'

export default function TestPipelinesPage() {
  const nav = useNavigate()
  const [data, setData] = useState<TestPipeline[]>([])
  const [loading, setLoading] = useState(false)
  const [triggeringId, setTriggeringId] = useState<number | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [canvasModalOpen, setCanvasModalOpen] = useState(false)
  const [canvasForm] = Form.useForm()

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try { setData(await getTestPipelines()) } finally { setLoading(false) }
  }

  async function handleDelete(id: number) {
    await deleteTestPipeline(id); message.success('删除成功'); await load()
  }

  async function handleTriggerRun(id: number) {
    setTriggeringId(id)
    try {
      const { runId } = await triggerTestRun({ pipelineId: id, servers: {}, triggerType: 'manual' })
      message.success(`已触发，执行记录 #${runId}`)
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '触发失败')
    } finally {
      setTriggeringId(null)
    }
  }

  function handleExport(r: TestPipeline) {
    const exportFields = {
      id: r.id,
      name: r.name,
      description: r.description,
      enabled: r.enabled,
      stages: r.stages,
      variables: r.variables,
      triggerParams: r.triggerParams,
      containerImage: r.containerImage,
      artifactInputs: r.artifactInputs,
      serverRoles: r.serverRoles,
      _exportedAt: new Date().toISOString(),
    }
    const json = JSON.stringify(exportFields, null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const safeName = r.name.replace(/[^a-zA-Z0-9一-龥_]/g, '-')
    const a = document.createElement('a')
    a.href = url
    a.download = `pipeline-${r.id}-${safeName}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function openCanvasCreate() {
    canvasForm.resetFields()
    canvasForm.setFieldsValue({ enabled: true })
    setCanvasModalOpen(true)
  }

  async function handleCanvasCreate() {
    const values = await canvasForm.validateFields()
    try {
      const created = await createTestPipeline({
        name: values.name,
        description: values.description ?? '',
        stages: [],
        variables: {},
        artifactInputs: [],
        enabled: values.enabled ?? true,
        triggerParams: {},
      })
      message.success('已创建，进入画布编辑')
      setCanvasModalOpen(false)
      nav(`/test-pipelines/${created.id}/canvas`)
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '创建失败')
    }
  }

  const columns = [
    { title: 'ID', dataIndex: 'id' },
    { title: '名称', dataIndex: 'name' },
    { title: '节点数', render: (_: unknown, r: TestPipeline) => r.stages?.length ?? 0 },
    { title: '状态', dataIndex: 'enabled', render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '禁用'}</Tag> },
    {
      title: '操作',
      render: (_: unknown, r: TestPipeline) => (
        <Space>
          <Popconfirm title="确认运行？" onConfirm={() => handleTriggerRun(r.id)}>
            <a style={{ opacity: triggeringId === r.id ? 0.5 : 1 }}>
              <PlayCircleOutlined /> 运行
            </a>
          </Popconfirm>
          <a onClick={() => handleExport(r)}>
            <ExportOutlined /> 导出
          </a>
          <a onClick={() => nav(`/test-pipelines/${r.id}/canvas`)}>
            <EditOutlined /> 编辑
          </a>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}>
            <a style={{ color: 'red' }}>
              <DeleteOutlined /> 删除
            </a>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card title="流水线管理" extra={
      <Button type="primary" icon={<PartitionOutlined />} onClick={openCanvasCreate}>画布新建</Button>
    }>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
      <Modal
        title="画布新建流水线"
        open={canvasModalOpen}
        onOk={handleCanvasCreate}
        onCancel={() => setCanvasModalOpen(false)}
        destroyOnClose
        okText="创建并进入画布"
        width={520}
      >
        <Form form={canvasForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="如: 回归测试" />
          </Form.Item>
          <Form.Item name="description" label="描述">
            <Input.TextArea rows={2} placeholder="可选" />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" initialValue>
            <Switch />
          </Form.Item>
          <div style={{ color: '#999', fontSize: 12 }}>
            创建后进入画布配置节点、连线和节点参数。
          </div>
        </Form>
      </Modal>
    </Card>
  )
}
