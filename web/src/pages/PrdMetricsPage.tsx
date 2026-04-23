import { useEffect, useState } from 'react'
import {
  Card,
  Col,
  Empty,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
} from 'antd'
import { getPrdMetrics, type PrdMetricsResponse } from '../api/prd-metrics'
import { getProductLines } from '../api/product-lines'
import type { ProductLine } from '../types'

// 与 PrdDocumentsPage 同源的 ruleId → 中文标签。保持在前端内，规则本身仍是后端单一事实源。
const RULE_LABELS: Record<string, string> = {
  chapter_complete: '章节完整',
  source_traceable: '来源可追溯',
  measurable_acceptance: '验收可度量',
  no_soft_language: '避免软化用语',
  no_impl_leak: '避免实现泄露',
  scope_consistent: '范围一致',
  no_contradiction: '无内部矛盾',
  impact_enum: '影响类型合法',
  breaking_change_detail: '破坏性变更有迁移策略',
  closed_loop: '动作闭环 (5W)',
  submit_review_missing: '自审契约失败',
}

const SEVERITY_LABELS: Record<string, string> = {
  blocker: '阻断',
  major: '主要',
  minor: '次要',
  '(unknown)': '未知',
}

const SEVERITY_COLORS: Record<string, string> = {
  blocker: 'red',
  major: 'orange',
  minor: 'blue',
}

const DAY_OPTIONS = [
  { value: 7, label: '近 7 天' },
  { value: 30, label: '近 30 天' },
  { value: 90, label: '近 90 天' },
]

function formatPercent(v: number | null): string {
  if (v === null) return '-'
  return `${(v * 100).toFixed(1)}%`
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '-'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`
  return `${(ms / 3_600_000).toFixed(2)}h`
}

export default function PrdMetricsPage() {
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [selectedPL, setSelectedPL] = useState<number | undefined>()
  const [days, setDays] = useState<number>(30)
  const [data, setData] = useState<PrdMetricsResponse | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    getProductLines().then(setProductLines).catch(() => {})
  }, [])

  useEffect(() => {
    load()
  }, [days, selectedPL])

  async function load() {
    setLoading(true)
    try {
      const r = await getPrdMetrics({ days, productLineId: selectedPL ?? null })
      setData(r)
    } finally {
      setLoading(false)
    }
  }

  const summary = data?.summary

  const ruleColumns = [
    {
      title: 'ruleId',
      dataIndex: 'ruleId',
      render: (v: string) => (
        <Tooltip title={v}>
          <Tag>{RULE_LABELS[v] ?? v}</Tag>
        </Tooltip>
      ),
    },
    {
      title: '违规次数',
      dataIndex: 'count',
      sorter: (a: { count: number }, b: { count: number }) => b.count - a.count,
    },
  ]

  const severityColumns = [
    {
      title: '严重度',
      dataIndex: 'severity',
      render: (v: string) => (
        <Tag color={SEVERITY_COLORS[v]}>{SEVERITY_LABELS[v] ?? v}</Tag>
      ),
    },
    {
      title: '次数',
      dataIndex: 'count',
      sorter: (a: { count: number }, b: { count: number }) => b.count - a.count,
    },
  ]

  return (
    <Card
      title="PRD Agent V2 指标"
      extra={
        <Space>
          <Select
            style={{ width: 140 }}
            value={days}
            onChange={setDays}
            options={DAY_OPTIONS}
          />
          <Select
            style={{ width: 200 }}
            placeholder="全部产品线"
            allowClear
            value={selectedPL}
            onChange={(v) => setSelectedPL(v)}
            options={productLines.map((pl) => ({
              value: pl.id,
              label: pl.displayName,
            }))}
          />
        </Space>
      }
    >
      {!summary ? (
        <Empty description={loading ? '加载中…' : '暂无数据'} />
      ) : summary.sampleSize === 0 ? (
        <Empty description={`最近 ${days} 天内没有审查过的 PRD`} />
      ) : (
        <>
          <Row gutter={24} style={{ marginBottom: 24 }}>
            <Col span={6}>
              <Statistic
                title={
                  <Tooltip title="首次 review 即 status='passed' 的 PRD 占比。分母为有审查痕迹的 PRD（reviewHistory 非空）">
                    <span>一轮通过率</span>
                  </Tooltip>
                }
                value={formatPercent(summary.firstRoundPassRate)}
                loading={loading}
              />
              <div style={{ color: '#8B93A8', fontSize: 12, marginTop: 4 }}>
                {summary.firstRoundPassed} / {summary.sampleSize}
              </div>
            </Col>
            <Col span={6}>
              <Statistic
                title={
                  <Tooltip title="status='review_blocked' 占所有完成 PRD 比例">
                    <span>升级人工率</span>
                  </Tooltip>
                }
                value={formatPercent(summary.escalationRate)}
                loading={loading}
              />
              <div style={{ color: '#8B93A8', fontSize: 12, marginTop: 4 }}>
                {summary.escalated} / {summary.sampleSize}
              </div>
            </Col>
            <Col span={6}>
              <Statistic
                title={
                  <Tooltip title="reviewHistory 从首条 reviewedAt 到末条 repairedAt / reviewedAt 的跨度（毫秒），平均 & P50">
                    <span>自审耗时</span>
                  </Tooltip>
                }
                value={formatDuration(summary.avgReviewDurationMs)}
                loading={loading}
              />
              <div style={{ color: '#8B93A8', fontSize: 12, marginTop: 4 }}>
                P50 {formatDuration(summary.p50ReviewDurationMs)}
              </div>
            </Col>
            <Col span={6}>
              <Statistic
                title={
                  <Tooltip title="单份 PRD 的 LLM 调用次数（create+review+repair 汇总）。埋点未上线时显示 '-'">
                    <span>平均 LLM 调用</span>
                  </Tooltip>
                }
                value={
                  summary.avgLlmCallsPerPrd === null
                    ? '-'
                    : summary.avgLlmCallsPerPrd.toFixed(2)
                }
                loading={loading}
              />
              <div style={{ color: '#8B93A8', fontSize: 12, marginTop: 4 }}>
                样本数 {summary.sampleSize}
              </div>
            </Col>
          </Row>

          <Row gutter={24}>
            <Col span={14}>
              <Card title="违规规则 Top（按 ruleId）" size="small">
                <Table
                  rowKey="ruleId"
                  columns={ruleColumns}
                  dataSource={summary.findingsByRuleId}
                  loading={loading}
                  pagination={false}
                  size="small"
                />
              </Card>
            </Col>
            <Col span={10}>
              <Card title="严重度分布" size="small">
                <Table
                  rowKey="severity"
                  columns={severityColumns}
                  dataSource={summary.findingsBySeverity}
                  loading={loading}
                  pagination={false}
                  size="small"
                />
              </Card>
            </Col>
          </Row>
        </>
      )}
    </Card>
  )
}
