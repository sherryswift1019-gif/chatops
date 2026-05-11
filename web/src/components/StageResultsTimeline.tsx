import React from 'react'
import { Timeline, Tag, Tooltip, Space, Typography } from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  ClockCircleOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons'

type StageResult = {
  name: string
  type: string
  status: 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'skipped'
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  error?: string
}

type PipelineNode = {
  id?: string
  name?: string
  stageType?: string
}

const STATUS_META: Record<StageResult['status'], { color: string; icon: React.ReactNode }> = {
  pending:  { color: 'default',    icon: <ClockCircleOutlined /> },
  running:  { color: 'processing', icon: <SyncOutlined spin /> },
  waiting:  { color: 'warning',    icon: <ClockCircleOutlined /> },
  success:  { color: 'success',    icon: <CheckCircleOutlined /> },
  failed:   { color: 'error',      icon: <CloseCircleOutlined /> },
  skipped:  { color: 'default',    icon: <MinusCircleOutlined /> },
}

function fmtDuration(ms?: number): string {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export function StageResultsTimeline({
  stageResults,
  pipelineNodes,
}: {
  stageResults: StageResult[]
  pipelineNodes?: PipelineNode[]
}) {
  const nodeNameMap = new Map<string, string>()
  for (const n of pipelineNodes ?? []) {
    if (n.id && n.name) nodeNameMap.set(n.id, n.name)
  }

  if (!stageResults.length) {
    return <Typography.Text type="secondary">还没有任何节点执行记录</Typography.Text>
  }

  return (
    <Timeline mode="left">
      {stageResults.map((sr, idx) => {
        const meta = STATUS_META[sr.status] ?? STATUS_META.pending
        const displayName = nodeNameMap.get(sr.name) ?? sr.name
        return (
          <Timeline.Item key={`${sr.name}-${idx}`} color={meta.color} dot={meta.icon}>
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Space>
                <Typography.Text strong>{displayName}</Typography.Text>
                <Tag color={meta.color}>{sr.status}</Tag>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {sr.type}
                </Typography.Text>
                {sr.durationMs ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    · {fmtDuration(sr.durationMs)}
                  </Typography.Text>
                ) : null}
              </Space>
              {sr.error ? (
                <Tooltip title={sr.error}>
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    {sr.error.slice(0, 120)}{sr.error.length > 120 ? '…' : ''}
                  </Typography.Text>
                </Tooltip>
              ) : null}
            </Space>
          </Timeline.Item>
        )
      })}
    </Timeline>
  )
}
