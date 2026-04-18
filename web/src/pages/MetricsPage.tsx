import { useEffect, useState } from 'react'
import { Card, Select, Space, Statistic, Row, Col, Table, Tag, Empty } from 'antd'
import { getKnowledgeHits, getAvgDuration, getRootCauseTrends } from '../api/metrics'
import { getProductLines } from '../api/product-lines'
import type { ProductLine, KnowledgeHitStat } from '../types'

const rootCauseLabels: Record<string, string> = {
  syntax: '语法/空指针',
  business_logic: '业务逻辑',
  requirement: '需求偏差',
  boundary: '边界条件',
  cross_module: '跨模块冲突',
}

export default function MetricsPage() {
  const [productLines, setProductLines] = useState<ProductLine[]>([])
  const [selectedPL, setSelectedPL] = useState<number | undefined>()
  const [avgDuration, setAvgDuration] = useState<number | null>(null)
  const [hits, setHits] = useState<KnowledgeHitStat[]>([])
  const [rootCauses, setRootCauses] = useState<{ root_cause_type: string; count: number }[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => { getProductLines().then(setProductLines) }, [])

  useEffect(() => { if (selectedPL) load() }, [selectedPL])

  async function load() {
    if (!selectedPL) return
    setLoading(true)
    try {
      const [dur, h, rc] = await Promise.all([
        getAvgDuration(selectedPL),
        getKnowledgeHits(selectedPL),
        getRootCauseTrends(selectedPL),
      ])
      setAvgDuration(dur.avgDurationMs)
      setHits(h)
      setRootCauses(rc)
    } finally { setLoading(false) }
  }

  const hitColumns = [
    { title: '知识条目 ID', dataIndex: 'entryId' },
    { title: '命中次数', dataIndex: 'hitCount', sorter: (a: KnowledgeHitStat, b: KnowledgeHitStat) => b.hitCount - a.hitCount },
    { title: '最后命中', dataIndex: 'lastHitAt', render: (v: string | null) => v ? new Date(v).toLocaleString() : '-' },
  ]

  const rcColumns = [
    { title: '根因类型', dataIndex: 'root_cause_type', render: (v: string) => <Tag>{rootCauseLabels[v] ?? v}</Tag> },
    { title: '数量', dataIndex: 'count', sorter: (a: any, b: any) => b.count - a.count },
  ]

  return (
    <Card
      title="价值量化仪表盘"
      extra={
        <Space>
          <Select style={{ width: 200 }} placeholder="选择产品线" value={selectedPL} onChange={setSelectedPL}
            options={productLines.map(pl => ({ value: pl.id, label: pl.displayName }))} />
        </Space>
      }
    >
      {!selectedPL ? <Empty description="请先选择产品线" /> : (
        <>
          <Row gutter={24} style={{ marginBottom: 24 }}>
            <Col span={8}>
              <Statistic title="平均分析耗时" value={avgDuration ? `${(avgDuration / 1000).toFixed(1)}s` : '-'} loading={loading} />
            </Col>
            <Col span={8}>
              <Statistic title="知识库总命中次数" value={hits.reduce((sum, h) => sum + h.hitCount, 0)} loading={loading} />
            </Col>
            <Col span={8}>
              <Statistic title="Bug 根因归因数" value={rootCauses.reduce((sum, r) => sum + r.count, 0)} loading={loading} />
            </Col>
          </Row>

          <Row gutter={24}>
            <Col span={12}>
              <Card title="知识库命中排行" size="small">
                <Table rowKey="entryId" columns={hitColumns} dataSource={hits} loading={loading} pagination={false} size="small" />
              </Card>
            </Col>
            <Col span={12}>
              <Card title="Bug 根因分布" size="small">
                <Table rowKey="root_cause_type" columns={rcColumns} dataSource={rootCauses} loading={loading} pagination={false} size="small" />
              </Card>
            </Col>
          </Row>
        </>
      )}
    </Card>
  )
}
