# E2E Pipeline B — 前端 UI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 /e2e-runs 列表页（含新建 Modal）和 /e2e-runs/:runId 详情页（场景时间线 + evidence Drawer + 5s polling + 中止按钮）。

**Architecture:** React 18 + Ant Design 5；状态本地管理（useState/useEffect），无全局 store；API 层 axios；5s polling 只在 run 进行中时启用；evidence 文件通过 Fastify 静态路由直接 img/fetch 访问。

**Tech Stack:** React 18, Ant Design 5, React Router v6, axios, TypeScript

**前置条件:** Plan B7（Admin API e2e-runs）完成

---

## 文件地图

| 操作 | 路径 |
|---|---|
| 新建 | `web/src/api/e2e-runs.ts` |
| 新建 | `web/src/pages/E2eRunsPage.tsx` |
| 新建 | `web/src/pages/E2eRunDetailPage.tsx` |
| 修改 | `web/src/App.tsx`（添加两条路由） |
| 修改 | `web/src/layout/AdminLayout.tsx`（侧边栏加 e2e-runs 子菜单） |

---

## Task 1: API 层

**Files:**
- 新建: `web/src/api/e2e-runs.ts`

- [ ] **Step 1: 定义 DTO 类型 + API 函数**

```typescript
// web/src/api/e2e-runs.ts
import client from './client'

export interface E2eRunDTO {
  id: string
  targetProjectId: string
  triggerType: string
  triggerActor: string | null
  sourceBranch: string
  iterationBranch: string
  status: 'pending' | 'running' | 'awaiting_fix' | 'passed' | 'failed' | 'aborted'
  governorState: {
    perScenarioAttempts: Record<string, number>
    totalAttempts: number
    runStartedAt: number
    limits: {
      maxPerScenarioAttempts: number
      maxRunHours: number
      maxTotalAttempts: number
    }
  }
  summaryMrUrl: string | null
  startedAt: string
  finishedAt: string | null
  abortReason: string | null
}

export interface E2eSandboxDTO {
  id: string
  kind: string
  handle: {
    envId: string
    endpoints: Record<string, string>
    modules?: Array<{ name: string; host: string; port: number }>
  }
  status: 'provisioning' | 'ready' | 'redeploying' | 'torn_down' | 'failed'
}

export interface AiDiagnosis {
  verdict: string
  rootCauseSummary: string
  fixCommitSha: string | null
  fixedFiles: string[]
  success: boolean
  failureReason: string
}

export interface EvidenceArtifact {
  kind: string
  mimeType: string
  path: string
  description: string
  module?: string
}

export interface EvidenceManifest {
  summary: string
  contextHint: string
  artifacts: EvidenceArtifact[]
  aiDiagnosis?: AiDiagnosis
}

export interface E2eScenarioRunDTO {
  id: string
  scenarioId: string
  scenarioName: string | null
  attemptNumber: number
  result: 'pass' | 'fail' | 'error' | 'timeout' | 'skipped' | 'unfixable'
  durationMs: number | null
  evidenceManifest: EvidenceManifest | null
  evidenceDirUri: string | null
  startedAt: string
  finishedAt: string | null
}

export interface E2eRunDetailResponse {
  run: E2eRunDTO
  sandbox: E2eSandboxDTO | null
  scenarioRuns: E2eScenarioRunDTO[]
}

export interface CreateRunBody {
  targetProjectId: string
  sourceBranch?: string
  scenarioFilter?: {
    ids?: string[]
    tags?: string[]
  }
  governorOverrides?: {
    maxPerScenarioAttempts?: number
    maxRunHours?: number
    maxTotalAttempts?: number
  }
}

export const e2eRunsApi = {
  list: (params: { projectId?: string; limit?: number; offset?: number }) =>
    client.get<{ runs: E2eRunDTO[]; total: number }>('/e2e-runs', { params }).then(r => r.data),

  get: (runId: string) =>
    client.get<E2eRunDetailResponse>(`/e2e-runs/${runId}`).then(r => r.data),

  create: (body: CreateRunBody) =>
    client.post<{ runId: string; status: string }>('/e2e-runs', body).then(r => r.data),

  abort: (runId: string, reason?: string) =>
    client.post<{ ok: true }>(`/e2e-runs/${runId}/abort`, { reason }).then(r => r.data),
}
```

---

## Task 2: 列表页（E2eRunsPage.tsx）— 表格 + 新建 Modal

**Files:**
- 新建: `web/src/pages/E2eRunsPage.tsx`

- [ ] **Step 1: 状态常量 + RunStatus Tag 组件**

```typescript
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
```

- [ ] **Step 2: 新建 Run Modal 表单**

```typescript
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
```

- [ ] **Step 3: 主页面组件**

```typescript
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
```

---

## Task 3: 详情页（E2eRunDetailPage.tsx）— 头部/沙盒/场景时间线/5s polling

**Files:**
- 新建: `web/src/pages/E2eRunDetailPage.tsx`（Task 4 的 Evidence Drawer 也在此文件内）

- [ ] **Step 1: 工具函数 + 状态常量**

```typescript
// web/src/pages/E2eRunDetailPage.tsx
import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Card, Tag, Button, Space, Typography, Descriptions, Spin, message,
  Collapse, Drawer, List, Image, Divider, Badge, Popconfirm,
} from 'antd'
import {
  ArrowLeftOutlined, ReloadOutlined, StopOutlined,
  CheckCircleOutlined, CloseCircleOutlined, SyncOutlined,
  ClockCircleOutlined, MinusCircleOutlined,
} from '@ant-design/icons'
import {
  e2eRunsApi,
  type E2eRunDTO,
  type E2eSandboxDTO,
  type E2eScenarioRunDTO,
  type EvidenceManifest,
  type EvidenceArtifact,
} from '../api/e2e-runs'

const { Title, Text, Link, Paragraph } = Typography

const RUN_STATUS_CONFIG: Record<E2eRunDTO['status'], { color: string; label: string }> = {
  pending:       { color: 'default',    label: '等待中' },
  running:       { color: 'processing', label: '运行中' },
  awaiting_fix:  { color: 'warning',    label: '等待修复' },
  passed:        { color: 'success',    label: '通过' },
  failed:        { color: 'error',      label: '失败' },
  aborted:       { color: 'default',    label: '已中止' },
}

const SCENARIO_RESULT_CONFIG: Record<E2eScenarioRunDTO['result'], { icon: React.ReactNode; color: string; label: string }> = {
  pass:      { icon: <CheckCircleOutlined />, color: '#52c41a', label: '通过' },
  fail:      { icon: <CloseCircleOutlined />, color: '#ff4d4f', label: '失败' },
  error:     { icon: <CloseCircleOutlined />, color: '#ff4d4f', label: '错误' },
  timeout:   { icon: <ClockCircleOutlined />, color: '#faad14', label: '超时' },
  skipped:   { icon: <MinusCircleOutlined />, color: '#d9d9d9', label: '跳过' },
  unfixable: { icon: <CloseCircleOutlined />, color: '#722ed1', label: '无法修复' },
}

const SANDBOX_STATUS_COLOR: Record<E2eSandboxDTO['status'], string> = {
  provisioning: 'processing',
  ready:        'success',
  redeploying:  'warning',
  torn_down:    'default',
  failed:       'error',
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function formatElapsed(startMs: number): string {
  const elapsed = Date.now() - startMs
  const h = Math.floor(elapsed / 3_600_000)
  const m = Math.floor((elapsed % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

const ACTIVE_STATUSES = new Set<E2eRunDTO['status']>(['running', 'awaiting_fix', 'pending'])
```

- [ ] **Step 2: 头部 Card**

```typescript
function RunHeader({
  run,
  projectName,
  onAbort,
  onRefresh,
  aborting,
}: {
  run: E2eRunDTO
  projectName: string
  onAbort: () => void
  onRefresh: () => void
  aborting: boolean
}) {
  const statusCfg = RUN_STATUS_CONFIG[run.status] ?? { color: 'default', label: run.status }
  const gs = run.governorState
  const elapsed = formatElapsed(gs.runStartedAt)

  return (
    <Card style={{ marginBottom: 16 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <Space wrap>
          <Title level={5} style={{ margin: 0 }}>
            Run #{run.id} · {projectName}
          </Title>
          <Tag color={statusCfg.color}>{statusCfg.label}</Tag>
        </Space>
        <Space wrap>
          <Text type="secondary">
            尝试 {gs.totalAttempts}/{gs.limits.maxTotalAttempts} ·
            用时 {elapsed} / {gs.limits.maxRunHours}h ·
            单场景重试 ≤ {gs.limits.maxPerScenarioAttempts}
          </Text>
        </Space>
        <Space wrap>
          <Text type="secondary">源分支：</Text>
          <Text code>{run.sourceBranch}</Text>
          <Text type="secondary">迭代分支：</Text>
          {run.iterationBranch ? (
            <Link
              href={`https://gitlab.example.com/-/tree/${run.iterationBranch}`}
              target="_blank"
            >
              <Text code>{run.iterationBranch}</Text>
            </Link>
          ) : <Text type="secondary">—</Text>}
        </Space>
        {run.summaryMrUrl && (
          <Space>
            <Text type="secondary">汇总 MR：</Text>
            <Link href={run.summaryMrUrl} target="_blank">查看 MR</Link>
          </Space>
        )}
        {run.abortReason && (
          <Text type="danger">中止原因：{run.abortReason}</Text>
        )}
        <Space>
          <Button icon={<ReloadOutlined />} size="small" onClick={onRefresh}>刷新</Button>
          {ACTIVE_STATUSES.has(run.status) && (
            <Popconfirm
              title="确认中止此 Run？"
              onConfirm={onAbort}
              okText="中止"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                loading={aborting}
              >
                中止
              </Button>
            </Popconfirm>
          )}
        </Space>
      </Space>
    </Card>
  )
}
```

- [ ] **Step 3: 沙盒 Card**

```typescript
function SandboxCard({ sandbox }: { sandbox: E2eSandboxDTO }) {
  const statusColor = SANDBOX_STATUS_COLOR[sandbox.status] ?? 'default'
  const { handle } = sandbox

  return (
    <Card title="沙盒" size="small" style={{ marginBottom: 16 }}>
      <Descriptions column={2} size="small">
        <Descriptions.Item label="类型">{sandbox.kind}</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color={statusColor}>{sandbox.status}</Tag>
        </Descriptions.Item>
        <Descriptions.Item label="环境 ID">{handle.envId}</Descriptions.Item>
      </Descriptions>
      {Object.keys(handle.endpoints).length > 0 && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>Endpoints</Text>
          <div style={{ marginTop: 4 }}>
            {Object.entries(handle.endpoints).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                <Text code style={{ minWidth: 80 }}>{k}</Text>
                <Link href={v} target="_blank">{v}</Link>
              </div>
            ))}
          </div>
        </>
      )}
      {handle.modules && handle.modules.length > 0 && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>Modules</Text>
          <div style={{ marginTop: 4 }}>
            {handle.modules.map(m => (
              <div key={m.name} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                <Text code style={{ minWidth: 120 }}>{m.name}</Text>
                <Text>{m.host}:{m.port}</Text>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}
```

- [ ] **Step 4: 场景时间线**

```typescript
function groupByScenario(
  scenarioRuns: E2eScenarioRunDTO[],
): Map<string, E2eScenarioRunDTO[]> {
  const map = new Map<string, E2eScenarioRunDTO[]>()
  for (const sr of scenarioRuns) {
    const list = map.get(sr.scenarioId) ?? []
    list.push(sr)
    map.set(sr.scenarioId, list)
  }
  return map
}

function getScenarioIcon(attempts: E2eScenarioRunDTO[]): React.ReactNode {
  const last = attempts[attempts.length - 1]
  if (!last) return <ClockCircleOutlined style={{ color: '#d9d9d9' }} />
  const cfg = SCENARIO_RESULT_CONFIG[last.result]
  if (last.result === 'pass') return <CheckCircleOutlined style={{ color: cfg.color }} />
  if (last.result === 'fail' || last.result === 'error' || last.result === 'unfixable') {
    return <CloseCircleOutlined style={{ color: cfg.color }} />
  }
  if (last.result === 'timeout') return <ClockCircleOutlined style={{ color: cfg.color }} />
  return <MinusCircleOutlined style={{ color: cfg.color }} />
}

function ScenarioTimeline({
  scenarioRuns,
  onViewEvidence,
}: {
  scenarioRuns: E2eScenarioRunDTO[]
  onViewEvidence: (sr: E2eScenarioRunDTO) => void
}) {
  const groups = groupByScenario(scenarioRuns)

  if (groups.size === 0) {
    return (
      <Card title="场景时间线" size="small">
        <Text type="secondary">暂无场景执行记录</Text>
      </Card>
    )
  }

  const collapseItems = Array.from(groups.entries()).map(([scenarioId, attempts]) => {
    const last = attempts[attempts.length - 1]
    const lastCfg = last ? SCENARIO_RESULT_CONFIG[last.result] : null
    const scenarioName = last?.scenarioName ?? scenarioId
    const isRunning = !last?.finishedAt && attempts.length > 0

    const headerExtra = (
      <Space size={4}>
        {isRunning && <SyncOutlined spin style={{ color: '#4B8BFF' }} />}
        {lastCfg && <Tag color={lastCfg.color === '#52c41a' ? 'success' : lastCfg.color === '#ff4d4f' ? 'error' : 'default'}>{lastCfg.label}</Tag>}
        <Text type="secondary" style={{ fontSize: 12 }}>{attempts.length} 次尝试</Text>
      </Space>
    )

    return {
      key: scenarioId,
      label: (
        <Space>
          {getScenarioIcon(attempts)}
          <Text strong>{scenarioName}</Text>
          {headerExtra}
        </Space>
      ),
      children: (
        <List
          size="small"
          dataSource={attempts}
          renderItem={(sr) => {
            const cfg = SCENARIO_RESULT_CONFIG[sr.result]
            return (
              <List.Item
                key={sr.id}
                actions={[
                  sr.evidenceManifest ? (
                    <Button
                      size="small"
                      type="link"
                      onClick={() => onViewEvidence(sr)}
                    >
                      查看证据
                    </Button>
                  ) : null,
                ].filter(Boolean)}
              >
                <Space>
                  <span style={{ color: cfg.color }}>{cfg.icon}</span>
                  <Text>第 {sr.attemptNumber} 次</Text>
                  <Tag
                    color={
                      sr.result === 'pass' ? 'success'
                      : sr.result === 'fail' || sr.result === 'error' ? 'error'
                      : 'default'
                    }
                  >
                    {cfg.label}
                  </Tag>
                  <Text type="secondary">{formatDuration(sr.durationMs)}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {new Date(sr.startedAt).toLocaleTimeString()}
                  </Text>
                </Space>
              </List.Item>
            )
          }}
        />
      ),
    }
  })

  return (
    <Card title="场景时间线" size="small">
      <Collapse items={collapseItems} defaultActiveKey={Array.from(groups.keys())} />
    </Card>
  )
}
```

---

## Task 4: Evidence Drawer（E2eRunDetailPage.tsx 内的 Drawer 组件）

- [ ] **Step 1: ArtifactViewer 组件（图片/文本/下载）**

```typescript
function ArtifactViewer({
  artifact,
  evidenceDirUri,
}: {
  artifact: EvidenceArtifact
  evidenceDirUri: string
}) {
  const [textContent, setTextContent] = useState<string | null>(null)
  const [textLoading, setTextLoading] = useState(false)
  const [tooLarge, setTooLarge] = useState(false)
  const src = `/admin${evidenceDirUri}/artifacts/${artifact.path}`

  useEffect(() => {
    if (!artifact.mimeType.startsWith('text/') && artifact.mimeType !== 'application/json') return
    setTextLoading(true)
    fetch(src)
      .then(async r => {
        const ct = r.headers.get('content-length')
        if (ct && parseInt(ct, 10) > 100_000) {
          setTooLarge(true)
          return null
        }
        const text = await r.text()
        if (text.length > 100_000) { setTooLarge(true); return null }
        return text
      })
      .then(t => { if (t != null) setTextContent(t) })
      .catch(() => {})
      .finally(() => setTextLoading(false))
  }, [src, artifact.mimeType])

  if (artifact.mimeType.startsWith('image/')) {
    return (
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{artifact.description}</Text>
        <br />
        <Image src={src} style={{ maxWidth: '100%', maxHeight: 320 }} />
      </div>
    )
  }

  if (artifact.mimeType.startsWith('text/') || artifact.mimeType === 'application/json') {
    return (
      <div style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{artifact.description}</Text>
        {textLoading && <Spin size="small" />}
        {tooLarge && (
          <div>
            <Text type="secondary">文件过大（&gt;100KB），</Text>
            <Link href={src} target="_blank">点此下载</Link>
          </div>
        )}
        {textContent != null && (
          <pre
            style={{
              background: '#F6F7FA',
              padding: 8,
              borderRadius: 4,
              fontSize: 11,
              maxHeight: 240,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {textContent}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 8 }}>
      <Link href={src} target="_blank">{artifact.description || artifact.path}</Link>
    </div>
  )
}
```

- [ ] **Step 2: AiDiagnosisSection 组件**

```typescript
function AiDiagnosisSection({ diagnosis }: { manifest: EvidenceManifest; diagnosis: NonNullable<EvidenceManifest['aiDiagnosis']> }) {
  return (
    <div style={{ marginTop: 12 }}>
      <Divider style={{ margin: '8px 0' }}>AI 诊断</Divider>
      <Descriptions column={1} size="small">
        <Descriptions.Item label="判定">
          <Badge
            status={diagnosis.success ? 'success' : 'error'}
            text={diagnosis.verdict}
          />
        </Descriptions.Item>
        <Descriptions.Item label="根因摘要">
          <Paragraph style={{ margin: 0 }}>{diagnosis.rootCauseSummary}</Paragraph>
        </Descriptions.Item>
        {diagnosis.fixCommitSha && (
          <Descriptions.Item label="修复 Commit">
            <Text code>{diagnosis.fixCommitSha.slice(0, 8)}</Text>
          </Descriptions.Item>
        )}
        {diagnosis.fixedFiles.length > 0 && (
          <Descriptions.Item label="修改文件">
            <Space wrap>
              {diagnosis.fixedFiles.map(f => <Text key={f} code style={{ fontSize: 11 }}>{f}</Text>)}
            </Space>
          </Descriptions.Item>
        )}
        {!diagnosis.success && diagnosis.failureReason && (
          <Descriptions.Item label="失败原因">
            <Text type="danger">{diagnosis.failureReason}</Text>
          </Descriptions.Item>
        )}
      </Descriptions>
    </div>
  )
}
```

- [ ] **Step 3: EvidenceDrawer 组件**

```typescript
function EvidenceDrawer({
  scenarioRun,
  onClose,
}: {
  scenarioRun: E2eScenarioRunDTO | null
  onClose: () => void
}) {
  const manifest = scenarioRun?.evidenceManifest
  const evidenceDirUri = scenarioRun?.evidenceDirUri

  return (
    <Drawer
      title={
        scenarioRun
          ? `证据 — ${scenarioRun.scenarioName ?? scenarioRun.scenarioId} · 第 ${scenarioRun.attemptNumber} 次`
          : '证据'
      }
      open={!!scenarioRun}
      onClose={onClose}
      width={560}
      destroyOnClose
    >
      {manifest && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {manifest.summary && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Summary</Text>
              <Paragraph style={{ marginTop: 4 }}>{manifest.summary}</Paragraph>
            </div>
          )}
          {manifest.contextHint && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Context Hint</Text>
              <Paragraph style={{ marginTop: 4 }}>{manifest.contextHint}</Paragraph>
            </div>
          )}
          {manifest.artifacts.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Artifacts（{manifest.artifacts.length} 个）</Text>
              <div style={{ marginTop: 8 }}>
                {manifest.artifacts.map((a, i) =>
                  evidenceDirUri ? (
                    <ArtifactViewer key={i} artifact={a} evidenceDirUri={evidenceDirUri} />
                  ) : (
                    <div key={i}>
                      <Text code>{a.path}</Text> — <Text type="secondary">{a.description}</Text>
                    </div>
                  )
                )}
              </div>
            </div>
          )}
          {manifest.aiDiagnosis && (
            <AiDiagnosisSection manifest={manifest} diagnosis={manifest.aiDiagnosis} />
          )}
        </Space>
      )}
    </Drawer>
  )
}
```

- [ ] **Step 4: 主页面组件（E2eRunDetailPage）**

```typescript
export default function E2eRunDetailPage() {
  const { runId } = useParams<{ runId: string }>()
  const navigate = useNavigate()
  const [run, setRun] = useState<E2eRunDTO | null>(null)
  const [sandbox, setSandbox] = useState<E2eSandboxDTO | null>(null)
  const [scenarioRuns, setScenarioRuns] = useState<E2eScenarioRunDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [aborting, setAborting] = useState(false)
  const [evidenceSr, setEvidenceSr] = useState<E2eScenarioRunDTO | null>(null)

  const fetchDetail = useCallback(async () => {
    if (!runId) return
    try {
      const { run: r, sandbox: sb, scenarioRuns: srs } = await e2eRunsApi.get(runId)
      setRun(r)
      setSandbox(sb)
      setScenarioRuns(srs)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => { fetchDetail() }, [fetchDetail])

  useEffect(() => {
    if (!run || !ACTIVE_STATUSES.has(run.status)) return
    const timer = setInterval(fetchDetail, 5000)
    return () => clearInterval(timer)
  }, [run?.status, fetchDetail])

  const handleAbort = async () => {
    if (!runId) return
    setAborting(true)
    try {
      await e2eRunsApi.abort(runId)
      message.success('已发送中止指令')
      await fetchDetail()
    } catch {
      message.error('中止失败')
    } finally {
      setAborting(false)
    }
  }

  if (loading) return <Spin style={{ display: 'block', margin: '64px auto' }} />
  if (!run) return <Text type="danger" style={{ padding: 24, display: 'block' }}>Run 不存在</Text>

  return (
    <div style={{ padding: 24, maxWidth: 960 }}>
      <Button
        type="text"
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate('/e2e-runs')}
        style={{ marginBottom: 12, paddingLeft: 0 }}
      >
        返回列表
      </Button>
      <RunHeader
        run={run}
        projectName={run.targetProjectId}
        onAbort={handleAbort}
        onRefresh={fetchDetail}
        aborting={aborting}
      />
      {sandbox && <SandboxCard sandbox={sandbox} />}
      <ScenarioTimeline
        scenarioRuns={scenarioRuns}
        onViewEvidence={setEvidenceSr}
      />
      <EvidenceDrawer
        scenarioRun={evidenceSr}
        onClose={() => setEvidenceSr(null)}
      />
    </div>
  )
}
```

---

## Task 5: 路由 + 菜单注册（App.tsx + AdminLayout.tsx）+ typecheck 验证

**Files:**
- 修改: `web/src/App.tsx`
- 修改: `web/src/layout/AdminLayout.tsx`

- [ ] **Step 1: App.tsx — 添加 lazy import 和两条路由**

在 `web/src/App.tsx` 中，在现有 `E2eSpecsPage` 的 lazy import 附近追加：

```typescript
// 在 E2eSpecsPage lazy import 之后追加
const E2eRunsPage       = lazy(() => import('./pages/E2eRunsPage'))
const E2eRunDetailPage  = lazy(() => import('./pages/E2eRunDetailPage'))
```

在路由表中，在现有 `/e2e-specs` Route 之后追加：

```tsx
<Route path="/e2e-runs" element={
  <Suspense fallback={null}><E2eRunsPage /></Suspense>
} />
<Route path="/e2e-runs/:runId" element={
  <Suspense fallback={null}><E2eRunDetailPage /></Suspense>
} />
```

- [ ] **Step 2: AdminLayout.tsx — PAGE_NAMES + menuItems**

在 `web/src/layout/AdminLayout.tsx` 中：

在 `PAGE_NAMES` 对象内，在 `'/e2e-specs': '测试规约'` 之后追加：

```typescript
'/e2e-runs': 'E2E 测试 Runs',
```

在 `menuItems` 数组最后一项（`'自动化测试'` group）的 `children` 数组末尾，追加：

```typescript
{ key: '/e2e-runs', icon: <HistoryOutlined />, label: 'E2E Runs' },
```

- [ ] **Step 3: 构建验证**

```bash
cd web && pnpm build
```

预期：TypeScript 无类型错误，Vite 构建成功，产物输出到 `web/dist/`。

若出现类型错误，按以下方向排查：
- `AiDiagnosisSection` 的 props 中 `manifest` 字段在函数体内未使用时可删去（当前接口仅保留 `diagnosis`）
- `EvidenceArtifact` 里 `src` 变量依赖 `evidenceDirUri` 非空时才渲染 `ArtifactViewer`，已在 `ScenarioTimeline` 的条件渲染中保证
- `Collapse items` 数组中的 `label` 和 `children` 是 `ReactNode`，AntD v5 `CollapseProps` 要求 `items: CollapsePanelProps[]`，若报错改用 `items` prop 显式标注 `CollapseProps['items']`

---

## 关键约定汇总

| 约定 | 说明 |
|---|---|
| API 层 | 使用 `web/src/api/client.ts`（baseURL=/admin，401→重定向 /login），不直接裸调 `axios` |
| bigint 字段 | 后端已序列化为 string，前端直接用 `string` 类型，不调 `BigInt()` |
| 5s polling | 仅在 `status ∈ {pending, running, awaiting_fix}` 时启用，页面卸载时 `clearInterval` |
| evidence 文件路径 | 拼 `/admin${evidenceDirUri}/artifacts/${artifact.path}`，由 Fastify 静态服务托管 |
| 无全局 store | 所有状态 `useState`，页面间无共享状态 |
| 样式 | 无额外 CSS，全部用 AntD Token 和 inline style |
| import 路径 | 不加 `.js` 后缀（Vite 环境不需要） |
| 注释风格 | 不写多行注释块 |
