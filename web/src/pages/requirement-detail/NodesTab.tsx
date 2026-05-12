import { useState, useEffect } from 'react'
import { Space, Switch, Typography, message } from 'antd'
import type { RequirementDetailDTO } from '../../api/requirements'
import { requirementsApi } from '../../api/requirements'
import { NodeRow } from './NodeRow'

const { Text } = Typography

interface Props {
  detail: RequirementDetailDTO
  onRetried: () => void
}

export function NodesTab({ detail, onRetried }: Props) {
  const stageResults = detail.stageResults ?? []
  // WHY 两个 Set：expanded 是当前展开的节点集合；autoExpandedTracked 记录"已经自动展开过一次"
  // 的节点。这样轮询新数据进来后，若用户曾手动折叠某个 failed/running 节点，不会因为再次轮询而
  // 被强制重新展开 —— 只有"首次见到该节点处于 failed/running"时才自动展开。
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [autoExpandedTracked, setAutoExpandedTracked] = useState<Set<string>>(new Set())
  const [showSkipped, setShowSkipped] = useState(false)

  // 自动展开 failed / running 节点（只首次，用户手动 collapse 后不再强制展开）
  useEffect(() => {
    const next = new Set(expanded)
    const tracked = new Set(autoExpandedTracked)
    let changed = false
    for (const sr of stageResults) {
      if ((sr.status === 'failed' || sr.status === 'running') && !tracked.has(sr.name)) {
        next.add(sr.name)
        tracked.add(sr.name)
        changed = true
      }
    }
    if (changed) {
      setExpanded(next)
      setAutoExpandedTracked(tracked)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageResults])

  const toggle = (name: string) => {
    setExpanded(s => {
      const next = new Set(s)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  const handleRetry = async (nodeName: string) => {
    try {
      await requirementsApi.retryFromNode(detail.id, nodeName)
      message.success(`已从节点「${nodeName}」重试`)
      onRetried()
    } catch (err: any) {
      message.error(`重试失败：${err?.response?.data?.error ?? err.message}`)
    }
  }

  if (stageResults.length === 0) {
    return <Text type="secondary">流水线尚未启动，点「运行」开始</Text>
  }

  const skippedCount = stageResults.filter(s => s.status === 'skipped').length
  const visible = showSkipped ? stageResults : stageResults.filter(s => s.status !== 'skipped')

  // 能否触发重试：requirement.status==='failed' 或 stageResults 含 failed
  const canRetry = detail.status === 'failed' || stageResults.some(s => s.status === 'failed')

  return (
    <div>
      {visible.map((sr) => (
        <NodeRow
          key={sr.name}
          stage={sr}
          expanded={expanded.has(sr.name)}
          onToggle={() => toggle(sr.name)}
          waiters={detail.waiters ?? []}
          allStages={stageResults}
          onRetry={canRetry ? handleRetry : undefined}
        />
      ))}
      {skippedCount > 0 && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #EEF0F4', fontSize: 12, color: '#8c8c8c' }}>
          <Space>
            <span>跳过节点 {skippedCount} 个</span>
            <Switch size="small" checked={showSkipped} onChange={setShowSkipped} />
            <span>{showSkipped ? '已展开' : '已隐藏'}</span>
          </Space>
        </div>
      )}
    </div>
  )
}
