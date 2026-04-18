import { useEffect, useMemo, useState } from 'react'
import { Card, Collapse, Tag, Button, Select, Space, Spin, Timeline, Modal, message, Empty } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'
import {
  getBugAnalysisReports,
  retryBugReport,
  fetchBugEvents,
  type BugFixEvent,
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
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedPL, setSelectedPL] = useState<number | undefined>()

  useEffect(() => {
    getProductLines().then(setProductLines)
  }, [])

  useEffect(() => {
    if (selectedPL) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPL])

  async function load() {
    if (!selectedPL) return
    setLoading(true)
    try {
      const res = await getBugAnalysisReports(selectedPL)
      setReports(res.data)
    } finally {
      setLoading(false)
    }
  }

  const grouped = useMemo(() => groupByIssueId(reports), [reports])

  return (
    <Card
      title="Bug 修复实例"
      extra={
        <Space>
          <Select
            style={{ width: 220 }}
            placeholder="选择产品线"
            value={selectedPL}
            onChange={setSelectedPL}
            options={productLines.map(pl => ({ value: pl.id, label: pl.displayName }))}
          />
          <Button icon={<ReloadOutlined />} onClick={load} disabled={!selectedPL}>刷新</Button>
        </Space>
      }
      loading={loading}
    >
      {grouped.size === 0 && !loading ? (
        <Empty description={selectedPL ? '暂无分析报告' : '请先选择产品线'} />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {Array.from(grouped.entries()).map(([issueId, rounds]) => (
            <IssueCard key={issueId} issueId={issueId} rounds={rounds} onRetry={load} />
          ))}
        </Space>
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
