// web/src/pages/E2eRunsPage.tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Card, Table, Tag, Button, Space, Modal, Form, Select,
  InputNumber, Collapse, Radio, Input, message, Typography, Popconfirm,
} from 'antd'
import { PlusOutlined, ReloadOutlined, StopOutlined, ExclamationCircleTwoTone } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { ColumnsType } from 'antd/es/table'
import Editor from '@monaco-editor/react'
import { e2eRunsApi, type E2eRunDTO, type ScenarioOption } from '../api/e2e-runs'
import { e2eApi, type E2eTargetProject } from '../api/e2e'
import { e2ePlaybookDraftsApi, openDraftStream, type DraftStatus } from '../api/e2e-playbook-drafts'

const { Link, Text } = Typography

const RUN_STATUS_CONFIG: Record<E2eRunDTO['status'], { color: string; label: string }> = {
  pending:       { color: 'default',    label: '等待中' },
  running:       { color: 'processing', label: '运行中' },
  awaiting_fix:  { color: 'warning',    label: '等待修复' },
  passed:        { color: 'success',    label: '通过' },
  failed:        { color: 'error',      label: '失败' },
  aborted:       { color: 'default',    label: '已中止' },
}

function RunStatusTag({ status }: { status: E2eRunDTO['status'] }) {
  const cfg = RUN_STATUS_CONFIG[status] ?? { color: 'default', label: status }
  return <Tag color={cfg.color}>{cfg.label}</Tag>
}

type ScenarioFilterMode = 'all' | 'tag' | 'id'

interface CreateFormValues {
  targetProjectId: string
  sourceBranch: string
  triggerMode: 'select' | 'ai'
  filterMode: ScenarioFilterMode
  filterTags: string[]
  filterIds: string[]
  scenarioInput?: string
  maxPerScenarioAttempts?: number
  maxRunHours?: number
  maxTotalAttempts?: number
}

function buildBranchOptions(branches: string[], currentValue: string | undefined, defaultBranch: string | null) {
  const set = new Set(branches)
  const options = branches.map((b) => ({
    value: b,
    label: b === defaultBranch
      ? <span>{b} <Tag color="blue" style={{ marginLeft: 4 }}>default</Tag></span>
      : <span>{b}</span>,
  }))
  if (currentValue && !set.has(currentValue)) {
    options.unshift({
      value: currentValue,
      label: (
        <span>
          <ExclamationCircleTwoTone twoToneColor="#faad14" /> {currentValue}（不在当前仓库）
        </span>
      ),
    })
  }
  return options
}

function buildTagOptions(allTags: string[], currentValues: string[] | undefined) {
  const set = new Set(allTags)
  const options: Array<{ value: string; label: React.ReactNode }> = allTags.map((t) => ({
    value: t,
    label: <span>{t}</span>,
  }))
  for (const v of currentValues ?? []) {
    if (!set.has(v)) {
      options.push({
        value: v,
        label: (
          <span>
            <ExclamationCircleTwoTone twoToneColor="#faad14" /> {v}（不在当前分支 playbook）
          </span>
        ),
      })
    }
  }
  return options
}

function buildScenarioOptions(scenarios: ScenarioOption[], currentValues: string[] | undefined) {
  const known = new Map(scenarios.map((s) => [s.id, s]))
  const options: Array<{ value: string; label: React.ReactNode; searchText: string }> = scenarios.map((s) => ({
    value: s.id,
    label: (
      <span>
        {s.name} <span style={{ color: '#999', fontSize: 11 }}>({s.id})</span>
        {s.tags.length > 0 && (
          <span style={{ marginLeft: 6 }}>
            {s.tags.map((t) => <Tag key={t} style={{ marginRight: 2 }}>{t}</Tag>)}
          </span>
        )}
      </span>
    ),
    searchText: `${s.id} ${s.name} ${s.tags.join(' ')}`.toLowerCase(),
  }))
  for (const v of currentValues ?? []) {
    if (!known.has(v)) {
      options.push({
        value: v,
        label: (
          <span>
            <ExclamationCircleTwoTone twoToneColor="#faad14" /> {v}（不在当前分支 playbook）
          </span>
        ),
        searchText: v.toLowerCase(),
      })
    }
  }
  return options
}

function CreateRunModal({
  open,
  targets,
  onClose,
  onCreated,
}: {
  open: boolean
  targets: E2eTargetProject[]
  onClose: () => void
  onCreated: () => void
}) {
  const navigate = useNavigate()
  const [form] = Form.useForm<CreateFormValues>()
  const [loading, setLoading] = useState(false)
  const triggerMode = Form.useWatch('triggerMode', form) as 'select' | 'ai' | undefined
  const filterMode = Form.useWatch('filterMode', form) as ScenarioFilterMode | undefined
  const targetProjectId = Form.useWatch('targetProjectId', form) as string | undefined
  const sourceBranch = Form.useWatch('sourceBranch', form) as string | undefined
  const filterTags = Form.useWatch('filterTags', form) as string[] | undefined
  const filterIds = Form.useWatch('filterIds', form) as string[] | undefined

  const [branches, setBranches] = useState<string[]>([])
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null)
  const [branchesLoading, setBranchesLoading] = useState(false)

  const [scenarios, setScenarios] = useState<ScenarioOption[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const [scenarioOptsLoading, setScenarioOptsLoading] = useState(false)

  // AI mode state
  const [draftId, setDraftId] = useState<string | null>(null)
  const [draftStatus, setDraftStatus] = useState<DraftStatus | null>(null)
  const [yamlContent, setYamlContent] = useState<string>('')
  const [generatingDraft, setGeneratingDraft] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  // cleanup EventSource on unmount or modal close
  const closeEs = () => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
  }

  useEffect(() => {
    if (!open) {
      closeEs()
    }
    return closeEs
  }, [open])

  const resetDraftState = () => {
    closeEs()
    setDraftId(null)
    setDraftStatus(null)
    setYamlContent('')
    setGeneratingDraft(false)
  }

  // targetProjectId 变化 → 加载分支清单 + 重置 sourceBranch
  useEffect(() => {
    if (!targetProjectId) {
      setBranches([])
      setDefaultBranch(null)
      return
    }
    let canceled = false
    setBranchesLoading(true)
    e2eApi.listBranches(targetProjectId).then((res) => {
      if (canceled) return
      setBranches(res.branches)
      setDefaultBranch(res.defaultBranch)
      const cur = form.getFieldValue('sourceBranch') as string | undefined
      if (!cur || !res.branches.includes(cur)) {
        form.setFieldValue('sourceBranch', res.defaultBranch)
      }
      // 切项目时清空场景过滤选择（旧值多半不在新仓库）
      form.setFieldsValue({ filterIds: [], filterTags: [] })
    }).catch(() => {
      if (canceled) return
      message.error('加载分支列表失败')
      setBranches([])
    }).finally(() => {
      if (!canceled) setBranchesLoading(false)
    })
    return () => { canceled = true }
  }, [targetProjectId, form])

  // (targetProjectId, sourceBranch) 变化 → 加载 scenarios + tags
  useEffect(() => {
    if (!targetProjectId || !sourceBranch) {
      setScenarios([])
      setAllTags([])
      return
    }
    let canceled = false
    setScenarioOptsLoading(true)
    e2eRunsApi.listScenarioOptions(targetProjectId, sourceBranch).then((res) => {
      if (canceled) return
      setScenarios(res.scenarios)
      setAllTags(res.allTags)
    }).catch(() => {
      if (canceled) return
      setScenarios([])
      setAllTags([])
    }).finally(() => {
      if (!canceled) setScenarioOptsLoading(false)
    })
    return () => { canceled = true }
  }, [targetProjectId, sourceBranch])

  const startDraftGeneration = (id: string) => {
    closeEs()
    setDraftStatus('drafting')
    setYamlContent('')
    const es = openDraftStream(id, {
      onChunk: (t) => setYamlContent(prev => prev + t),
      onDone: async () => {
        try {
          const d = await e2ePlaybookDraftsApi.get(id)
          setYamlContent(d.yamlContent ?? '')
          setDraftStatus(d.status)
        } catch {
          setDraftStatus('generation_failed')
        }
      },
      onError: (m) => {
        setDraftStatus('generation_failed')
        message.error(m)
      },
    })
    esRef.current = es
  }

  const handleGenerateDraft = async () => {
    const values = form.getFieldsValue()
    if (!values.targetProjectId || !values.scenarioInput?.trim()) {
      message.warning('请先选择被测项目并填写场景描述')
      return
    }
    setGeneratingDraft(true)
    try {
      const { draftId: id } = await e2ePlaybookDraftsApi.create({
        targetProjectId: values.targetProjectId,
        scenarioInput: values.scenarioInput.trim(),
      })
      setDraftId(id)
      startDraftGeneration(id)
    } catch {
      message.error('创建 draft 失败')
    } finally {
      setGeneratingDraft(false)
    }
  }

  const handleRegenerate = async () => {
    if (!draftId) return
    try {
      await e2ePlaybookDraftsApi.regenerate(draftId)
      startDraftGeneration(draftId)
    } catch {
      message.error('重新生成失败')
    }
  }

  const handleSaveYaml = async () => {
    if (!draftId) return
    try {
      await e2ePlaybookDraftsApi.updateYaml(draftId, yamlContent)
      message.success('已保存')
    } catch {
      message.error('保存失败')
    }
  }

  const handleRejectDraft = async () => {
    if (!draftId) return
    try {
      await e2ePlaybookDraftsApi.reject(draftId)
      resetDraftState()
    } catch {
      message.error('拒绝失败')
    }
  }

  const handleOk = async () => {
    const values = await form.validateFields()
    setLoading(true)
    try {
      if (triggerMode === 'ai') {
        const { runId } = await e2eRunsApi.create({
          targetProjectId: values.targetProjectId,
          sourceBranch: values.sourceBranch,
          playbookDraftId: draftId!,
        })
        message.success('Run 已创建')
        form.resetFields()
        resetDraftState()
        onCreated()
        onClose()
        navigate(`/e2e-runs/${runId}`)
      } else {
        const body = buildCreateBody(values)
        await e2eRunsApi.create(body)
        message.success('Run 已创建')
        form.resetFields()
        onCreated()
        onClose()
      }
    } catch {
      message.error('创建失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    resetDraftState()
    form.resetFields()
    onClose()
  }

  const isOkDisabled = triggerMode === 'ai' && !(draftId && draftStatus === 'reviewing')

  return (
    <Modal
      title="新建 E2E Run"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      confirmLoading={loading}
      okButtonProps={{ disabled: isOkDisabled }}
      width={600}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ triggerMode: 'select', filterMode: 'all', filterTags: [], filterIds: [] }}
      >
        <Form.Item name="targetProjectId" label="被测项目" rules={[{ required: true }]}>
          <Select
            options={targets.map(t => ({ value: t.id, label: t.displayName }))}
            placeholder="选择项目"
            showSearch
            filterOption={(input, opt) =>
              String(opt?.label ?? '').toLowerCase().includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item label="触发模式" name="triggerMode" initialValue="select">
          <Radio.Group onChange={(e) => {
            const mode = e.target.value as 'select' | 'ai'
            if (mode === 'select') {
              form.setFieldsValue({ scenarioInput: undefined })
              resetDraftState()
            } else {
              form.setFieldsValue({ filterTags: undefined, filterIds: undefined })
            }
          }}>
            <Radio.Button value="select">选择已有场景</Radio.Button>
            <Radio.Button value="ai">手动输入场景（AI 生成）</Radio.Button>
          </Radio.Group>
        </Form.Item>

        <Form.Item name="sourceBranch" label="源分支" rules={[{ required: true, message: '请选择源分支' }]}>
          <Select
            showSearch
            loading={branchesLoading}
            placeholder={targetProjectId ? '选择分支' : '请先选择被测项目'}
            disabled={!targetProjectId}
            options={buildBranchOptions(branches, sourceBranch, defaultBranch)}
            filterOption={(input, opt) =>
              String((opt as { value?: string } | undefined)?.value ?? '').toLowerCase().includes(input.toLowerCase())
            }
            notFoundContent={branchesLoading ? '加载中…' : '无可用分支'}
          />
        </Form.Item>

        {triggerMode === 'select' && (
          <>
            <Form.Item name="filterMode" label="场景过滤">
              <Radio.Group>
                <Radio value="all">全部</Radio>
                <Radio value="tag">按 tag</Radio>
                <Radio value="id">按 ID</Radio>
              </Radio.Group>
            </Form.Item>
            {filterMode === 'tag' && (
              <Form.Item
                name="filterTags"
                label="Tag 列表"
                rules={[{ required: true, type: 'array', min: 1, message: '请至少选一个 tag' }]}
              >
                <Select
                  mode="multiple"
                  showSearch
                  loading={scenarioOptsLoading}
                  placeholder="选择 tag"
                  options={buildTagOptions(allTags, filterTags)}
                  filterOption={(input, opt) =>
                    String((opt as { value?: string } | undefined)?.value ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={scenarioOptsLoading ? '加载中…' : '该分支 playbook 无 tag'}
                />
              </Form.Item>
            )}
            {filterMode === 'id' && (
              <Form.Item
                name="filterIds"
                label="场景列表"
                rules={[{ required: true, type: 'array', min: 1, message: '请至少选一个场景' }]}
              >
                <Select
                  mode="multiple"
                  showSearch
                  loading={scenarioOptsLoading}
                  placeholder="选择场景"
                  options={buildScenarioOptions(scenarios, filterIds)}
                  filterOption={(input, opt) =>
                    String((opt as { searchText?: string } | undefined)?.searchText ?? '').toLowerCase().includes(input.toLowerCase())
                  }
                  notFoundContent={scenarioOptsLoading ? '加载中…' : '该分支无 scenario'}
                />
              </Form.Item>
            )}
          </>
        )}

        {triggerMode === 'ai' && (
          <>
            <Form.Item
              name="scenarioInput"
              label="场景描述"
              rules={[{ required: triggerMode === 'ai', message: '请填写场景描述' }]}
            >
              <Input.TextArea
                rows={6}
                placeholder="测试登录页：输入 admin / chatops123 后跳转到 /product-lines，验证表头显示『产线管理』"
              />
            </Form.Item>

            {(!draftId || draftStatus === 'generation_failed') && (
              <Form.Item>
                <Button
                  type="primary"
                  loading={generatingDraft}
                  onClick={handleGenerateDraft}
                >
                  生成 playbook
                </Button>
              </Form.Item>
            )}

            {draftId && (
              <>
                <Form.Item label="生成的 Playbook YAML">
                  <Editor
                    height={280}
                    language="yaml"
                    value={yamlContent}
                    onChange={(v) => setYamlContent(v ?? '')}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      readOnly: draftStatus === 'drafting',
                    }}
                  />
                </Form.Item>

                {draftStatus === 'reviewing' && (
                  <Form.Item>
                    <Space>
                      <Button onClick={handleRegenerate}>重新生成</Button>
                      <Button type="primary" onClick={handleSaveYaml}>保存修改</Button>
                      <Button danger onClick={handleRejectDraft}>拒绝</Button>
                    </Space>
                  </Form.Item>
                )}
              </>
            )}
          </>
        )}

        <Collapse
          size="small"
          style={{ marginTop: 8 }}
          items={[{
            key: 'governor',
            label: 'Governor 覆盖（高级）',
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Form.Item name="maxPerScenarioAttempts" label="单场景最大重试次数" style={{ marginBottom: 0 }}>
                  <InputNumber min={1} max={20} style={{ width: '100%' }} placeholder="默认 3" />
                </Form.Item>
                <Form.Item name="maxRunHours" label="最大运行时长（小时）" style={{ marginBottom: 0 }}>
                  <InputNumber min={1} max={24} style={{ width: '100%' }} placeholder="默认 4" />
                </Form.Item>
                <Form.Item name="maxTotalAttempts" label="全局最大总尝试次数" style={{ marginBottom: 0 }}>
                  <InputNumber min={1} max={200} style={{ width: '100%' }} placeholder="默认 30" />
                </Form.Item>
              </Space>
            ),
          }]}
        />
      </Form>
    </Modal>
  )
}

function buildCreateBody(values: CreateFormValues) {
  const body: Parameters<typeof e2eRunsApi.create>[0] = {
    targetProjectId: values.targetProjectId,
    sourceBranch: values.sourceBranch,
  }
  if (values.filterMode === 'tag' && values.filterTags?.length) {
    body.scenarioFilter = { tags: values.filterTags }
  }
  if (values.filterMode === 'id' && values.filterIds?.length) {
    body.scenarioFilter = { ids: values.filterIds }
  }
  const overrides: NonNullable<typeof body.governorOverrides> = {}
  if (values.maxPerScenarioAttempts != null) overrides.maxPerScenarioAttempts = values.maxPerScenarioAttempts
  if (values.maxRunHours != null) overrides.maxRunHours = values.maxRunHours
  if (values.maxTotalAttempts != null) overrides.maxTotalAttempts = values.maxTotalAttempts
  if (Object.keys(overrides).length > 0) body.governorOverrides = overrides
  return body
}

const ACTIVE_STATUSES = new Set<E2eRunDTO['status']>(['running', 'awaiting_fix'])

export default function E2eRunsPage() {
  const navigate = useNavigate()
  const [runs, setRuns] = useState<E2eRunDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [targets, setTargets] = useState<E2eTargetProject[]>([])
  const [targetMap, setTargetMap] = useState<Record<string, string>>({})
  const [createOpen, setCreateOpen] = useState(false)
  const [aborting, setAborting] = useState<Set<string>>(new Set())

  const load = useCallback(async (p = page) => {
    setLoading(true)
    try {
      const { runs: data, total: t } = await e2eRunsApi.list({
        limit: pageSize,
        offset: (p - 1) * pageSize,
      })
      setRuns(data)
      setTotal(t)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => {
    e2eApi.listTargets().then(list => {
      setTargets(list)
      setTargetMap(Object.fromEntries(list.map(t => [t.id, t.displayName])))
    }).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const hasActive = runs.some(r => ACTIVE_STATUSES.has(r.status))
    if (!hasActive) return
    const timer = setInterval(() => load(), 5000)
    return () => clearInterval(timer)
  }, [runs, load])

  const handleAbort = async (run: E2eRunDTO) => {
    setAborting(prev => new Set(prev).add(run.id))
    try {
      await e2eRunsApi.abort(run.id)
      message.success(`Run #${run.id} 已发送中止指令`)
      await load()
    } catch {
      message.error('中止失败')
    } finally {
      setAborting(prev => { const s = new Set(prev); s.delete(run.id); return s })
    }
  }

  const columns: ColumnsType<E2eRunDTO> = [
    {
      title: 'Run ID',
      dataIndex: 'id',
      render: (id: string) => (
        <Link onClick={() => navigate(`/e2e-runs/${id}`)}>#{id}</Link>
      ),
    },
    {
      title: '项目',
      dataIndex: 'targetProjectId',
      render: (id: string) => targetMap[id] ?? id,
    },
    {
      title: '源分支',
      dataIndex: 'sourceBranch',
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: '触发方式',
      dataIndex: 'triggerType',
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (status: E2eRunDTO['status']) => <RunStatusTag status={status} />,
    },
    {
      title: '迭代分支',
      dataIndex: 'iterationBranch',
      render: (branch: string) =>
        branch ? (
          <Link href={`https://gitlab.example.com/-/tree/${branch}`} target="_blank">
            <Text code>{branch}</Text>
          </Link>
        ) : <Text type="secondary">—</Text>,
    },
    {
      title: '启动时间',
      dataIndex: 'startedAt',
      render: (d: string) => new Date(d).toLocaleString(),
    },
    {
      title: '操作',
      render: (_: unknown, run: E2eRunDTO) => {
        const canAbort = ACTIVE_STATUSES.has(run.status)
        return (
          <Space size="small">
            {canAbort && (
              <Popconfirm
                title="确认中止此 Run？"
                onConfirm={() => handleAbort(run)}
                okText="中止"
                cancelText="取消"
                okButtonProps={{ danger: true }}
              >
                <Button
                  size="small"
                  danger
                  icon={<StopOutlined />}
                  loading={aborting.has(run.id)}
                >
                  中止
                </Button>
              </Popconfirm>
            )}
          </Space>
        )
      },
    },
  ]

  return (
    <Card
      title="E2E 测试 Runs"
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => load()} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建 Run
          </Button>
        </Space>
      }
    >
      <Table
        rowKey="id"
        columns={columns}
        dataSource={runs}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          onChange: p => { setPage(p); load(p) },
          showTotal: t => `共 ${t} 条`,
        }}
        locale={{ emptyText: '暂无 E2E Run 记录' }}
      />
      <CreateRunModal
        open={createOpen}
        targets={targets}
        onClose={() => setCreateOpen(false)}
        onCreated={() => load(1)}
      />
    </Card>
  )
}
