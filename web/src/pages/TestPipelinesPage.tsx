import { useEffect, useState, useMemo } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Switch, Popconfirm, Space, Tag, InputNumber, message } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { getTestPipelines, createTestPipeline, updateTestPipeline, deleteTestPipeline } from '../api/test-pipelines'
import { getProductLines } from '../api/product-lines'
import { getPipelineCapabilities } from '../api/capabilities'
import type { TestPipeline, ProductLine } from '../types'
import type { Capability } from '../api/capabilities'
import StageParamsForm from '../components/StageParamsForm'

const CATEGORY_ORDER = ['env_prep', 'action', 'verify', 'testing', 'result']
const CATEGORY_LABELS: Record<string, string> = {
  env_prep: '环境准备', action: '操作', verify: '验证', testing: '测试', result: '结果处理',
}

const LEGACY_TYPE_MAP: Record<string, string> = {
  cleanup: 'env_cleanup', download: 'deploy', install: 'deploy',
  health_check: 'health_check', test: 'auto_test', report: 'report_gen', custom: 'custom_script',
}

export default function TestPipelinesPage() {
  const [data, setData] = useState<TestPipeline[]>([])
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TestPipeline | null>(null)
  const [form] = Form.useForm()

  useEffect(() => { load(); loadProductLines(); loadCapabilities() }, [])

  async function load() {
    setLoading(true)
    try { setData(await getTestPipelines()) } finally { setLoading(false) }
  }
  async function loadProductLines() {
    try { setProductLines(await getProductLines()) } catch { /* */ }
  }
  async function loadCapabilities() {
    try { setCapabilities(await getPipelineCapabilities()) } catch { /* */ }
  }

  const capabilityMap = useMemo(() => {
    const m = new Map<string, Capability>()
    capabilities.forEach(c => m.set(c.key, c))
    return m
  }, [capabilities])

  const capabilityOptions = useMemo(() => {
    return CATEGORY_ORDER
      .map(cat => {
        const items = capabilities.filter(c => c.category === cat)
        if (items.length === 0) return null
        return {
          label: CATEGORY_LABELS[cat] ?? cat,
          options: items.map(c => ({ value: c.key, label: c.displayName })),
        }
      })
      .filter(Boolean)
  }, [capabilities])

  function openCreate() {
    setEditing(null); form.resetFields()
    form.setFieldsValue({
      enabled: true,
      stages: [{
        capabilityKey: 'env_cleanup', name: '环境清理',
        parallel: false, timeoutSeconds: 300, retryCount: 0, onFailure: 'stop',
        targetRoles: [], params: {},
      }],
    })
    setModalOpen(true)
  }

  function openEdit(r: TestPipeline) {
    setEditing(r)
    const stages = (r.stages as any[]).map((s: any) => ({
      ...s,
      capabilityKey: s.capabilityKey || LEGACY_TYPE_MAP[s.type] || s.type,
      targetRoles: s.targetRoles ?? [],
      parallel: s.parallel ?? false,
      params: s.params ?? {},
    }))
    form.setFieldsValue({ ...r, stages, serverRolesJson: JSON.stringify(r.serverRoles, null, 2) })
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    const payload = {
      ...values,
      serverRoles: values.serverRolesJson ? JSON.parse(values.serverRolesJson) : {},
      stages: values.stages.map((s: any) => ({
        name: s.name,
        capabilityKey: s.capabilityKey,
        params: s.params ?? {},
        targetRoles: s.targetRoles ?? [],
        parallel: s.parallel ?? false,
        timeoutSeconds: s.timeoutSeconds ?? 300,
        retryCount: s.retryCount ?? 0,
        onFailure: s.onFailure ?? 'stop',
      })),
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
    { title: '阶段数', width: 80, render: (_: unknown, r: TestPipeline) => (r.stages as any[]).length },
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
      <Modal title={editing ? '编辑流水线' : '新增流水线'} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)} destroyOnClose width={900}>
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
            <Input.TextArea rows={3} placeholder='{"db": {"count": 1}, "app": {"count": 1}}' />
          </Form.Item>

          <div style={{ marginBottom: 8, fontWeight: 500 }}>阶段配置</div>
          <Form.List name="stages">
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...rest }) => (
                  <Card key={key} size="small" style={{ marginBottom: 8 }} extra={<DeleteOutlined onClick={() => remove(name)} style={{ color: 'red' }} />}>
                    <Space style={{ display: 'flex', flexWrap: 'wrap' }}>
                      <Form.Item {...rest} name={[name, 'name']} label="阶段名称" rules={[{ required: true }]}>
                        <Input style={{ width: 150 }} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, 'capabilityKey']} label="选择能力" rules={[{ required: true }]}>
                        <Select
                          options={capabilityOptions as any}
                          style={{ width: 160 }}
                          onChange={() => form.setFieldValue(['stages', name, 'params'], {})}
                        />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, 'targetRoles']} label="目标角色">
                        <Select mode="tags" style={{ width: 160 }} placeholder="输入角色名" />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, 'timeoutSeconds']} label="超时(秒)"><InputNumber min={10} style={{ width: 100 }} /></Form.Item>
                      <Form.Item {...rest} name={[name, 'retryCount']} label="重试次数"><InputNumber min={0} max={5} style={{ width: 80 }} /></Form.Item>
                      <Form.Item {...rest} name={[name, 'onFailure']} label="失败策略">
                        <Select options={[{ value: 'stop', label: '停止' }, { value: 'continue', label: '继续' }]} style={{ width: 90 }} />
                      </Form.Item>
                      <Form.Item {...rest} name={[name, 'parallel']} label="并行" valuePropName="checked">
                        <Switch />
                      </Form.Item>
                    </Space>
                    <StageParamsFormWrapper stageIndex={name} form={form} capabilityMap={capabilityMap} />
                  </Card>
                ))}
                <Button type="dashed" onClick={() => add({
                  capabilityKey: 'custom_script', name: '', parallel: false,
                  timeoutSeconds: 300, retryCount: 0, onFailure: 'stop', targetRoles: [], params: {},
                })} block icon={<PlusOutlined />}>
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

function StageParamsFormWrapper({ stageIndex, form, capabilityMap }: {
  stageIndex: number; form: any; capabilityMap: Map<string, Capability>
}) {
  const capabilityKey = Form.useWatch(['stages', stageIndex, 'capabilityKey'], form)
  const capability = capabilityKey ? capabilityMap.get(capabilityKey) : null
  if (!capability?.paramSchema || !Object.keys(capability.paramSchema).length) return null
  return (
    <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 6, padding: 12, marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: '#fa8c16', marginBottom: 10 }}>
        {capability.displayName} 能力参数
      </div>
      <StageParamsForm paramSchema={capability.paramSchema} parentFieldName={stageIndex} form={form} />
    </div>
  )
}
