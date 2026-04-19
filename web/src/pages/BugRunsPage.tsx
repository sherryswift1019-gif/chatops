import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, Collapse, Tag, Button, Select, Space, Spin, Timeline, Modal, message, Empty, Pagination } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'
import {
  getBugReports,
  retryBugReport,
  fetchBugEvents,
  type BugFixEvent,
  type BugReportStatusFilter,
  type BugReportLevelFilter,
} from '../api/bug-analysis-reports'
import { getProductLines } from '../api/product-lines'
import type { BugAnalysisReport, ProductLine } from '../types'

const levelColors: Record<string, string> = { l1: 'green', l2: 'blue', l3: 'orange', l4: 'red' }
const confidenceColors: Record<string, string> = { high: 'green', medium: 'gold', low: 'red' }
const statusColors: Record<string, string> = {
  draft: 'default',
  published: 'processing',
  superseded: 'warning',
  pipeline_success: 'success',
  completed: 'success',
  aborted: 'error',
}

const STATUS_OPTIONS: { value: BugReportStatusFilter; label: string }[] = [
  { value: 'draft', label: 'draft' },
  { value: 'published', label: 'published' },
  { value: 'pipeline_success', label: 'pipeline_success' },
  { value: 'completed', label: 'completed' },
  { value: 'aborted', label: 'aborted' },
]

const LEVEL_OPTIONS: { value: BugReportLevelFilter; label: string }[] = [
  { value: 'l1', label: 'L1' },
  { value: 'l2', label: 'L2' },
  { value: 'l3', label: 'L3' },
  { value: 'l4', label: 'L4' },
]

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '-'
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function groupByIssueId(reports: BugAnalysisReport[]): Map<number, BugAnalysisReport[]> {
  const map = new Map<number, BugAnalysisReport[]>()
  for (const r of reports) {
    const list = map.get(r.issueId) ?? []
    list.push(r)
    map.set(r.issueId, list)
  }
  // 每组按 created_at DESC 排序
  for (const list of map.values()) {
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }
  return map
}

export default function BugRunsPage() {
  const [reports, setReports] = useState<BugAnalysisReport[]>([])
  const [total, setTotal] = useState(0)
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedPL, setSelectedPL] = useState<number | undefined>()
  const [statusFilter, setStatusFilter] = useState<BugReportStatusFilter[]>([])
  const [levelFilter, setLevelFilter] = useState<BugReportLevelFilter[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    getProductLines().then(setProductLines)
  }, [])

  useEffect(() => {
    if (selectedPL) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPL, statusFilter, levelFilter, page, pageSize])

  async function load() {
    if (!selectedPL) return
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    try {
      const res = await getBugReports({
        productLineId: selectedPL,
        page,
        pageSize,
        statuses: statusFilter.length > 0 ? statusFilter : undefined,
        levels: levelFilter.length > 0 ? levelFilter : undefined,
        signal: abortRef.current.signal,
      })
      setReports(res.data)
      setTotal(res.total)
    } catch (err) {
      // AbortError：切筛选/翻页时主动 abort，不算错误
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

  const grouped = useMemo(() => groupByIssueId(reports), [reports])

  // 筛选变更时重置到第 1 页
  function onStatusChange(v: BugReportStatusFilter[]) {
    setStatusFilter(v)
    setPage(1)
  }
  function onLevelChange(v: BugReportLevelFilter[]) {
    setLevelFilter(v)
    setPage(1)
  }
  function onProductLineChange(v: number | undefined) {
    setSelectedPL(v)
    setPage(1)
  }

  return (
    <Card
      title="Bug 修复实例"
      extra={
        <Space wrap>
          <Select
            style={{ width: 220 }}
            placeholder="选择产品线"
            value={selectedPL}
            onChange={onProductLineChange}
            options={productLines.map(pl => ({ value: pl.id, label: pl.displayName }))}
          />
          <Select
            mode="multiple"
            allowClear
            style={{ minWidth: 220 }}
            placeholder="按状态筛选"
            value={statusFilter}
            onChange={onStatusChange}
            options={STATUS_OPTIONS}
            maxTagCount="responsive"
          />
          <Select
            mode="multiple"
            allowClear
            style={{ minWidth: 160 }}
            placeholder="按等级筛选"
            value={levelFilter}
            onChange={onLevelChange}
            options={LEVEL_OPTIONS}
            maxTagCount="responsive"
          />
          <Button icon={<ReloadOutlined />} onClick={load} disabled={!selectedPL}>刷新</Button>
        </Space>
      }
      loading={loading}
    >
      {grouped.size === 0 && !loading ? (
        <Empty description={selectedPL ? '暂无分析报告' : '请先选择产品线'} />
      ) : (
        <>
          <Space direction="vertical" style={{ width: '100%' }} size="middle">
            {Array.from(grouped.entries()).map(([issueId, rounds]) => (
              <IssueCard key={issueId} issueId={issueId} rounds={rounds} onRetry={load} />
            ))}
          </Space>
          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <Pagination
              current={page}
              pageSize={pageSize}
              total={total}
              showSizeChanger
              pageSizeOptions={['10', '20', '50', '100']}
              showTotal={(t) => `共 ${t} 条`}
              onChange={(p, s) => {
                setPage(p)
                setPageSize(s)
              }}
            />
          </div>
        </>
      )}
    </Card>
  )
}

function IssueCard({
  issueId,
  rounds,
  onRetry,
}: {
  issueId: number
  rounds: BugAnalysisReport[]
  onRetry: () => void
}) {
  const latest = rounds[0]
  const totalRounds = rounds.length
  const title = `Issue #${issueId} · ${truncate(latest.rootCauseSummary, 50)}`

  const items = rounds.map((r, idx) => {
    const roundNumber = totalRounds - idx
    return {
      key: String(r.id),
      label: <RoundHeader report={r} roundNumber={roundNumber} />,
      extra: <RetryButtonExtra report={r} onRetry={onRetry} />,
      children: <RoundBody report={r} />,
    }
  })

  return (
    <Card
      size="small"
      title={
        <Space>
          <span>{title}</span>
          {latest.issueUrl && (
            <a href={latest.issueUrl} target="_blank" rel="noopener noreferrer">查看 Issue</a>
          )}
          <Tag>{totalRounds} 轮</Tag>
        </Space>
      }
    >
      <Collapse defaultActiveKey={[String(latest.id)]} items={items} />
    </Card>
  )
}

function RoundHeader({ report, roundNumber }: { report: BugAnalysisReport; roundNumber: number }) {
  return (
    <Space wrap>
      <strong>第 {roundNumber} 轮</strong>
      <Tag color={levelColors[report.level]}>{report.level.toUpperCase()}</Tag>
      <Tag color={confidenceColors[report.confidence]}>{report.confidence}</Tag>
      <Tag>{report.classification}</Tag>
      <Tag color={statusColors[report.status] ?? 'default'}>{report.status}</Tag>
      <span style={{ color: '#8B93A8' }}>{formatTime(report.createdAt)}</span>
    </Space>
  )
}

function RetryButtonExtra({
  report,
  onRetry,
}: {
  report: BugAnalysisReport
  onRetry: () => void
}) {
  if (report.status !== 'aborted') return null
  return (
    <Button
      type="primary"
      danger
      size="small"
      onClick={(e) => {
        e.stopPropagation()
        Modal.confirm({
          title: '确认重新开始处理吗？',
          content: '将产生新一轮分析和新 Pipeline 实例（消耗 Claude token）。',
          okText: '确认重试',
          cancelText: '取消',
          onOk: async () => {
            try {
              const r = await retryBugReport(report.id)
              message.success(
                `已启动新一轮：报告 #${r.newReportId}${r.newRunId ? ` / 执行 #${r.newRunId}` : ''}`,
              )
              onRetry()
            } catch (err) {
              message.error(`重试失败: ${(err as Error).message}`)
            }
          },
        })
      }}
    >
      重试
    </Button>
  )
}

function RoundBody({ report }: { report: BugAnalysisReport }) {
  return (
    <div>
      {report.rootCauseSummary && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>根因</div>
          <div>{report.rootCauseSummary}</div>
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>事件时间线</div>
        <EventTimeline reportId={report.id} />
      </div>

      <Space>
        {report.pipelineRunId && (
          <Link to="/test-runs">查看执行记录 #{report.pipelineRunId}</Link>
        )}
        {report.issueUrl && (
          <a href={report.issueUrl} target="_blank" rel="noopener noreferrer">打开 Issue</a>
        )}
      </Space>
    </div>
  )
}

function EventTimeline({ reportId }: { reportId: number }) {
  const [events, setEvents] = useState<BugFixEvent[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchBugEvents(reportId)
      .then((evs) => {
        if (!cancelled) setEvents(evs)
      })
      .catch(() => {
        if (!cancelled) setEvents([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reportId])

  if (loading || events === null) return <Spin size="small" />
  if (events.length === 0) return <span style={{ color: '#8B93A8' }}>暂无事件</span>

  const items = events.map((e) => ({
    color: e.status === 'failed' ? 'red' : 'green',
    label: formatTime(e.createdAt),
    children: <EventContent event={e} />,
  }))

  return <Timeline mode="left" items={items} />
}

function EventContent({ event }: { event: BugFixEvent }) {
  const d = event.data as Record<string, any>
  switch (event.code) {
    case 'analysis':
      return (
        <span>
          分析完成 · level={String(d.level ?? '-')} · classification={String(d.classification ?? '-')}
        </span>
      )
    case 'scope_identified':
      return (
        <span>
          锁定 {event.projectPath ?? '-'}（{d.isPrimary ? '主仓库' : '从仓库'}）
        </span>
      )
    case 'create_issue':
      return d.issueUrl ? (
        <a href={String(d.issueUrl)} target="_blank" rel="noopener noreferrer">
          创建 Issue #{String(d.issueIid ?? '-')}
        </a>
      ) : (
        <span>创建 Issue #{String(d.issueIid ?? '-')}</span>
      )
    case 'fix_attempt':
      return (
        <span>
          {event.status === 'success' ? '✅' : '❌'} {event.projectPath ?? '-'} 修复
          {d.attempt !== undefined ? `（attempt=${String(d.attempt)}）` : ''}
        </span>
      )
    case 'create_mr':
      return d.mrUrl ? (
        <a href={String(d.mrUrl)} target="_blank" rel="noopener noreferrer">
          MR !{String(d.mrIid ?? '-')}（{event.projectPath ?? '-'}）
        </a>
      ) : (
        <span>MR !{String(d.mrIid ?? '-')}（{event.projectPath ?? '-'}）</span>
      )
    case 'ai_review':
      return <span>AI Review: {String(d.label ?? '-')}</span>
    case 'approval':
      return <span>审批: {String(d.decision ?? '-')}</span>
    case 'notify':
      return (
        <span>
          {event.status === 'success' ? '✅' : '❌'} 通知 {String(d.userId ?? '-')}（
          {String(d.messageKind ?? '-')}）
        </span>
      )
    case 'lifecycle_sync':
      return (
        <span>
          MR {String(d.mrAction ?? '-')} → {String(d.targetStatus ?? '-')}
        </span>
      )
    default:
      return <span>{event.code}</span>
  }
}
