import { useEffect, useState } from 'react'
import { Card, Table, Tag, Button, Drawer, Descriptions, Timeline, Select, Space, message } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { getBugAnalysisReports, getBugAnalysisReport } from '../api/bug-analysis-reports'
import { getProductLines } from '../api/product-lines'
import type { BugAnalysisReport, ProductLine } from '../types'

const levelColors: Record<string, string> = { l1: 'green', l2: 'blue', l3: 'orange', l4: 'red' }
const confidenceColors: Record<string, string> = { high: 'green', medium: 'gold', low: 'red' }
const statusColors: Record<string, string> = { draft: 'default', published: 'processing', superseded: 'warning' }

const LABEL_FLOW = ['needs-analysis', 'analyzing', 'graded', 'fixing', 'in-review', 'testing', 'ready-to-merge', 'merged', 'done']

export default function BugRunsPage() {
  const [data, setData] = useState<BugAnalysisReport[]>([])
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedPL, setSelectedPL] = useState<number | undefined>()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [detail, setDetail] = useState<BugAnalysisReport | null>(null)

  useEffect(() => { getProductLines().then(setProductLines) }, [])

  useEffect(() => { if (selectedPL) load() }, [selectedPL])

  async function load() {
    if (!selectedPL) return
    setLoading(true)
    try {
      const res = await getBugAnalysisReports(selectedPL)
      setData(res.data)
    } finally { setLoading(false) }
  }

  async function showDetail(id: number) {
    try {
      const report = await getBugAnalysisReport(id)
      setDetail(report)
      setDrawerOpen(true)
    } catch { message.error('加载详情失败') }
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    { title: 'Issue', dataIndex: 'issueId', render: (v: number, r: BugAnalysisReport) => r.issueUrl ? <a href={r.issueUrl} target="_blank">#{v}</a> : `#${v}` },
    { title: '级别', dataIndex: 'level', render: (v: string) => <Tag color={levelColors[v]}>{v.toUpperCase()}</Tag> },
    { title: '置信度', dataIndex: 'confidence', render: (v: string) => <Tag color={confidenceColors[v]}>{v}</Tag> },
    { title: '分类', dataIndex: 'classification', render: (v: string) => <Tag>{v}</Tag> },
    { title: '根因', dataIndex: 'rootCauseSummary', ellipsis: true },
    { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={statusColors[v]}>{v}</Tag> },
    { title: '时间', dataIndex: 'createdAt', render: (v: string) => new Date(v).toLocaleString() },
    {
      title: '操作',
      render: (_: unknown, r: BugAnalysisReport) => <a onClick={() => showDetail(r.id)}>详情</a>,
    },
  ]

  return (
    <>
      <Card
        title="Bug 修复实例"
        extra={
          <Space>
            <Select style={{ width: 200 }} placeholder="选择产品线" value={selectedPL} onChange={setSelectedPL}
              options={productLines.map(pl => ({ value: pl.id, label: pl.displayName }))} />
            <Button icon={<ReloadOutlined />} onClick={load} disabled={!selectedPL}>刷新</Button>
          </Space>
        }
      >
        <Table rowKey="id" columns={columns} dataSource={data} loading={loading} pagination={{ pageSize: 20 }} />
      </Card>

      <Drawer title={detail ? `分析报告 #${detail.id}` : ''} open={drawerOpen} onClose={() => setDrawerOpen(false)} width={700}>
        {detail && (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label="Issue">
                {detail.issueUrl ? <a href={detail.issueUrl} target="_blank">#{detail.issueId}</a> : `#${detail.issueId}`}
              </Descriptions.Item>
              <Descriptions.Item label="级别"><Tag color={levelColors[detail.level]}>{detail.level.toUpperCase()}</Tag></Descriptions.Item>
              <Descriptions.Item label="置信度"><Tag color={confidenceColors[detail.confidence]}>{detail.confidence} ({((detail.confidenceScore ?? 0) * 100).toFixed(0)}%)</Tag></Descriptions.Item>
              <Descriptions.Item label="分类"><Tag>{detail.classification}</Tag></Descriptions.Item>
              <Descriptions.Item label="状态"><Tag color={statusColors[detail.status]}>{detail.status}</Tag></Descriptions.Item>
              <Descriptions.Item label="影响模块">{(detail.affectedModules ?? []).join(', ') || '-'}</Descriptions.Item>
            </Descriptions>

            <div style={{ margin: '16px 0 8px', fontWeight: 500 }}>根因</div>
            <p>{detail.rootCauseSummary ?? '-'}</p>

            <div style={{ margin: '16px 0 8px', fontWeight: 500 }}>修复方案</div>
            {detail.solutionsJson.map(s => (
              <div key={s.id} style={{ marginBottom: 8, padding: 8, background: '#fafafa', borderRadius: 4 }}>
                <strong>{s.id}</strong> {s.recommended && <Tag color="gold">推荐</Tag>}
                <p style={{ margin: '4px 0 0' }}>{s.summary}（风险: {s.risk}，工作量: {s.effort}）</p>
              </div>
            ))}

            {detail.analysisSteps && (
              <>
                <div style={{ margin: '16px 0 8px', fontWeight: 500 }}>分析过程</div>
                <Timeline items={detail.analysisSteps.map((step, i) => ({ children: step }))} />
              </>
            )}
          </>
        )}
      </Drawer>
    </>
  )
}
