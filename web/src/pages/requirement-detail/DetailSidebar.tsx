import type { RequirementDetailDTO, ApprovalWaiterDTO } from '../../api/requirements'
import { PendingWaiterCard } from './PendingWaiterCard'
import { MetaInfoCard } from './MetaInfoCard'
import { RawInputCard } from './RawInputCard'

interface Props {
  detail: RequirementDetailDTO
  onDecide: (waiter: ApprovalWaiterDTO) => void
}

export function DetailSidebar({ detail, onDecide }: Props) {
  // 与 effectiveStatus 保持一致：claimedBy 空即为 pending（system orphan 不识别为 pending）
  const pendingWaiter = detail.waiters?.find(w => !w.claimedBy) ?? null

  return (
    <div style={{
      width: 380,
      flexShrink: 0,
      position: 'sticky',
      top: 72,
      alignSelf: 'flex-start',
      maxHeight: 'calc(100vh - 88px)',
      overflowY: 'auto',
    }}>
      {pendingWaiter && (
        <PendingWaiterCard
          waiter={pendingWaiter}
          onDecide={() => onDecide(pendingWaiter)}
        />
      )}
      <MetaInfoCard detail={detail} />
      <RawInputCard rawInput={detail.rawInput} />
    </div>
  )
}
