import { useEffect, useRef, useState } from 'react'
import {
  Card,
  Table,
  Tag,
  Button,
  Drawer,
  Space,
  Descriptions,
  Avatar,
  Select,
  Input,
  message,
  theme,
} from 'antd'
import { ReloadOutlined, UserOutlined } from '@ant-design/icons'
import {
  getCapabilityInvocations,
  getCapabilityInvocation,
  type CapabilityInvocationWithUser,
} from '../api/capabilityInvocations'
import { usePagination } from '../hooks/usePagination'

const statusColors: Record<string, string> = {
  running: 'processing',
  success: 'success',
  failed: 'error',
  not_executed: 'default',
}
const statusLabels: Record<string, string> = {
  running: '执行中',
  success: '成功',
  failed: '失败',
  not_executed: '未执行',
}
const triggerLabels: Record<string, string> = {
  im: 'IM',
  api: 'API',
  manual: '手动',
  scheduled: '定时',
  agent: 'Agent',
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}

export default function CapabilityInvocationsPage() {
  const { token } = theme.useToken()
  const [data, setData] = useState<CapabilityInvocationWithUser[]>([])
  const [loading, setLoading] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selected, setSelected] = useState<CapabilityInvocationWithUser | null>(
    null,
  )
  const [filterCapability, setFilterCapability] = useState('')
  const [filterPlatform, setFilterPlatform] = useState<string | undefined>()
  const [filterStatus, setFilterStatus] = useState<string | undefined>()
  const abortRef = useRef<AbortController | null>(null)
  const { page, limit, setTotal, tableProps } = usePagination(20)

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, limit, filterCapability, filterPlatform, filterStatus])

  async function load() {
    setLoading(true)
    try {
      const res = await getCapabilityInvocations(
        {
          capabilityKey: filterCapability || undefined,
          platform: filterPlatform,
          status: filterStatus,
          page,
          limit,
        },
        abortRef.current?.signal,
      )
      setData(res.data)
      setTotal(res.total)
    } catch {
      // ignore abort
    } finally {
      setLoading(false)
    }
  }

  async function showDetail(id: number) {
    try {
      const inv = await getCapabilityInvocation(id)
      setSelected(inv)
      setDrawerOpen(true)
    } catch {
      message.error('加载失败')
    }
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 80 },
    { title: '能力', dataIndex: 'capabilityKey' },
    {
      title: '触发',
      dataIndex: 'triggerType',
      width: 80,
      render: (v: string) => triggerLabels[v] ?? v,
    },
    { title: '平台', dataIndex: 'platform', width: 100 },
    {
      title: '触发人',
      dataIndex: 'triggeredByName',
      render: (_: unknown, r: CapabilityInvocationWithUser) =>
        r.triggeredByName ? (
          <span>
            <Avatar
              size={20}
              src={r.triggeredByAvatar}
              icon={<UserOutlined />}
              style={{ marginRight: 4 }}
            />
            {r.triggeredByName}
          </span>
        ) : (
          r.triggeredBy || '-'
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (v: string) => (
        <Tag color={statusColors[v]}>{statusLabels[v] ?? v}</Tag>
      ),
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 90,
      render: (v: number | null) => formatDuration(v),
    },
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      render: (v: string) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '操作',
      width: 80,
      render: (_: unknown, r: CapabilityInvocationWithUser) => (
        <a onClick={() => showDetail(r.id)}>详情</a>
      ),
    },
  ]

  return (
    <>
      <Card
        title="能力调用记录"
        extra={
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        }
      >
        <Space style={{ marginBottom: 12 }} wrap>
          <Input.Search
            placeholder="按 capability key 过滤"
            allowClear
            style={{ width: 220 }}
            onSearch={(v) => setFilterCapability(v)}
          />
          <Select
            placeholder="平台"
            allowClear
            style={{ width: 140 }}
            value={filterPlatform}
            onChange={setFilterPlatform}
            options={[
              { value: 'dingtalk', label: 'dingtalk' },
              { value: 'feishu', label: 'feishu' },
              { value: 'test', label: 'test' },
              { value: 'e2e', label: 'e2e' },
              { value: 'api', label: 'api' },
            ]}
          />
          <Select
            placeholder="状态"
            allowClear
            style={{ width: 120 }}
            value={filterStatus}
            onChange={setFilterStatus}
            options={[
              { value: 'running', label: '执行中' },
              { value: 'success', label: '成功' },
              { value: 'failed', label: '失败' },
              { value: 'not_executed', label: '未执行' },
            ]}
          />
        </Space>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={data}
          loading={loading}
          {...tableProps}
        />
      </Card>

      <Drawer
        title={selected ? `调用详情 #${selected.id}` : ''}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={640}
      >
        {selected && (
          <>
            <Descriptions column={2} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="能力">
                {selected.capabilityKey}
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={statusColors[selected.status]}>
                  {statusLabels[selected.status] ?? selected.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="触发">
                {triggerLabels[selected.triggerType] ?? selected.triggerType}
              </Descriptions.Item>
              <Descriptions.Item label="平台">{selected.platform || '-'}</Descriptions.Item>
              <Descriptions.Item label="触发人">
                {selected.triggeredByName ? (
                  <span>
                    <Avatar
                      size={20}
                      src={selected.triggeredByAvatar}
                      icon={<UserOutlined />}
                      style={{ marginRight: 4 }}
                    />
                    {selected.triggeredByName}
                  </span>
                ) : (
                  selected.triggeredBy || '-'
                )}
              </Descriptions.Item>
              <Descriptions.Item label="群组 ID">
                {selected.groupId || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="任务 ID">
                {selected.taskId || '-'}
              </Descriptions.Item>
              <Descriptions.Item label="耗时">
                {formatDuration(selected.durationMs)}
              </Descriptions.Item>
              <Descriptions.Item label="开始时间">
                {selected.startedAt
                  ? new Date(selected.startedAt).toLocaleString('zh-CN')
                  : '-'}
              </Descriptions.Item>
              <Descriptions.Item label="结束时间">
                {selected.finishedAt
                  ? new Date(selected.finishedAt).toLocaleString('zh-CN')
                  : '-'}
              </Descriptions.Item>
            </Descriptions>

            {selected.errorMessage && (
              <div
                style={{
                  background: token.colorErrorBg,
                  border: `1px solid ${token.colorErrorBorder}`,
                  padding: '8px 12px',
                  borderRadius: 4,
                  marginBottom: 16,
                  fontSize: 13,
                  color: token.colorErrorText,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}
              >
                {selected.errorMessage}
              </div>
            )}

            <div style={{ marginBottom: 8, fontWeight: 500 }}>参数 (params)</div>
            <pre
              style={{
                background: token.colorFillTertiary,
                border: `1px solid ${token.colorBorderSecondary}`,
                borderRadius: 4,
                padding: '8px 12px',
                marginBottom: 16,
                fontSize: 12,
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 240,
                overflow: 'auto',
                color: token.colorText,
              }}
            >
              {JSON.stringify(selected.params ?? {}, null, 2)}
            </pre>

            {selected.output && (
              <>
                <div style={{ marginBottom: 8, fontWeight: 500 }}>输出 (output)</div>
                <pre
                  style={{
                    background: token.colorFillTertiary,
                    border: `1px solid ${token.colorBorderSecondary}`,
                    borderRadius: 4,
                    padding: '8px 12px',
                    fontSize: 12,
                    fontFamily: 'monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: 320,
                    overflow: 'auto',
                    color: token.colorText,
                  }}
                >
                  {selected.output}
                </pre>
              </>
            )}
          </>
        )}
      </Drawer>
    </>
  )
}
