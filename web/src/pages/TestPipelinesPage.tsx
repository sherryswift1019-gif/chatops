import { useEffect, useState, useMemo } from 'react'
import { Card, Table, Button, Modal, Form, Input, Select, Switch, Popconfirm, Space, Tag, InputNumber, Checkbox, message } from 'antd'
import { PlusOutlined, DeleteOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { getTestPipelines, createTestPipeline, updateTestPipeline, deleteTestPipeline } from '../api/test-pipelines'
import { getProductLines } from '../api/product-lines'
import { getStageOperations } from '../api/capabilities'
import { getTestServers } from '../api/test-servers'
import { triggerTestRun } from '../api/test-runs'
import type { TestPipeline, ProductLine, TestServer } from '../types'
import type { StageOperation } from '../api/capabilities'
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
  const [capabilities, setCapabilities] = useState<StageOperation[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TestPipeline | null>(null)
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [serverRolesConfig, setServerRolesConfig] = useState<Record<string, { enabled: boolean; count: number }>>({})
  const [triggerModalOpen, setTriggerModalOpen] = useState(false)
  const [triggerPipeline, setTriggerPipeline] = useState<TestPipeline | null>(null)
  const [triggerServers, setTriggerServers] = useState<TestServer[]>([])
  const [triggerServerMap, setTriggerServerMap] = useState<Record<string, string[]>>({})
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
    try { setCapabilities(await getStageOperations()) } catch { /* */ }
  }

  async function loadServerRoles(productLineId: number) {
    try {
      const servers = await getTestServers(productLineId)
      const roles = [...new Set(servers.map(s => s.role).filter(Boolean))]
      setAvailableRoles(roles)
    } catch { setAvailableRoles([]) }
  }

  const capabilityMap = useMemo(() => {
    const m = new Map<string, StageOperation>()
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
    setServerRolesConfig({})
    setAvailableRoles([])
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
    // Populate serverRolesConfig from existing serverRoles
    const rolesConfig: Record<string, { enabled: boolean; count: number }> = {}
    for (const [role, cfg] of Object.entries(r.serverRoles ?? {})) {
      rolesConfig[role] = { enabled: true, count: (cfg as any).count ?? 1 }
    }
    setServerRolesConfig(rolesConfig)
    loadServerRoles(r.productLineId)
    const stages = (r.stages as any[]).map((s: any) => ({
      ...s,
      capabilityKey: s.capabilityKey || LEGACY_TYPE_MAP[s.type] || s.type,
      targetRoles: s.targetRoles ?? [],
      parallel: s.parallel ?? false,
      params: s.params ?? {},
    }))
    form.setFieldsValue({ ...r, stages })
    setModalOpen(true)
  }

  async function handleSubmit() {
    const values = await form.validateFields()
    const serverRoles: Record<string, { count: number }> = {}
    for (const [role, cfg] of Object.entries(serverRolesConfig)) {
      if (cfg.enabled && cfg.count > 0) {
        serverRoles[role] = { count: cfg.count }
      }
    }
    const payload = {
      ...values,
      serverRoles,
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

  async function openTrigger(r: TestPipeline) {
    setTriggerPipeline(r)
    setTriggerServerMap({})
    try {
      const servers = await getTestServers(r.productLineId)
      setTriggerServers(servers)
    } catch { setTriggerServers([]) }
    setTriggerModalOpen(true)
  }

  async function handleTrigger() {
    if (!triggerPipeline) return
    const roles = Object.keys(triggerPipeline.serverRoles ?? {})
    for (const role of roles) {
      if (!triggerServerMap[role]?.length) {
        message.warning(`请为角色「${role}」选择服务器`); return
      }
    }
    try {
      const res = await triggerTestRun({ pipelineId: triggerPipeline.id, servers: triggerServerMap, triggeredBy: 'manual' })
      message.success(`流水线已触发，执行 ID: ${res.runId}`)
      setTriggerModalOpen(false)
    } catch { message.error('触发失败') }
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 50 },
    { title: '名称', dataIndex: 'name' },
    { title: '产线', dataIndex: 'productLineId', render: (v: number) => productLines.find(p => p.id === v)?.displayName ?? v },
    { title: '阶段数', render: (_: unknown, r: TestPipeline) => (r.stages as any[]).length },
    { title: '定时', dataIndex: 'schedule', render: (v: string) => v || '-' },
    { title: '状态', dataIndex: 'enabled', render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '禁用'}</Tag> },
    {
      title: '操作',
      render: (_: unknown, r: TestPipeline) => (
        <Space>
          <a onClick={() => openTrigger(r)}><PlayCircleOutlined /> 执行</a>
          <a onClick={() => openEdit(r)}>编辑</a>
          <Popconfirm title="确认删除？" onConfirm={() => handleDelete(r.id)}><a style={{ color: 'red' }}>删除</a></Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <Card title="流水线管理" extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增流水线</Button>}>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={false} />
      <Modal title={editing ? '编辑流水线' : '新增流水线'} open={modalOpen} onOk={handleSubmit} onCancel={() => setModalOpen(false)} destroyOnClose width={900}>
        <Form form={form} layout="vertical">
          <Form.Item name="productLineId" label="所属产线" rules={[{ required: true }]}>
            <Select options={productLines.map(p => ({ value: p.id, label: p.displayName }))} placeholder="选择产线"
              onChange={(v: number) => loadServerRoles(v)} />
          </Form.Item>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="name" label="名称" rules={[{ required: true }]} style={{ flex: 1 }}><Input placeholder="如: 回归测试" /></Form.Item>
            <Form.Item name="schedule" label="定时(cron)"><Input placeholder="如: 0 2 * * *" style={{ width: 200 }} /></Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
          </Space>
          <Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item>
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>服务器角色配置 {availableRoles.length === 0 && <span style={{ fontWeight: 'normal', color: '#999', fontSize: 12 }}>（请先选择产线）</span>}</div>
            {availableRoles.map(role => {
              const cfg = serverRolesConfig[role] ?? { enabled: false, count: 1 }
              return (
                <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                  <Checkbox checked={cfg.enabled} onChange={e => setServerRolesConfig(prev => ({
                    ...prev, [role]: { ...prev[role], enabled: e.target.checked, count: prev[role]?.count ?? 1 }
                  }))}>{role}</Checkbox>
                  <InputNumber size="small" min={1} max={10} value={cfg.count} disabled={!cfg.enabled}
                    onChange={v => setServerRolesConfig(prev => ({
                      ...prev, [role]: { ...prev[role], count: v ?? 1 }
                    }))} style={{ width: 70 }} />
                  <span style={{ color: '#999', fontSize: 12 }}>台</span>
                </div>
              )
            })}
          </div>

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
                        <Select mode="multiple" style={{ width: 160 }} placeholder="选择角色"
                          options={Object.entries(serverRolesConfig).filter(([, c]) => c.enabled).map(([r]) => ({ value: r, label: r }))} />
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
      <Modal title={`触发执行: ${triggerPipeline?.name ?? ''}`} open={triggerModalOpen} onOk={handleTrigger} onCancel={() => setTriggerModalOpen(false)} destroyOnClose width={500}>
        {triggerPipeline && Object.entries(triggerPipeline.serverRoles ?? {}).map(([role, cfg]) => (
          <div key={role} style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 4, fontWeight: 500 }}>{role} <span style={{ fontWeight: 'normal', color: '#999' }}>（需要 {(cfg as any).count} 台）</span></div>
            <Select
              mode="multiple"
              value={triggerServerMap[role] ?? []}
              style={{ width: '100%' }}
              placeholder={`选择 ${role} 服务器`}
              onChange={(hosts: string[]) => setTriggerServerMap(prev => ({ ...prev, [role]: hosts }))}
              options={triggerServers.filter(s => s.role === role || !s.role).map(s => ({ value: s.host, label: `${s.name} (${s.host})` }))}
            />
          </div>
        ))}
        {triggerPipeline && Object.keys(triggerPipeline.serverRoles ?? {}).length === 0 && (
          <div style={{ color: '#999' }}>此流水线未配置服务器角色</div>
        )}
      </Modal>
    </Card>
  )
}

function StageParamsFormWrapper({ stageIndex, form, capabilityMap }: {
  stageIndex: number; form: any; capabilityMap: Map<string, StageOperation>
}) {
  const capabilityKey = Form.useWatch(['stages', stageIndex, 'capabilityKey'], form)
  const targetRoles = Form.useWatch(['stages', stageIndex, 'targetRoles'], form) as string[] | undefined
  const capability = capabilityKey ? capabilityMap.get(capabilityKey) : null
  if (!capability?.paramSchema || !Object.keys(capability.paramSchema).length) return null
  return (
    <div style={{ background: '#fff', border: '1px solid #e8e8e8', borderRadius: 6, padding: 12, marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 500, color: '#fa8c16', marginBottom: 10 }}>
        {capability.displayName} 能力参数
      </div>
      <StageParamsForm paramSchema={capability.paramSchema} parentFieldName={stageIndex} form={form}
        capabilityName={capability.displayName} targetRoles={targetRoles ?? []} />
    </div>
  )
}
