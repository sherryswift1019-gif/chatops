import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, Table, Tag, Button, Select, Space, Modal, message, Input } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { useSearchParams } from 'react-router-dom'
import {
  listBugReports,
  retryBugReport,
  handoverBugReport,
  forceAbortBugReport,
} from '../api/bug-analysis-reports'
import { getProductLines } from '../api/product-lines'
import { getDingTalkUsers } from '../api/dingtalk-users'
import BugRunDetailDrawer from '../components/BugRunDetailDrawer'
import type { BugAnalysisReport, ProductLine, DingTalkUser } from '../types'

// ─── 就地定义 LevelTag / StatusTag（与 BugRunDetailDrawer 一致）─────

const LEVEL_COLOR: Record<string, string> = {
  l1: 'blue',
  l2: 'cyan',
  l3: 'orange',
  l4: 'purple',
}

function LevelTag({ level }: { level: string | null | undefined }) {
  if (!level) return <Tag color="default">—</Tag>
  const key = String(level).toLowerCase()
  const color = LEVEL_COLOR[key] ?? 'default'
  return <Tag color={color}>{key.toUpperCase()}</Tag>
}

const STATUS_META: Record<string, { color: string; label: string }> = {
  draft: { color: 'default', label: '草稿' },
  published: { color: 'processing', label: '已发布' },
  pipeline_success: { color: 'cyan', label: 'Pipeline 成功' },
  pending_manual: { color: 'orange', label: '待人工接手' },
  completed: { color: 'success', label: '已完成' },
  aborted: { color: 'error', label: '已终止' },
}

function StatusTag({ status }: { status: string | null | undefined }) {
  if (!status) return <Tag>—</Tag>
  const meta = STATUS_META[status]
  if (!meta) return <Tag>{status}</Tag>
  return <Tag color={meta.color}>{meta.label}</Tag>
}

// ─── 工具 ─────────────────────────────────────────────────────────

function formatDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return String(s)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const STATUS_OPTIONS = (Object.keys(STATUS_META) as Array<keyof typeof STATUS_META>).map(
  (value) => ({ value, label: STATUS_META[value].label }),
)

const LEVEL_OPTIONS = [
  { value: 'l1', label: 'L1' },
  { value: 'l2', label: 'L2' },
  { value: 'l3', label: 'L3' },
  { value: 'l4', label: 'L4' },
]

export default function BugRunsPage() {
  const [searchParams, setSearchParams] = useSearchParams()

  // URL → state
  const productLineIdStr = searchParams.get('productLine')
  const productLineId = productLineIdStr ? Number(productLineIdStr) : undefined
  const status = searchParams.get('status') || undefined
  const level = searchParams.get('level') || undefined
  const issueIdStr = searchParams.get('issueId')
  const issueIdFilter = issueIdStr && /^\d+$/.test(issueIdStr) ? Number(issueIdStr) : undefined
  const keywordFilter = searchParams.get('keyword') || undefined
  const page = Number(searchParams.get('page') || 1)
  const pageSize = Number(searchParams.get('pageSize') || 20)

  const [reports, setReports] = useState<BugAnalysisReport[]>([])
  const [total, setTotal] = useState(0)
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [userNameMap, setUserNameMap] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [selectedReport, setSelectedReport] = useState<BugAnalysisReport | null>(null)
  const [issueInput, setIssueInput] = useState<string>(
    issueIdFilter != null ? String(issueIdFilter) : keywordFilter ?? '',
  )
  const abortRef = useRef<AbortController | null>(null)

  // URL 上的 issueId/keyword 变了（比如跳转过来）→ 同步输入框
  useEffect(() => {
    setIssueInput(issueIdFilter != null ? String(issueIdFilter) : keywordFilter ?? '')
  }, [issueIdFilter, keywordFilter])

  useEffect(() => {
    getProductLines().then(setProductLines).catch(() => {})
    // 拉 dingtalk_users 供 triggered_by 列显示名字（非严格：失败降级为显示原 id）
    getDingTalkUsers()
      .then((res) => {
        const map: Record<string, string> = {}
        for (const u of res.users as DingTalkUser[]) map[u.userId] = u.name
        setUserNameMap(map)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productLineId, status, level, issueIdFilter, keywordFilter, page, pageSize])

  async function load() {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    try {
      const res = await listBugReports({
        productLineId,
        issueId: issueIdFilter,
        keyword: keywordFilter,
        status,
        level,
        page,
        pageSize,
        signal: abortRef.current.signal,
      })
      setReports(res.data)
      setTotal(res.total)
    } catch (err) {
      const isAbort =
        (err as { name?: string })?.name === 'AbortError' ||
        (err as { code?: string })?.code === 'ERR_CANCELED'
      if (!isAbort) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[BugRunsPage] load failed:', err)
        message.error(`加载 Bug 列表失败: ${msg}`)
      }
    } finally {
      setLoading(false)
    }
  }

  function setFilter(key: string, value: string | number | undefined) {
    const next = new URLSearchParams(searchParams)
    if (value == null || value === '') next.delete(key)
    else next.set(key, String(value))
    next.delete('page') // 筛选变化回到第 1 页
    setSearchParams(next, { replace: true })
  }

  function onPageChange(p: number, ps: number) {
    const next = new URLSearchParams(searchParams)
    next.set('page', String(p))
    next.set('pageSize', String(ps))
    setSearchParams(next, { replace: true })
  }

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (productLineId != null) n++
    if (status) n++
    if (level) n++
    if (issueIdFilter != null) n++
    if (keywordFilter) n++
    return n
  }, [productLineId, status, level, issueIdFilter, keywordFilter])

  async function handleRetry(record: BugAnalysisReport) {
    Modal.confirm({
      title: '确认重新开始处理吗？',
      content: '后台会启动新一轮分析 + Pipeline（耗时 3-6 分钟），完成后新 report 会出现在列表里。',
      okText: '确认重试',
      cancelText: '取消',
      onOk: async () => {
        try {
          await retryBugReport(record.id)
          message.success('已受理，后台分析中。请过几分钟刷新查看新 report')
          load()
        } catch (err) {
          const serverMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          message.error(`重试失败: ${serverMsg ?? (err as Error).message}`)
        }
      },
    })
  }

  async function handleHandover(record: BugAnalysisReport) {
    Modal.confirm({
      title: '确认转人工接手？',
      content: 'AI 将放弃自动处理，Issue 打 needs-manual label 并 DM 负责人。',
      okText: '确认转人工',
      cancelText: '取消',
      onOk: async () => {
        try {
          const r = await handoverBugReport(record.id, 'user_requested')
          message.success(`已转人工接手（status=${r.status}）`)
          load()
        } catch (err) {
          const serverMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          message.error(`转人工失败: ${serverMsg ?? (err as Error).message}`)
        }
      },
    })
  }

  async function handleForceAbort(record: BugAnalysisReport) {
    Modal.confirm({
      title: '强制终止这条处理？',
      content: `当前 status=${record.status}。用于 Pipeline 卡死场景（进程中断、stage 无超时等）。标记为 aborted 后会显示"重试"按钮。`,
      okText: '确认强制终止',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const r = await forceAbortBugReport(record.id, '管理员前端强制终止')
          message.success(`已强制终止（status=${r.status}）`)
          load()
        } catch (err) {
          const serverMsg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
          message.error(`强制终止失败: ${serverMsg ?? (err as Error).message}`)
        }
      },
    })
  }

  const columns = [
    {
      title: '产线',
      dataIndex: 'productLineName',
      width: 100,
      render: (v: string | undefined) => <Tag>{v || '—'}</Tag>,
    },
    {
      title: 'Issue',
      dataIndex: 'issueId',
      width: 80,
      render: (iid: number | null, record: BugAnalysisReport) => {
        if (!iid) return '—'
        if (!record.issueUrl) return `#${iid}`
        return (
          <a href={record.issueUrl} target="_blank" rel="noopener noreferrer">#{iid}</a>
        )
      },
    },
    {
      title: '摘要',
      dataIndex: 'rootCauseSummary',
      ellipsis: { showTitle: true },
      render: (v: string | null) => v || '—',
    },
    {
      title: '等级',
      dataIndex: 'level',
      width: 80,
      render: (v: string | null) => <LevelTag level={v} />,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 130,
      render: (v: string | null) => <StatusTag status={v} />,
    },
    {
      title: '触发人',
      dataIndex: 'triggeredBy',
      width: 140,
      render: (id: string | null) => {
        if (!id) return '—'
        return userNameMap[id] ?? id
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      defaultSortOrder: 'descend' as const,
      sorter: (a: BugAnalysisReport, b: BugAnalysisReport) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      render: (v: string) => formatDateTime(v),
    },
    {
      title: '完成时间',
      dataIndex: 'completedAt',
      width: 160,
      render: (v: string | null) => (v ? formatDateTime(v) : '—'),
    },
    {
      title: '操作',
      fixed: 'right' as const,
      width: 220,
      render: (_: unknown, record: BugAnalysisReport) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => setSelectedReport(record)}>
            详情
          </Button>
          {record.status === 'aborted' && (
            <>
              <Button type="link" size="small" danger onClick={() => handleRetry(record)}>
                重试
              </Button>
              <Button type="link" size="small" onClick={() => handleHandover(record)}>
                转人工
              </Button>
            </>
          )}
          {record.status === 'published' && (
            <Button type="link" size="small" danger onClick={() => handleForceAbort(record)}>
              强制终止
            </Button>
          )}
        </Space>
      ),
    },
  ]

  return (
    <>
      <Card
        title="Bug 修复实例"
        extra={
          <Space wrap>
            <Select
              allowClear
              style={{ width: 180 }}
              placeholder="产线"
              value={productLineId}
              onChange={(v) => setFilter('productLine', v)}
              options={productLines.map((p) => ({ value: p.id, label: p.displayName }))}
            />
            <Select
              allowClear
              style={{ width: 180 }}
              placeholder="状态"
              value={status}
              onChange={(v) => setFilter('status', v)}
              options={STATUS_OPTIONS}
            />
            <Select
              allowClear
              style={{ width: 180 }}
              placeholder="等级"
              value={level}
              onChange={(v) => setFilter('level', v)}
              options={LEVEL_OPTIONS}
            />
            <Input
              allowClear
              style={{ width: 180 }}
              placeholder="Issue 编号 或 摘要"
              value={issueInput}
              onChange={(e) => {
                setIssueInput(e.target.value)
                // 点 x 或删光时触发空字符串 → 立即撤销筛选
                if (e.target.value === '') {
                  const next = new URLSearchParams(searchParams)
                  next.delete('issueId')
                  next.delete('keyword')
                  next.delete('page')
                  setSearchParams(next, { replace: true })
                }
              }}
              onPressEnter={(e) => {
                const v = (e.target as HTMLInputElement).value.trim()
                const next = new URLSearchParams(searchParams)
                next.delete('issueId')
                next.delete('keyword')
                next.delete('page')
                if (!v) {
                  // 空 → 都清
                } else if (/^\d+$/.test(v)) {
                  next.set('issueId', v)
                } else {
                  next.set('keyword', v)
                }
                setSearchParams(next, { replace: true })
              }}
            />
            <Button icon={<ReloadOutlined />} onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={reports}
          loading={loading}
          scroll={{ x: 1400 }}
          locale={{
            emptyText: activeFilterCount > 0 ? '当前筛选条件下无结果，试试调整筛选' : '暂无 Bug 修复实例',
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 条`,
            pageSizeOptions: ['10', '20', '50', '100'],
            onChange: onPageChange,
          }}
        />
      </Card>

      <BugRunDetailDrawer
        open={!!selectedReport}
        report={selectedReport}
        onClose={() => setSelectedReport(null)}
        userNameMap={userNameMap}
      />
    </>
  )
}
