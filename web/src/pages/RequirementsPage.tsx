import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  Card, Table, Tag, Button, Space,
  Modal, Form, Input, message, Select, Typography, Popconfirm,
  Checkbox,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined,
  EditOutlined, DeleteOutlined, PlayCircleOutlined, StopOutlined,
} from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import {
  requirementsApi,
  type RequirementDTO,
  type RequirementStatus,
} from '../api/requirements'
import { effectiveStatus, STATUS_LABELS } from './requirement-detail/effectiveStatus'

const { Text } = Typography
const { TextArea } = Input

const ALL_STATUSES: RequirementStatus[] = [
  'draft', 'queued', 'spec_review', 'planning', 'developing',
  'reviewing', 'testing', 'mr_pending', 'mr_open', 'merged',
  'aborting', 'aborted', 'failed',
]

export default function RequirementsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [items, setItems] = useState<RequirementDTO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [filterStatus, setFilterStatus] = useState<string | undefined>(undefined)

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

  // 旧链接兼容：/requirements?id=N&openWaiter=M → /requirements/N?openWaiter=M
  // IM 审批卡片现有链接保留 ?id=N 形态，零改动可继续工作。
  useEffect(() => {
    const idStr = searchParams.get('id')
    if (!idStr) return
    const id = Number(idStr)
    if (!Number.isFinite(id)) return
    const next = new URLSearchParams(searchParams)
    next.delete('id')
    const qs = next.toString()
    navigate(`/requirements/${id}${qs ? `?${qs}` : ''}`, { replace: true })
  }, [searchParams, navigate])

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
    } catch (e: any) {
      const msg = e?.response?.data?.error ?? '停止失败'
      message.error(msg)
    } finally {
      setStoppingIds(s => { const n = new Set(s); n.delete(id); return n })
    }
  }

  const columns: ColumnsType<RequirementDTO> = [
    { title: 'ID', dataIndex: 'id', width: 64, render: v => <Text type="secondary">#{v}</Text> },
    {
      title: '需求标题',
      dataIndex: 'title',
      render: (title, row) => (
        <Button type="link" style={{ padding: 0, fontWeight: 500 }} onClick={() => navigate(`/requirements/${row.id}`)}>
          {title}
        </Button>
      ),
    },
    {
      title: '状态',
      width: 140,
      render: (_, row) => {
        const eff = effectiveStatus(row)
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
          <Button size="small" onClick={() => navigate(`/requirements/${row.id}`)}>详情</Button>
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
              options={ALL_STATUSES.map(s => ({ value: s, label: STATUS_LABELS[s]?.label ?? s }))}
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
    </>
  )
}
