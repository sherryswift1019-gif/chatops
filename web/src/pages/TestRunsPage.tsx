import { useEffect, useRef, useState } from 'react'
import { Card, Table, Tag, Button, Drawer, Timeline, Space, Descriptions, message, Avatar } from 'antd'
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
      const res = await getTestRuns({ page, limit })
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
    { title: 'ID', dataIndex: 'id' },
    { title: '流水线', dataIndex: 'pipelineId', render: (v: number) => pipelines.find(p => p.id === v)?.name ?? `#${v}` },
    { title: '触发', dataIndex: 'triggerType', render: (v: string) => triggerLabels[v] ?? v },
    { title: '触发人', dataIndex: 'triggeredByName', render: (_: unknown, r: TestRunWithUser) => r.triggeredByName ? <span><Avatar size={20} src={r.triggeredByAvatar} icon={<UserOutlined />} style={{ marginRight: 4 }} />{r.triggeredByName}</span> : (r.triggeredBy || '-') },
    { title: '状态', dataIndex: 'status', render: (v: string) => <Tag color={statusColors[v]}>{statusLabels[v] ?? v}</Tag> },
    { title: '进度', render: (_: unknown, r: TestRunWithUser) => `${r.stageResults.filter(s => s.status === 'success' || s.status === 'failed').length}/${r.stageResults.length}` },
    { title: '开始时间', dataIndex: 'startedAt', render: (v: string | null) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
    { title: '结束时间', dataIndex: 'finishedAt', render: (v: string | null) => v ? new Date(v).toLocaleString('zh-CN') : '-' },
    {
      title: '操作',
      render: (_: unknown, r: TestRunWithUser) => (
        <Space>
          <a onClick={() => showDetail(r.id)}>详情</a>
          {(r.status === 'success' || r.status === 'failed') && (
            <a href={`/api/test-runs/${r.id}/report`} target="_blank" rel="noopener"><FileTextOutlined /></a>
          )}
        </Space>
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
              <div style={{ background: '#fff2f0', border: '1px solid #ffa39e', padding: '8px 12px', borderRadius: 4, marginBottom: 16, fontSize: 13 }}>
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
                    <pre style={{ background: '#f5f5f5', border: '1px solid #e8e8e8', borderRadius: 4, padding: '8px 12px', marginTop: 6, fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflow: 'auto' }}>
                      {s.output}
                    </pre>
                  )}
                  {s.error && <div style={{ color: '#ff4d4f', fontSize: 12, marginTop: 4, background: '#fff2f0', padding: '4px 8px', borderRadius: 4 }}>{s.error}</div>}
                  {s.aiAnalysis && (
                    <div style={{ background: '#f0f5ff', border: '1px solid #adc6ff', borderRadius: 4, padding: '8px 12px', marginTop: 6, fontSize: 12 }}>
                      <strong>🤖 AI 分析：</strong>
                      <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{s.aiAnalysis}</div>
                    </div>
                  )}
                </div>
              ),
            }))} />

            {(selectedRun.status === 'success' || selectedRun.status === 'failed') && (
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
