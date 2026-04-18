import { useEffect, useRef, useState } from 'react'
import { Card, Table, Tag, Button, Drawer, Timeline, Space, Descriptions, message, Avatar, theme } from 'antd'
import { ReloadOutlined, FileTextOutlined, DownloadOutlined, UserOutlined } from '@ant-design/icons'
import { getTestRuns, getTestRun } from '../api/test-runs'
import type { TestRunWithUser } from '../api/test-runs'
import { getTestPipelines } from '../api/test-pipelines'
import { usePagination } from '../hooks/usePagination'
import type { TestPipeline } from '../types'

const statusColors: Record<string, string> = { pending: 'default', running: 'processing', success: 'success', failed: 'error', cancelled: 'warning' }
const statusLabels: Record<string, string> = { pending: '等待中', running: '执行中', success: '成功', failed: '失败', cancelled: '已取消' }

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`
}

export default function TestRunsPage() {
  const { token } = theme.useToken()
  const [data, setData] = useState<TestRunWithUser[]>([])
  const [pipelines, setPipelines] = useState<TestPipeline[]>([])
  const [loading, setLoading] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [selectedRun, setSelectedRun] = useState<TestRunWithUser | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const { page, limit, setTotal, tableProps } = usePagination(20)

  useEffect(() => { loadPipelines() }, [])

  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    load()
  }, [page, limit])

  async function load() {
    setLoading(true)
    try {
      const res = await getTestRuns({ page, limit }, abortRef.current?.signal)
      setData(res.data)
      setTotal(res.total)
    } catch {
      // ignore abort errors
    } finally {
      setLoading(false)
    }
  }

  async function loadPipelines() {
    try { setPipelines(await getTestPipelines()) } catch { /* */ }
  }

  async function showDetail(id: number) {
    try {
      const run = await getTestRun(id)
      setSelectedRun(run)
      setDrawerOpen(true)
    } catch { message.error('加载失败') }
  }

  const triggerLabels: Record<string, string> = { manual: '手动', api: 'API', scheduled: '定时' }

  const columns = [
    { title: '摘要', dataIndex: 'summary', ellipsis: true, render: (v: string) => v || '-' },
    { title: '触发人', dataIndex: 'triggeredByName', width: 100, render: (_: unknown, r: TestRunWithUser) => r.triggeredByName ? <span><Avatar size={20} src={r.triggeredByAvatar} icon={<UserOutlined />} style={{ marginRight: 4 }} />{r.triggeredByName}</span> : (r.triggeredBy || '-') },
    { title: '流水线', dataIndex: 'pipelineId', width: 120, render: (v: number) => pipelines.find(p => p.id === v)?.name ?? `#${v}` },
    { title: '触发', dataIndex: 'triggerType', width: 60, render: (v: string) => triggerLabels[v] ?? v },
    { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag color={statusColors[v]}>{statusLabels[v] ?? v}</Tag> },
    { title: '进度', width: 60, render: (_: unknown, r: TestRunWithUser) => `${r.stageResults.filter(s => s.status === 'success' || s.status === 'failed').length}/${r.stageResults.length}` },
    { title: '开始时间', dataIndex: 'startedAt', width: 160, render: (v: string | null) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
    {
      title: '操作',
      width: 60,
      render: (_: unknown, r: TestRunWithUser) => (
        <a onClick={() => showDetail(r.id)}>详情</a>
      ),
    },
  ]

  const stageStatusColors: Record<string, string> = { success: 'green', failed: 'red', running: 'blue', pending: 'gray', skipped: 'gray' }

  return (
    <>
      <Card title="执行记录" extra={<Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>}>
        <Table rowKey="id" columns={columns} dataSource={data} loading={loading} {...tableProps} />
      </Card>

      <Drawer title={selectedRun ? `执行详情 #${selectedRun.id}` : ''} open={drawerOpen} onClose={() => setDrawerOpen(false)} width={600}>
        {selectedRun && (
          <>
            <Descriptions column={2} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="状态"><Tag color={statusColors[selectedRun.status]}>{statusLabels[selectedRun.status]}</Tag></Descriptions.Item>
              <Descriptions.Item label="触发方式">{triggerLabels[selectedRun.triggerType]}</Descriptions.Item>
              <Descriptions.Item label="触发人">{selectedRun.triggeredByName ? <span><Avatar size={20} src={selectedRun.triggeredByAvatar} icon={<UserOutlined />} style={{ marginRight: 4 }} />{selectedRun.triggeredByName}</span> : (selectedRun.triggeredBy || '-')}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{selectedRun.startedAt ? new Date(selectedRun.startedAt).toLocaleString('zh-CN') : '-'}</Descriptions.Item>
              <Descriptions.Item label="结束时间">{selectedRun.finishedAt ? new Date(selectedRun.finishedAt).toLocaleString('zh-CN') : '-'}</Descriptions.Item>
            </Descriptions>

            {selectedRun.errorMessage && (
              <div style={{ background: token.colorErrorBg, border: `1px solid ${token.colorErrorBorder}`, padding: '8px 12px', borderRadius: 4, marginBottom: 16, fontSize: 13, color: token.colorErrorText }}>
                {selectedRun.errorMessage}
              </div>
            )}

            <div style={{ marginBottom: 8, fontWeight: 500 }}>服务器分配</div>
            <div style={{ marginBottom: 16 }}>
              {Object.entries(selectedRun.servers).map(([role, hosts]) => (
                <div key={role}><Tag>{role}</Tag> {(hosts as string[]).join(', ')}</div>
              ))}
            </div>

            <div style={{ marginBottom: 8, fontWeight: 500 }}>执行阶段</div>
            <Timeline items={selectedRun.stageResults.map(s => ({
              color: stageStatusColors[s.status] ?? 'gray',
              children: (
                <div>
                  <strong>{s.name}</strong> <Tag color={stageStatusColors[s.status]}>{s.status}</Tag>
                  {s.durationMs !== undefined && <span style={{ fontSize: 12, color: '#999', marginLeft: 8 }}>{formatDuration(s.durationMs)}</span>}
                  {s.output && (
                    <pre style={{ background: token.colorFillTertiary, border: `1px solid ${token.colorBorderSecondary}`, borderRadius: 4, padding: '8px 12px', marginTop: 6, fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto', color: token.colorText }}>
                      {s.output}
                    </pre>
                  )}
                  {s.error && <div style={{ color: token.colorErrorText, fontSize: 12, marginTop: 4, background: token.colorErrorBg, padding: '4px 8px', borderRadius: 4 }}>{s.error}</div>}
                  {s.aiAnalysis && (
                    <div style={{ background: token.colorInfoBg, border: `1px solid ${token.colorInfoBorder}`, borderRadius: 4, padding: '8px 12px', marginTop: 6, fontSize: 12, color: token.colorText }}>
                      <strong>🤖 AI 分析：</strong>
                      <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{s.aiAnalysis}</div>
                    </div>
                  )}
                </div>
              ),
            }))} />

            {selectedRun.hasReport && (
              <Space style={{ marginTop: 16 }}>
                <Button type="primary" icon={<FileTextOutlined />} href={`/api/test-runs/${selectedRun.id}/report`} target="_blank">
                  查看报告
                </Button>
                <Button icon={<DownloadOutlined />} href={`/api/test-runs/${selectedRun.id}/report/download`}>
                  下载数据包
                </Button>
              </Space>
            )}
          </>
        )}
      </Drawer>
    </>
  )
}
