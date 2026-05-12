import type { ApprovalWaiterDTO } from '../../api/requirements'
import { WaiterTimeline } from '../../components/WaiterTimeline'

interface Props {
  waiters: ApprovalWaiterDTO[]
}

export function ApprovalsTab({ waiters }: Props) {
  return <WaiterTimeline waiters={waiters} />
}
