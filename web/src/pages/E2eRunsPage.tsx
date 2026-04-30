// web/src/pages/E2eRunsPage.tsx
import { useState, useEffect, useCallback } from 'react'
import {
  Table, Tag, Button, Space, Modal, Form, Select, Input,
  InputNumber, Collapse, Radio, message, Typography, Popconfirm,
} from 'antd'
import { PlusOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { ColumnsType } from 'antd/es/table'
import { e2eRunsApi, type E2eRunDTO } from '../api/e2e-runs'
import { e2eApi, type E2eTargetProject } from '../api/e2e'

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
  filterMode: ScenarioFilterMode
  filterTags: string
  filterIds: string
  maxPerScenarioAttempts?: number
  maxRunHours?: number
  maxTotalAttempts?: number
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
  const [form] = Form.useForm<CreateFormValues>()
  const [loading, setLoading] = useState(false)
  const filterMode = Form.useWatch('filterMode', form) as ScenarioFilterMode | undefined

  const handleOk = async () => {
    const values = await form.validateFields()
    setLoading(true)
    try {
      const body = buildCreateBody(values)
      await e2eRunsApi.create(body)
      message.success('Run 已创建')
      form.resetFields()
      onCreated()
      onClose()
    } catch {
      message.error('创建失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title="新建 E2E Run"
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={loading}
      width={520}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ sourceBranch: 'main', filterMode: 'all' }}
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
        <Form.Item name="sourceBranch" label="源分支" rules={[{ required: true }]}>
          <Input placeholder="main" />
        </Form.Item>
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
            extra="多个 tag 用英文逗号分隔"
            rules={[{ required: true, message: '请输入至少一个 tag' }]}
          >
            <Input placeholder="smoke,login" />
          </Form.Item>
        )}
        {filterMode === 'id' && (
          <Form.Item
            name="filterIds"
            label="场景 ID 列表"
            extra="多个 ID 用英文逗号分隔"
            rules={[{ required: true, message: '请输入至少一个场景 ID' }]}
          >
            <Input placeholder="login-success,checkout-flow" />
          </Form.Item>
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
  if (values.filterMode === 'tag' && values.filterTags) {
    body.scenarioFilter = { tags: values.filterTags.split(',').map(s => s.trim()).filter(Boolean) }
  }
  if (values.filterMode === 'id' && values.filterIds) {
    body.scenarioFilter = { ids: values.filterIds.split(',').map(s => s.trim()).filter(Boolean) }
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
        if (!canAbort) return null
        return (
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
        )
      },
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>E2E 测试 Runs</Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => load()} loading={loading}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            新建 Run
          </Button>
        </Space>
      </Space>
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
    </div>
  )
}
