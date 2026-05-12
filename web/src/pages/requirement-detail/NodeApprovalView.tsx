import { Tag, Typography } from 'antd'
import type { ApprovalWaiterDTO, V2StageResult } from '../../api/requirements'
import { DECISION_CONFIG, formatDateTime, CLAIMED_BY_LABEL } from '../../components/WaiterTimeline'
import { KIND_LABEL } from '../requirements-helpers'

const { Text } = Typography

interface Props {
  stage: V2StageResult
  waiters: ApprovalWaiterDTO[]
}

export function NodeApprovalView({ stage, waiters }: Props) {
  // 找该节点对应的最近一个 claimed waiter（按 createdAt 倒序）
  const nodeWaiters = waiters
    .filter(w => w.nodeId === stage.name && w.claimedBy && w.claimedBy !== 'system')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  if (nodeWaiters.length === 0) {
    return <Text type="secondary" style={{ fontSize: 12 }}>无审批记录</Text>
  }

  const latest = nodeWaiters[0]
  const dec = latest.decision ? DECISION_CONFIG[latest.decision] : null

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ marginBottom: 6 }}>
        <Text strong>{KIND_LABEL[latest.approvalKind]} · 第 {latest.round} 轮</Text>
        {dec && <Tag color={dec.color} style={{ marginLeft: 8 }}>{dec.label}</Tag>}
      </div>
      <div style={{ fontSize: 12, color: '#5C6578' }}>
        {latest.claimedAt && <span>{formatDateTime(latest.claimedAt)}</span>}
        {latest.decidedBy && <span> · 由 {latest.decidedBy} 决策</span>}
        {latest.claimedBy && <span>（{CLAIMED_BY_LABEL[latest.claimedBy]}）</span>}
      </div>
      {latest.budgetDelta != null && (
        <div style={{ marginTop: 4 }}>
          <Tag color="blue">预算 +{latest.budgetDelta}</Tag>
        </div>
      )}
      {latest.rejectReason && (
        <div style={{
          marginTop: 6, padding: '6px 10px',
          background: '#FFF1F0', borderLeft: '3px solid #FF4D4F',
          borderRadius: 4, fontSize: 12,
          whiteSpace: 'pre-wrap', color: '#434343',
        }}>
          <Text strong style={{ color: '#CF1322' }}>拒绝原因</Text>
          <div style={{ marginTop: 2 }}>{latest.rejectReason}</div>
        </div>
      )}
      {nodeWaiters.length > 1 && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          该节点共 {nodeWaiters.length} 轮决策，仅显示最近一轮。完整历史请看「审批历史」Tab。
        </Text>
      )}
    </div>
  )
}
