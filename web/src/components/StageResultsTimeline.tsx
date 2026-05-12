import React, { useState } from 'react'
import { Timeline, Tag, Tooltip, Space, Typography, Button, Popconfirm, Switch } from 'antd'
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  SyncOutlined,
  ClockCircleOutlined,
  MinusCircleOutlined,
  ReloadOutlined,
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
  onRetry,
  isRetryDisabled,
}: {
  stageResults: StageResult[]
  pipelineNodes?: PipelineNode[]
  onRetry?: (nodeId: string) => Promise<void>
  isRetryDisabled?: (nodeId: string) => boolean
}) {
  const nodeNameMap = new Map<string, string>()
  for (const n of pipelineNodes ?? []) {
    if (n.id && n.name) nodeNameMap.set(n.id, n.name)
  }

  // 默认隐藏 skipped（onFailure='stop' / 路由跳过 / 未到达节点）。
  // 想看完整执行图（debug 用）可点 toggle 显示。
  const [showSkipped, setShowSkipped] = useState(false)
  const skippedCount = stageResults.filter(s => s.status === 'skipped').length
  const visibleResults = showSkipped ? stageResults : stageResults.filter(s => s.status !== 'skipped')

  if (!stageResults.length) {
    return <Typography.Text type="secondary">还没有任何节点执行记录</Typography.Text>
  }

  return (
    <>
      {skippedCount > 0 && (
        <div style={{ marginBottom: 8, fontSize: 12, color: '#8c8c8c' }}>
          <Space size={6}>
            <span>跳过节点 {skippedCount} 个</span>
            <Switch size="small" checked={showSkipped} onChange={setShowSkipped} />
            <span>{showSkipped ? '已展开' : '已隐藏'}</span>
          </Space>
        </div>
      )}
      <Timeline mode="left">
      {visibleResults.map((sr, idx) => {
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
              {onRetry && (sr.status === 'failed' || sr.status === 'success') && (
                <Popconfirm
                  title={`确定从「${displayName}」节点重试？`}
                  description="将截断该节点之后的所有结果，从此节点重新执行。"
                  onConfirm={() => onRetry(sr.name)}
                  okText="重试"
                  cancelText="取消"
                  disabled={isRetryDisabled?.(sr.name)}
                >
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    disabled={isRetryDisabled?.(sr.name)}
                    title={isRetryDisabled?.(sr.name) ? '已达 retry 上限' : ''}
                  >
                    重试此节点
                  </Button>
                </Popconfirm>
              )}
            </Space>
          </Timeline.Item>
        )
      })}
    </Timeline>
    </>
  )
}
