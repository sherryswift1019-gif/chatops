import { Button, Space, Typography } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import type { ApprovalWaiterDTO } from '../../api/requirements'
import { KIND_LABEL } from '../requirements-helpers'
import { formatRelativeDuration } from '../../components/WaiterTimeline'

const { Text } = Typography

interface Props {
  waiter: ApprovalWaiterDTO
  onDecide: () => void
}

export function PendingWaiterCard({ waiter, onDecide }: Props) {
  const source = waiter.imPlatform && waiter.imGroupId
    ? `${waiter.imPlatform} 群已推送`
    : '仅 web 端可决策'

  return (
    <div style={{
      background: '#FFFBE6',
      border: '1px solid #faad14',
      borderRadius: 8,
      padding: 16,
      marginBottom: 16,
    }}>
      <Space size={8} style={{ marginBottom: 8 }}>
        <ExclamationCircleOutlined style={{ color: '#faad14', fontSize: 18 }} />
        <Text strong style={{ fontSize: 14 }}>待你决策</Text>
      </Space>
      <div style={{ fontSize: 13, color: '#5C6578', lineHeight: 1.8 }}>
        <div>{KIND_LABEL[waiter.approvalKind] ?? waiter.approvalKind} · 第 {waiter.round} 轮</div>
        <div>已等待 {formatRelativeDuration(waiter.createdAt)}</div>
        <div>{source}</div>
      </div>
      <Button
        type="primary"
        block
        style={{ marginTop: 12 }}
        onClick={onDecide}
      >
        前往决策 →
      </Button>
    </div>
  )
}
