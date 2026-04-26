import { useEffect, useMemo, useState } from 'react'
import { Card, Table, Tag, Space, Input, Tooltip, Typography } from 'antd'
import { getTools, type ToolInfo } from '../api/tool-permissions'
import { getCapabilities, type Capability } from '../api/capabilities'

const { Text } = Typography

const RISK_COLORS: Record<string, string> = {
  low: 'blue',
  medium: 'orange',
  high: 'red',
}

const RISK_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
}

export default function ToolsPage() {
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const [t, c] = await Promise.all([getTools(), getCapabilities()])
      setTools(t)
      setCapabilities(c)
    } finally {
      setLoading(false)
    }
  }

  // 反向索引:Map<toolName, Capability[]>
  const toolToCaps = useMemo(() => {
    const map = new Map<string, Capability[]>()
    for (const cap of capabilities) {
      for (const toolName of cap.toolNames ?? []) {
        const arr = map.get(toolName) ?? []
        arr.push(cap)
        map.set(toolName, arr)
      }
    }
    return map
  }, [capabilities])

  const filtered = useMemo(() => {
    if (!keyword) return tools
    const kw = keyword.toLowerCase()
    return tools.filter(t => {
      if (t.name.toLowerCase().includes(kw)) return true
      if (t.description.toLowerCase().includes(kw)) return true
      const caps = toolToCaps.get(t.name) ?? []
      return caps.some(c =>
        c.displayName.toLowerCase().includes(kw) ||
        c.key.toLowerCase().includes(kw)
      )
    })
  }, [tools, keyword, toolToCaps])

  const columns = [
    {
      title: '工具名',
      dataIndex: 'name',
      width: 220,
      render: (v: string) => (
        <Text code copyable={{ text: v }} style={{ fontSize: 13 }}>{v}</Text>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      ellipsis: true,
      render: (v: string) => (
        <Tooltip title={v} placement="topLeft">
          <span>{v}</span>
        </Tooltip>
      ),
    },
    {
      title: '风险级别',
      dataIndex: 'riskLevel',
      width: 100,
      render: (v: string) => (
        <Tag color={RISK_COLORS[v] ?? 'default'}>{RISK_LABELS[v] ?? v}</Tag>
      ),
    },
    {
      title: '关联能力',
      key: 'caps',
      render: (_: unknown, record: ToolInfo) => {
        const caps = toolToCaps.get(record.name) ?? []
        if (caps.length === 0) {
          return <Text type="secondary" style={{ fontSize: 12 }}>未被任何能力引用</Text>
        }
        return (
          <Space size={[4, 4]} wrap>
            {caps.map(c => (
              <Tooltip key={c.key} title={c.key}>
                <Tag>{c.displayName}</Tag>
              </Tooltip>
            ))}
          </Space>
        )
      },
    },
  ]

  return (
    <Card
      title={
        <Space>
          <span>工具管理</span>
          <Text type="secondary" style={{ fontSize: 13, fontWeight: 'normal' }}>
            共 {tools.length} 个工具{keyword ? `,过滤后 ${filtered.length} 个` : ''}
          </Text>
        </Space>
      }
      extra={
        <Input.Search
          placeholder="搜索工具名 / 描述 / 关联能力"
          allowClear
          style={{ width: 280 }}
          onChange={e => setKeyword(e.target.value)}
        />
      }
    >
      <Table
        rowKey="name"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        pagination={false}
        size="middle"
      />
    </Card>
  )
}
