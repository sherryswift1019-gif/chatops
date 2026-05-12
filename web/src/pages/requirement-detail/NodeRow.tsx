import React from 'react'
import { Tag, Typography, Button, Popconfirm } from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined,
  SyncOutlined, ClockCircleOutlined,
  MinusCircleOutlined, DownOutlined, RightOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import type { ApprovalWaiterDTO, V2StageResult } from '../../api/requirements'
import { NodeExpandedDetail } from './NodeExpandedDetail'

const { Text } = Typography

const STATUS_META: Record<V2StageResult['status'], { color: string; icon: React.ReactNode; label: string }> = {
  pending:  { color: 'default',    icon: <ClockCircleOutlined />,           label: 'pending' },
  running:  { color: 'processing', icon: <SyncOutlined spin />,             label: 'running' },
  waiting:  { color: 'warning',    icon: <ClockCircleOutlined />,           label: 'waiting' },
  success:  { color: 'success',    icon: <CheckCircleOutlined />,           label: 'success' },
  failed:   { color: 'error',      icon: <CloseCircleOutlined />,           label: 'failed' },
  skipped:  { color: 'default',    icon: <MinusCircleOutlined />,           label: 'skipped' },
}

function fmtDuration(ms?: number): string {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

interface Props {
  stage: V2StageResult
  expanded: boolean
  onToggle: () => void
  waiters: ApprovalWaiterDTO[]
  allStages: V2StageResult[]
  onRetry?: (nodeName: string) => Promise<void>
}

export function NodeRow({ stage, expanded, onToggle, waiters, allStages, onRetry }: Props) {
  const meta = STATUS_META[stage.status] ?? STATUS_META.pending
  const isFailed = stage.status === 'failed'

  return (
    <div style={{
      borderLeft: isFailed ? '3px solid #ff4d4f' : '3px solid transparent',
      paddingLeft: 12,
      marginBottom: 4,
    }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 8px',
          cursor: 'pointer',
          borderRadius: 6,
          ...(expanded ? { background: '#F6F7FA' } : {}),
        }}
      >
        <span style={{ color: meta.color === 'success' ? '#52c41a' : meta.color === 'error' ? '#ff4d4f' : meta.color === 'processing' ? '#1677ff' : '#8c8c8c' }}>
          {meta.icon}
        </span>
        <Text strong style={{ flex: 1 }}>{stage.name}</Text>
        <Tag color={meta.color}>{meta.label}</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>{stage.type}</Text>
        {stage.durationMs ? (
          <Text type="secondary" style={{ fontSize: 12 }}>· {fmtDuration(stage.durationMs)}</Text>
        ) : null}
        {expanded ? <DownOutlined style={{ fontSize: 10, color: '#8c8c8c' }} /> : <RightOutlined style={{ fontSize: 10, color: '#8c8c8c' }} />}
      </div>

      {expanded && (
        <>
          <NodeExpandedDetail stage={stage} waiters={waiters} allStages={allStages} />
          {isFailed && onRetry && (
            <div style={{ paddingLeft: 24, marginTop: 8, marginBottom: 12 }}>
              <Popconfirm
                title={`从「${stage.name}」节点重试？`}
                description="将截断该节点之后的所有结果，从此节点重新执行。"
                onConfirm={() => onRetry(stage.name)}
                okText="重试"
                cancelText="取消"
              >
                <Button danger icon={<ReloadOutlined />} size="small">
                  从此节点重试
                </Button>
              </Popconfirm>
            </div>
          )}
        </>
      )}
    </div>
  )
}
