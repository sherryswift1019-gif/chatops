import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Card, Table, Tag, Button, Space, Drawer, Descriptions,
  Modal, Form, Input, message, Select, Typography, Popconfirm, Collapse,
  Checkbox, Divider,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, CheckOutlined,
  EditOutlined, DeleteOutlined, PlayCircleOutlined, FileTextOutlined, StopOutlined,
} from '@ant-design/icons'
import MarkdownViewer from '../components/MarkdownViewer'
import type { ColumnsType } from 'antd/es/table'
import {
  requirementsApi,
  type RequirementDTO,
  type RequirementDetailDTO,
  type ApprovalWaiterDTO,
  type RequirementStatus,
} from '../api/requirements'
import { QiE2eProgress } from './QiE2eProgress'
import { StageResultsTimeline } from '../components/StageResultsTimeline'
import { WaiterTimeline } from '../components/WaiterTimeline'
import { DecideModal } from '../components/DecideModal'
import { effectiveStatus } from './requirement-detail/effectiveStatus'

const { Text, Paragraph } = Typography
const { TextArea } = Input

const STATUS_CONFIG: Record<RequirementStatus, { color: string; label: string }> = {
  draft:       { color: 'default',    label: '草稿' },
  queued:      { color: 'processing', label: '排队中' },
  spec_review: { color: 'gold',       label: '需求审核' },
  planning:    { color: 'cyan',       label: '规划中' },
  developing:  { color: 'blue',       label: '开发中' },
  reviewing:   { color: 'purple',     label: '代码审核' },
  testing:     { color: 'geekblue',   label: '测试中' },
  mr_pending:  { color: 'lime',       label: 'MR 待审' },
  mr_open:     { color: 'success',    label: 'MR 已开' },
  merged:      { color: 'success',    label: '已合入' },
  aborting:    { color: 'warning',    label: '中止中' },
  aborted:     { color: 'default',    label: '已中止' },
  failed:      { color: 'error',      label: '失败' },
}

const ALL_STATUSES: RequirementStatus[] = [
  'draft', 'queued', 'spec_review', 'planning', 'developing',
  'reviewing', 'testing', 'mr_pending', 'mr_open', 'merged',
  'aborting', 'aborted', 'failed',
]

interface DecideModalState {
  open: boolean
  waiter: ApprovalWaiterDTO | null
  requirementId: number
}

export default function RequirementsPage() {
  const [items, setItems] = useState<RequirementDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)

  // Detail drawer
  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState<RequirementDetailDTO | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Create modal
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [createLoading, setCreateLoading] = useState(false)

  // Edit modal
  const [editTarget, setEditTarget] = useState<RequirementDTO | null>(null)
  const [editForm] = Form.useForm()
  const [editLoading, setEditLoading] = useState(false)

  // Run loading per row
  const [runningIds, setRunningIds] = useState<Set<number>>(new Set())

  // Stop loading per row
  const [stoppingIds, setStoppingIds] = useState<Set<number>>(new Set())

  // Delete loading per row
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set())

  // Decide modal
  const [decideState, setDecideState] = useState<DecideModalState>({ open: false, waiter: null, requirementId: 0 })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await requirementsApi.list({ status: filterStatus, page, size: 20 })
      setItems(res.items)
      setTotal(res.total)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [filterStatus, page])

  useEffect(() => { load() }, [load])

  const openDetail = async (id: number) => {
    setDetailOpen(true)
    setDetailLoading(true)
    try {
      const d = await requirementsApi.get(id)
      setDetail(d)
    } catch {
      message.error('加载详情失败')
    } finally {
      setDetailLoading(false)
    }
  }

  // ── 直达审批 Modal：?id=N&openWaiter=M ────────────────────────────────────
  // 来源：钉钉/飞书审批卡片的"📋 审批链接"+ qi-approval-manager URL openWaiter 参数
  const [searchParams, setSearchParams] = useSearchParams()
  // 第一步：URL ?id=N → 自动打开详情抽屉
  useEffect(() => {
    const idStr = searchParams.get('id')
    if (!idStr) return
    const id = Number(idStr)
    if (!Number.isFinite(id)) return
    void openDetail(id)
    // 仅 ?id 触发；?openWaiter 由下面 useEffect 处理（依赖 detail 加载完成）
  }, [searchParams])

  // 第二步：detail 加载完且 ?openWaiter=M 在未 claim 的 waiters 中 → 自动弹决策 Modal
  useEffect(() => {
    const waiterStr = searchParams.get('openWaiter')
    if (!waiterStr || !detail) return
    const wid = Number(waiterStr)
    if (!Number.isFinite(wid)) return
    const w = detail.waiters?.find(x => x.id === wid && !x.claimedBy)
    if (!w) return
    setDecideState({ open: true, waiter: w, requirementId: detail.id })
    // 清掉 openWaiter query 参数防止刷新重复弹（保留 ?id=N 让用户能停留在抽屉）
    const next = new URLSearchParams(searchParams)
    next.delete('openWaiter')
    setSearchParams(next, { replace: true })
  }, [detail, searchParams, setSearchParams])

  // ── Create ─────────────────────────────────────────────────────────────────
  const handleCreate = async (values: { title: string; rawInput: string; gitlabProject: string; baseBranch?: string; skipE2E?: boolean }) => {
    setCreateLoading(true)
    try {
      await requirementsApi.create(values)
      message.success('需求已保存为草稿，点击「运行」启动流水线')
      setCreateOpen(false)
      createForm.resetFields()
      load()
    } catch {
      message.error('创建失败')
    } finally {
      setCreateLoading(false)
    }
  }

  // ── Edit ───────────────────────────────────────────────────────────────────
  const openEdit = (row: RequirementDTO) => {
    setEditTarget(row)
    editForm.setFieldsValue({
      title: row.title,
      rawInput: row.rawInput,
      gitlabProject: row.gitlabProject,
      baseBranch: row.baseBranch,
      skipE2E: row.skipE2E,
    })
  }

  const handleEdit = async (values: { title: string; rawInput: string; gitlabProject: string; baseBranch?: string; skipE2E?: boolean }) => {
    if (!editTarget) return
    setEditLoading(true)
    try {
      await requirementsApi.update(editTarget.id, values)
      message.success('已更新')
      setEditTarget(null)
      editForm.resetFields()
      load()
      if (detail?.id === editTarget.id) openDetail(editTarget.id)
    } catch (e: any) {
      if (e?.response?.status === 409) {
        message.error('只有草稿状态的需求可以编辑')
      } else {
        message.error('更新失败')
      }
    } finally {
      setEditLoading(false)
    }
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  const handleDelete = async (id: number) => {
    setDeletingIds(s => new Set(s).add(id))
    try {
      await requirementsApi.delete(id)
      message.success('已删除')
      load()
      if (detail?.id === id) setDetailOpen(false)
    } catch (e: any) {
      if (e?.response?.status === 409) {
        message.error('运行中的需求无法删除')
      } else {
        message.error('删除失败')
      }
    } finally {
      setDeletingIds(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  // ── Run ───────────────────────────────────────────────────────────────────
  const handleRun = async (id: number) => {
    setRunningIds(s => new Set(s).add(id))
    try {
      await requirementsApi.run(id)
      message.success('已加入队列，worker 将在 30 秒内启动流水线')
      load()
      if (detail?.id === id) openDetail(id)
    } catch (e: any) {
      const msg = e?.response?.data?.error ?? '启动失败'
      message.error(msg)
    } finally {
      setRunningIds(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  // ── Stop ──────────────────────────────────────────────────────────────────
  const STOPPABLE_STATUSES: RequirementStatus[] = [
    'queued', 'spec_review', 'planning', 'developing',
    'reviewing', 'testing', 'mr_pending', 'mr_open',
  ]

  const handleStop = async (id: number) => {
    setStoppingIds(s => new Set(s).add(id))
    try {
      await requirementsApi.abort(id)
      message.success('需求已停止')
      load()
      if (detail?.id === id) openDetail(id)
    } catch (e: any) {
      const msg = e?.response?.data?.error ?? '停止失败'
      message.error(msg)
    } finally {
      setStoppingIds(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  // ── Approve ───────────────────────────────────────────────────────────────
  const openDecide = (waiter: ApprovalWaiterDTO, requirementId: number) => {
    setDecideState({ open: true, waiter, requirementId })
  }

  const activePendingWaiter = detail?.waiters.find(w => !w.claimedBy) ?? null

  const columns: ColumnsType<RequirementDTO> = [
    { title: 'ID', dataIndex: 'id', width: 64, render: v => <Text type="secondary">#{v}</Text> },
    {
      title: '需求标题',
      dataIndex: 'title',
      render: (title, row) => (
        <Button type="link" style={{ padding: 0, fontWeight: 500 }} onClick={() => openDetail(row.id)}>
          {title}
        </Button>
      ),
    },
    {
      title: '状态',
      width: 140,
      render: (_, row) => {
        // 列表项是 RequirementDTO，没有 waiters/stageResults，effectiveStatus 退化为按 status 兜底
        const eff = effectiveStatus({ status: row.status })
        return <Tag color={eff.color}>{eff.label}</Tag>
      },
    },
    { title: '当前阶段', dataIndex: 'currentStage', width: 130, render: v => v ?? <Text type="secondary">—</Text> },
    { title: 'GitLab 项目', dataIndex: 'gitlabProject', width: 180 },
    {
      title: 'MR',
      dataIndex: 'mrUrl',
      width: 60,
      render: v => v ? <a href={v} target="_blank" rel="noreferrer">MR</a> : <Text type="secondary">—</Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, row) => (
        <Space size={4}>
          {row.status === 'draft' && (
            <Button
              size="small"
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={runningIds.has(row.id)}
              onClick={() => handleRun(row.id)}
            >
              运行
            </Button>
          )}
          {row.status === 'draft' && (
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => openEdit(row)}
            >
              编辑
            </Button>
          )}
          {STOPPABLE_STATUSES.includes(row.status) && (
            <Popconfirm
              title="确定要停止该需求吗？"
              description="停止后将标记为已中止，pipeline 将被终止。"
              onConfirm={() => handleStop(row.id)}
              okText="停止"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Button
                size="small"
                danger
                icon={<StopOutlined />}
                loading={stoppingIds.has(row.id)}
              >
                停止
              </Button>
            </Popconfirm>
          )}
          {(['draft', 'aborted'] as RequirementStatus[]).includes(row.status) && (
            <Popconfirm
              title="确认删除此需求？"
              onConfirm={() => handleDelete(row.id)}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
            >
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={deletingIds.has(row.id)}
              >
                删除
              </Button>
            </Popconfirm>
          )}
          <Button size="small" onClick={() => openDetail(row.id)}>详情</Button>
        </Space>
      ),
    },
  ]

  return (
    <>
      <Card
        title="需求管理（Quick-Impl）"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="按状态筛选"
              style={{ width: 150 }}
              value={filterStatus}
              onChange={v => { setFilterStatus(v); setPage(1) }}
              options={ALL_STATUSES.map(s => ({ value: s, label: STATUS_CONFIG[s]?.label ?? s }))}
            />
            <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建需求
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{
            current: page,
            pageSize: 20,
            total,
            onChange: setPage,
            showTotal: t => `共 ${t} 条`,
          }}
        />
      </Card>

      {/* 详情抽屉 */}
      <Drawer
        title={detail ? `需求 #${detail.id} — ${detail.title}` : '需求详情'}
        width={640}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        loading={detailLoading}
        extra={
          <Space>
            {detail?.status === 'draft' && (
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={runningIds.has(detail.id)}
                onClick={() => handleRun(detail.id)}
              >
                运行
              </Button>
            )}
            {detail?.status === 'draft' && (
              <Button icon={<EditOutlined />} onClick={() => { openEdit(detail); setDetailOpen(false) }}>
                编辑
              </Button>
            )}
            {activePendingWaiter && (
              <Button
                type="primary"
                icon={<CheckOutlined />}
                onClick={() => openDecide(activePendingWaiter, detail!.id)}
              >
                审批决策
              </Button>
            )}
            {detail?.status === 'failed' && (
              <Popconfirm
                title="确定从失败节点重试？"
                description="将重置 run 状态并从 LangGraph checkpoint 继续执行。"
                onConfirm={async () => {
                  try {
                    await requirementsApi.retry(detail.id)
                    message.success('已触发重试')
                    await openDetail(detail.id)
                  } catch (err: any) {
                    message.error(`重试失败：${err?.response?.data?.error ?? err.message}`)
                  }
                }}
                okText="确定"
                cancelText="取消"
              >
                <Button icon={<ReloadOutlined />}>从失败节点重试</Button>
              </Popconfirm>
            )}
          </Space>
        }
      >
        {detail && (
          <Space direction="vertical" style={{ width: '100%' }} size={20}>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="标题">{detail.title}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={effectiveStatus(detail).color}>{effectiveStatus(detail).label}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="来源">{detail.source}</Descriptions.Item>
              <Descriptions.Item label="GitLab 项目">{detail.gitlabProject}</Descriptions.Item>
              <Descriptions.Item label="基础分支">{detail.baseBranch}</Descriptions.Item>
              {detail.skipE2E && (
                <Descriptions.Item label="E2E">
                  <Tag color="orange">已跳过</Tag>
                </Descriptions.Item>
              )}
              {detail.branch && <Descriptions.Item label="功能分支">{detail.branch}</Descriptions.Item>}
              {detail.pipelineRunId && (
                <Descriptions.Item label="流水线 Run">#{detail.pipelineRunId}</Descriptions.Item>
              )}
              {detail.mrUrl && (
                <Descriptions.Item label="MR">
                  <a href={detail.mrUrl} target="_blank" rel="noreferrer">{detail.mrUrl}</a>
                </Descriptions.Item>
              )}
              {detail.currentStage && <Descriptions.Item label="当前阶段">{detail.currentStage}</Descriptions.Item>}
              {detail.abortReason && (
                <Descriptions.Item label="中止原因">
                  <Text type="danger">{detail.abortReason}</Text>
                </Descriptions.Item>
              )}
              <Descriptions.Item label="创建时间">{new Date(detail.createdAt).toLocaleString('zh-CN')}</Descriptions.Item>
              <Descriptions.Item label="创建者">{detail.createdBy ?? '—'}</Descriptions.Item>
            </Descriptions>

            {detail.rawInput && (
              <div>
                <Text strong style={{ display: 'block', marginBottom: 8 }}>原始输入</Text>
                <Paragraph
                  style={{
                    background: '#F6F7FA', borderRadius: 6, padding: '8px 12px',
                    fontSize: 13, margin: 0, whiteSpace: 'pre-wrap',
                  }}
                >
                  {detail.rawInput}
                </Paragraph>
              </div>
            )}

            {detail.specContent && (
              <Collapse
                size="small"
                items={[{
                  key: 'spec',
                  label: <Space><FileTextOutlined /><span>需求规格（Spec）</span></Space>,
                  children: (
                    <div style={{ maxHeight: 520, overflowY: 'auto', fontSize: 13 }} className="spec-markdown">
                      <MarkdownViewer source={detail.specContent} />
                    </div>
                  ),
                }]}
              />
            )}

            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>审批记录</Text>
              <WaiterTimeline waiters={detail.waiters} />
            </div>

            <QiE2eProgress stageResults={detail.stageResults} />

            <div>
              <Divider orientation="left">节点执行记录</Divider>
              <StageResultsTimeline
                stageResults={detail.stageResults ?? []}
                pipelineNodes={undefined}
                onRetry={
                  // 触发条件：requirement 整体 failed OR stage_results 里有 failed 节点。
                  // 后者覆盖 "stage_results 有 failed 但 requirement.status 还在中间态"
                  // 的场景（如 spec_commit_push 失败但 requirement.status 还是 spec_review）。
                  (detail?.status === 'failed' || (detail.stageResults ?? []).some(s => s.status === 'failed'))
                    ? async (nodeId) => {
                  try {
                    await requirementsApi.retryFromNode(detail.id, nodeId)
                    message.success(`已从节点「${nodeId}」重试`)
                    await openDetail(detail.id)
                  } catch (err: any) {
                    message.error(`重试失败：${err?.response?.data?.error ?? err.message}`)
                  }
                } : undefined}
              />
            </div>
          </Space>
        )}
      </Drawer>

      {/* 新建需求 Modal */}
      <Modal
        title="新建需求"
        open={createOpen}
        onCancel={() => { setCreateOpen(false); createForm.resetFields() }}
        onOk={() => createForm.submit()}
        confirmLoading={createLoading}
        okText="保存草稿"
        cancelText="取消"
      >
        <Form form={createForm} layout="vertical" onFinish={handleCreate}>
          <Form.Item name="title" label="需求标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input placeholder="一句话描述需求" />
          </Form.Item>
          <Form.Item name="rawInput" label="需求详情" rules={[{ required: true, message: '请输入详情' }]}>
            <TextArea rows={4} placeholder="详细描述需求内容、验收条件等" />
          </Form.Item>
          <Form.Item name="gitlabProject" label="GitLab 项目" rules={[{ required: true, message: '请输入项目路径' }]}>
            <Input placeholder="group/repo" />
          </Form.Item>
          <Form.Item name="baseBranch" label="基础分支">
            <Input placeholder="留空默认 main" />
          </Form.Item>
          <Form.Item name="skipE2E" valuePropName="checked" extra="勾选后 Dev 完成直接走到 Final Approval，整段 E2E 不跑。仅适合调试/小改/紧急合入。">
            <Checkbox>跳过 E2E 测试</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑需求 Modal */}
      <Modal
        title={editTarget ? `编辑需求 #${editTarget.id}` : '编辑需求'}
        open={!!editTarget}
        onCancel={() => { setEditTarget(null); editForm.resetFields() }}
        onOk={() => editForm.submit()}
        confirmLoading={editLoading}
        okText="保存"
        cancelText="取消"
      >
        <Form form={editForm} layout="vertical" onFinish={handleEdit}>
          <Form.Item name="title" label="需求标题" rules={[{ required: true, message: '请输入标题' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="rawInput" label="需求详情" rules={[{ required: true, message: '请输入详情' }]}>
            <TextArea rows={4} />
          </Form.Item>
          <Form.Item name="gitlabProject" label="GitLab 项目" rules={[{ required: true, message: '请输入项目路径' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="baseBranch" label="基础分支">
            <Input />
          </Form.Item>
          <Form.Item name="skipE2E" valuePropName="checked" extra="勾选后 Dev 完成直接走到 Final Approval，整段 E2E 不跑。">
            <Checkbox>跳过 E2E 测试</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      {/* 审批决策 Modal */}
      {decideState.waiter && (
        <DecideModal
          open={decideState.open}
          waiter={decideState.waiter}
          requirementId={decideState.requirementId}
          detail={detail}
          onClose={() => setDecideState(s => ({ ...s, open: false }))}
          onDecided={() => {
            setDecideState(s => ({ ...s, open: false }))
            if (detail) openDetail(detail.id)
            load()
          }}
        />
      )}
    </>
  )
}
