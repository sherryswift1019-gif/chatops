import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Table, Button, Modal, Form, Input, Select, Switch, Popconfirm, Space, Tag, InputNumber, Checkbox, message } from 'antd'
import { PlusOutlined, DeleteOutlined, PlayCircleOutlined, RobotOutlined } from '@ant-design/icons'
import { getTestPipelines, createTestPipeline, updateTestPipeline, deleteTestPipeline } from '../api/test-pipelines'
import { getProductLines } from '../api/product-lines'
import { getTestServers } from '../api/test-servers'
import { triggerTestRun } from '../api/test-runs'
import { getDingTalkUsers } from '../api/dingtalk-users'
import { getPipelineVariables } from '../api/pipeline-variables'
import { listArtifacts } from '../api/artifacts'
import AiCommandModal from '../components/AiCommandModal'
import type { TestPipeline, ProductLine, TestServer, ArtifactInput } from '../types'


export default function TestPipelinesPage() {
  const nav = useNavigate()
  const [data, setData] = useState<TestPipeline[]>([])
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [dingtalkUsers, setDingtalkUsers] = useState<{userId: string; name: string}[]>([])
  const [variableCatalog, setVariableCatalog] = useState<{key: string; description: string; category: string}[]>([])
  const [loading, setLoading] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<TestPipeline | null>(null)
  const [availableRoles, setAvailableRoles] = useState<string[]>([])
  const [serverRolesConfig, setServerRolesConfig] = useState<Record<string, { enabled: boolean; count: number }>>({})
  const [triggerModalOpen, setTriggerModalOpen] = useState(false)
  const [triggerPipeline, setTriggerPipeline] = useState<TestPipeline | null>(null)
  const [triggerServers, setTriggerServers] = useState<TestServer[]>([])
  const [triggerServerMap, setTriggerServerMap] = useState<Record<string, string[]>>({})
  const [triggerRuntimeVars, setTriggerRuntimeVars] = useState<Record<string, string>>({})
  const [form] = Form.useForm()

  useEffect(() => { load(); loadProductLines(); loadDingtalkUsers(); loadVariableCatalog() }, [])

  async function load() {
    setLoading(true)
    try { setData(await getTestPipelines()) } finally { setLoading(false) }
  }
  async function loadProductLines() {
    try { setProductLines(await getProductLines()) } catch { /* */ }
  }
  async function loadDingtalkUsers() {
    try {
      const res = await getDingTalkUsers()
      setDingtalkUsers(res.users.map(u => ({ userId: u.userId, name: u.name })))
    } catch { /* */ }
  }
  async function loadVariableCatalog() {
    try { setVariableCatalog(await getPipelineVariables()) } catch { /* */ }
  }

  async function loadServerRoles(productLineId: number) {
    try {
      const servers = await getTestServers(productLineId)
      const roles = [...new Set(servers.map(s => s.role).filter(Boolean))]
      setAvailableRoles(roles)
    } catch { setAvailableRoles([]) }
  }


  function openCreate() {
    setEditing(null); form.resetFields()
    setServerRolesConfig({})
    setAvailableRoles([])
    form.setFieldsValue({
      enabled: true,
      stages: [{
        stageType: 'script', name: '',
        parallel: false, timeoutSeconds: 300, retryCount: 0, onFailure: 'stop',
        targetRoles: [], script: '',
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
      stageType: s.stageType ?? 'script',  // backward compat
      script: s.script ?? s.params?.commands ?? s.params?.script ?? '',
      targetRoles: s.targetRoles ?? [],
      parallel: s.parallel ?? false,
    }))
    const variableEntries = Object.entries(r.variables ?? {}).map(([key, value]) => ({ key, value }))
    form.setFieldsValue({ ...r, stages, variableEntries, artifactInputs: r.artifactInputs ?? [] })
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
    const variables: Record<string, string> = {}
    for (const entry of values.variableEntries ?? []) {
      if (entry.key) variables[entry.key] = entry.value ?? ''
    }
    const payload = {
      ...values,
      serverRoles,
      variables,
      artifactInputs: (values.artifactInputs ?? []) as ArtifactInput[],
      stages: values.stages.map((s: any) => ({
        name: s.name,
        stageType: s.stageType ?? 'script',
        script: s.stageType === 'script' ? (s.script ?? '') : undefined,
        approverIds: s.stageType === 'approval' ? (s.approverIds ?? []) : undefined,
        approvalDescription: s.stageType === 'approval' ? (s.approvalDescription ?? '') : undefined,
        targetRoles: s.targetRoles ?? [],
        parallel: s.parallel ?? false,
        timeoutSeconds: s.timeoutSeconds ?? 300,
        retryCount: s.retryCount ?? 0,
        onFailure: s.onFailure ?? 'stop',
      })),
    }
    delete (payload as any).variableEntries
    try {
      if (editing) {
        await updateTestPipeline(editing.id, payload)
        message.success('更新成功')
      } else {
        await createTestPipeline(payload)
        message.success('创建成功')
      }
      setModalOpen(false); await load()
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '保存失败')
    }
  }

  async function handleDelete(id: number) {
    await deleteTestPipeline(id); message.success('删除成功'); await load()
  }

  async function openTrigger(r: TestPipeline) {
    setTriggerPipeline(r)
    setTriggerServerMap({})
    setTriggerRuntimeVars({})
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
    for (const input of triggerPipeline.artifactInputs ?? []) {
      const hasValue = !!triggerRuntimeVars[input.outputVar]
      const hasFallback = !!input.default || !!input.defaultStrategy
      if (!hasValue && !hasFallback) {
        message.warning(`请为「${input.name}」选择或填写值`); return
      }
    }
    try {
      const res = await triggerTestRun({
        pipelineId: triggerPipeline.id,
        servers: triggerServerMap,
        triggerType: 'manual',
        runtimeVars: triggerRuntimeVars,
      })
      message.success(`流水线已触发，执行 ID: ${res.runId}`)
      setTriggerModalOpen(false)
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '触发失败')
    }
  }

  const columns = [
    { title: 'ID', dataIndex: 'id' },
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
          <a onClick={() => nav(`/test-pipelines/${r.id}/canvas`)}>画布编辑</a>
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
            <div style={{ marginBottom: 8, fontWeight: 500 }}>自定义变量</div>
            <Form.List name="variableEntries">
              {(fields, { add: addVar, remove: removeVar }) => (
                <>
                  {fields.map(({ key, name: vName }) => (
                    <Space key={key} style={{ display: 'flex', marginBottom: 4 }}>
                      <Form.Item name={[vName, 'key']} rules={[{ required: true, message: '变量名' }]} style={{ marginBottom: 0 }}>
                        <Input placeholder="变量名" style={{ width: 150 }} addonBefore="vars." />
                      </Form.Item>
                      <Form.Item name={[vName, 'value']} style={{ marginBottom: 0 }}>
                        <Input placeholder="默认值" style={{ width: 200 }} />
                      </Form.Item>
                      <DeleteOutlined onClick={() => removeVar(vName)} style={{ color: 'red' }} />
                    </Space>
                  ))}
                  <Button type="dashed" size="small" onClick={() => addVar({ key: '', value: '' })} icon={<PlusOutlined />}>
                    添加变量
                  </Button>
                </>
              )}
            </Form.List>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>
              制品输入 <span style={{ fontWeight: 'normal', color: '#999', fontSize: 12 }}>（触发前选包；定时/API 触发须填 default 或 defaultStrategy）</span>
            </div>
            <Form.List name="artifactInputs">
              {(fields, { add: addArt, remove: removeArt }) => (
                <>
                  {fields.map(({ key, name: aName }) => (
                    <Card key={key} size="small" style={{ marginBottom: 8 }}
                      extra={<DeleteOutlined onClick={() => removeArt(aName)} style={{ color: 'red' }} />}>
                      <Space style={{ display: 'flex', flexWrap: 'wrap' }}>
                        <Form.Item name={[aName, 'name']} label="名称" rules={[{ required: true }]} style={{ marginBottom: 4 }}>
                          <Input style={{ width: 180 }} placeholder="选择 PAM Docker 包" />
                        </Form.Item>
                        <Form.Item name={[aName, 'outputVar']} label="输出变量" rules={[{ required: true }]} style={{ marginBottom: 4 }}>
                          <Input style={{ width: 180 }} placeholder="PACKAGE_URL" addonBefore="vars." />
                        </Form.Item>
                        <Form.Item name={[aName, 'valueFrom']} label="取值" initialValue="url" style={{ marginBottom: 4 }}>
                          <Select style={{ width: 100 }} options={[
                            { value: 'url', label: 'url' },
                            { value: 'name', label: 'name' },
                            { value: 'path', label: 'path' },
                          ]} />
                        </Form.Item>
                      </Space>
                      <Space style={{ display: 'flex', flexWrap: 'wrap' }}>
                        <Form.Item name={[aName, 'listUrl']} label="仓库 URL" rules={[{ required: true }]} style={{ marginBottom: 4 }}>
                          <Input style={{ width: 380 }} placeholder="http://10.10.2.234:8000/pam/deploy" />
                        </Form.Item>
                        <Form.Item name={[aName, 'glob']} label="过滤模式" rules={[{ required: true }]} style={{ marginBottom: 4 }}>
                          <Input style={{ width: 260 }} placeholder="PAM-Docker-*.tar.gz" />
                        </Form.Item>
                        <Form.Item label=" " style={{ marginBottom: 4 }}>
                          <ArtifactPreviewButton form={form} fieldName={aName} />
                        </Form.Item>
                      </Space>
                      <Space style={{ display: 'flex', flexWrap: 'wrap' }}>
                        <Form.Item name={[aName, 'default']} label="默认值" style={{ marginBottom: 4 }}>
                          <Input style={{ width: 380 }} placeholder="可选：字面值，优先级高于 strategy" />
                        </Form.Item>
                        <Form.Item name={[aName, 'defaultStrategy']} label="自动策略" style={{ marginBottom: 4 }}>
                          <Select allowClear style={{ width: 200 }} options={[
                            { value: 'latest-by-mtime', label: 'latest-by-mtime' },
                            { value: 'first-match', label: 'first-match' },
                          ]} placeholder="定时触发时自动挑选" />
                        </Form.Item>
                      </Space>
                    </Card>
                  ))}
                  <Button type="dashed" size="small" onClick={() => addArt({
                    name: '', listUrl: '', glob: '', outputVar: '', valueFrom: 'url',
                  })} icon={<PlusOutlined />}>
                    添加制品输入
                  </Button>
                </>
              )}
            </Form.List>
          </div>
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
                      <Form.Item {...rest} name={[name, 'stageType']} label="类型" rules={[{ required: true }]}>
                        <Select style={{ width: 130 }} options={[
                          { value: 'script', label: '运行脚本' },
                          { value: 'approval', label: '人员审批' },
                        ]} />
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
                    <StageTypeFields stageIndex={name} form={form} variableCatalog={variableCatalog} dingtalkUsers={dingtalkUsers} />
                  </Card>
                ))}
                <Button type="dashed" onClick={() => add({
                  stageType: 'script', name: '', parallel: false,
                  timeoutSeconds: 300, retryCount: 0, onFailure: 'stop', targetRoles: [], script: '',
                })} block icon={<PlusOutlined />}>
                  添加阶段
                </Button>
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
      <Modal title={`触发执行: ${triggerPipeline?.name ?? ''}`} open={triggerModalOpen} onOk={handleTrigger} onCancel={() => setTriggerModalOpen(false)} destroyOnClose width={600}>
        {triggerPipeline && (triggerPipeline.artifactInputs ?? []).length > 0 && (
          <div style={{ marginBottom: 16, padding: 12, background: '#fafafa', borderRadius: 4 }}>
            <div style={{ marginBottom: 8, fontWeight: 500 }}>制品输入</div>
            {(triggerPipeline.artifactInputs ?? []).map(input => (
              <RuntimeVarPicker
                key={input.outputVar}
                input={input}
                value={triggerRuntimeVars[input.outputVar] ?? ''}
                onChange={v => setTriggerRuntimeVars(prev => ({ ...prev, [input.outputVar]: v }))}
              />
            ))}
          </div>
        )}
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

function StageTypeFields({ stageIndex, form, variableCatalog, dingtalkUsers }: {
  stageIndex: number; form: any;
  variableCatalog: { key: string; description: string; category: string }[];
  dingtalkUsers: { userId: string; name: string }[];
}) {
  const stageType = Form.useWatch(['stages', stageIndex, 'stageType'], form)
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const textAreaRef = useRef<any>(null)

  function insertVariable(varKey: string) {
    const fieldPath = ['stages', stageIndex, 'script']
    const current = form.getFieldValue(fieldPath) ?? ''
    form.setFieldValue(fieldPath, current + `{{${varKey}}}`)
  }

  if (stageType === 'approval') {
    return (
      <div style={{ marginTop: 8 }}>
        <Form.Item name={[stageIndex, 'approverIds']} label="审批人">
          <Select mode="multiple" placeholder="选择审批人" options={dingtalkUsers.map(u => ({ value: u.userId, label: u.name }))} />
        </Form.Item>
        <Form.Item name={[stageIndex, 'approvalDescription']} label="审批描述">
          <Input placeholder="审批时展示的操作描述" />
        </Form.Item>
      </div>
    )
  }

  // script type
  return (
    <div style={{ marginTop: 8 }}>
      <Form.Item name={[stageIndex, 'script']} label={
        <span>脚本 <Button type="link" size="small" icon={<RobotOutlined />} onClick={() => setAiModalOpen(true)}>AI 生成</Button></span>
      }>
        <Input.TextArea ref={textAreaRef} rows={5} placeholder="输入要执行的 shell 脚本" style={{ fontFamily: 'monospace', fontSize: 12 }} />
      </Form.Item>
      <div style={{ marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: '#999', marginRight: 8 }}>可用变量（点击插入）：</span>
        {variableCatalog.map(v => (
          <Tag key={v.key} color="blue" style={{ cursor: 'pointer', marginBottom: 4 }}
            onClick={() => insertVariable(v.key)} title={v.description}>
            {'{{' + v.key + '}}'}
          </Tag>
        ))}
      </div>
      <AiCommandModal open={aiModalOpen} capabilityName="脚本" targetRoles={[]}
        onConfirm={(cmd) => { form.setFieldValue(['stages', stageIndex, 'script'], cmd); setAiModalOpen(false) }}
        onCancel={() => setAiModalOpen(false)} />
    </div>
  )
}

function ArtifactPreviewButton({ form, fieldName }: { form: any; fieldName: number }) {
  const [loading, setLoading] = useState(false)
  async function handleClick() {
    const listUrl = form.getFieldValue(['artifactInputs', fieldName, 'listUrl'])
    const glob = form.getFieldValue(['artifactInputs', fieldName, 'glob'])
    if (!listUrl) { message.warning('请先填写仓库 URL'); return }
    setLoading(true)
    try {
      const files = await listArtifacts(listUrl, glob || undefined)
      if (files.length === 0) {
        message.info(`没有匹配 ${glob || '*'} 的文件`)
        return
      }
      const head = files.slice(0, 5).map(f => `${f.name} (${new Date(f.mtime).toISOString().slice(0, 10)})`).join('\n')
      Modal.info({
        title: `匹配 ${files.length} 个文件（按 mtime 倒序，展示前 5）`,
        content: <pre style={{ margin: 0, fontFamily: 'monospace' }}>{head}</pre>,
        width: 600,
      })
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '请求失败')
    } finally {
      setLoading(false)
    }
  }
  return <Button size="small" loading={loading} onClick={handleClick}>预览匹配</Button>
}

function RuntimeVarPicker({ input, value, onChange }: {
  input: ArtifactInput
  value: string
  onChange: (v: string) => void
}) {
  const [loading, setLoading] = useState(false)
  async function openPicker() {
    setLoading(true)
    try {
      const files = await listArtifacts(input.listUrl, input.glob)
      if (files.length === 0) { message.info('没有匹配的文件'); return }
      Modal.info({
        title: `选择：${input.name}`,
        width: 700,
        content: (
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {files.slice(0, 20).map(f => {
              const picked = input.valueFrom === 'name' ? f.name : input.valueFrom === 'path' ? f.path : f.downloadUrl
              return (
                <div key={f.path} style={{ display: 'flex', justifyContent: 'space-between', padding: 6, borderBottom: '1px solid #eee' }}>
                  <div>
                    <div style={{ fontFamily: 'monospace' }}>{f.name}</div>
                    <div style={{ fontSize: 11, color: '#999' }}>{new Date(f.mtime).toISOString().slice(0, 16).replace('T', ' ')}</div>
                  </div>
                  <Button size="small" onClick={() => { onChange(picked); Modal.destroyAll() }}>选</Button>
                </div>
              )
            })}
          </div>
        ),
      })
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '仓库不可达')
    } finally {
      setLoading(false)
    }
  }
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ marginBottom: 4, fontSize: 12 }}>
        <strong>{input.name}</strong> <span style={{ color: '#999' }}>→ vars.{input.outputVar}</span>
      </div>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          placeholder={input.default ? `默认: ${input.default}` : '从仓库选或直接粘贴值'}
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{ flex: 1 }}
        />
        <Button loading={loading} onClick={openPicker}>从仓库选</Button>
      </Space.Compact>
    </div>
  )
}
