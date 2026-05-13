import { Tabs, Badge } from 'antd'
import { useSearchParams } from 'react-router-dom'
import type { RequirementDetailDTO } from '../../api/requirements'
import { NodesTab } from './NodesTab'
import { SpecTab } from './SpecTab'
import { PlanTab } from './PlanTab'
import { ApprovalsTab } from './ApprovalsTab'
import { BrainstormTab } from './BrainstormTab'
import type { BrainstormState } from '../../api/brainstorm'

const VALID_TABS = new Set(['nodes', 'spec', 'plan', 'approvals', 'brainstorm'])

interface Props {
  detail: RequirementDetailDTO
  onRetried: () => void
  brainstormState: BrainstormState | null
  brainstormLoading: boolean
  onBrainstormAnswered: () => void
  /** 由父组件控制的当前 tab，用于 BrainstormAlert 跳转 */
  forceTab?: string
}

export function DetailTabs({
  detail,
  onRetried,
  brainstormState,
  brainstormLoading,
  onBrainstormAnswered,
  forceTab,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = forceTab ?? searchParams.get('tab') ?? 'nodes'
  const activeTab = VALID_TABS.has(tabFromUrl) ? tabFromUrl : 'nodes'

  const handleTabChange = (key: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', key)
    setSearchParams(next, { replace: true })
  }

  const hasActiveBrainstorm = !!brainstormState?.active

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 8, padding: 16, border: '1px solid #EEF0F4' }}>
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          {
            key: 'nodes',
            label: '节点执行',
            children: <NodesTab detail={detail} onRetried={onRetried} />,
          },
          {
            key: 'spec',
            label: 'Spec',
            children: <SpecTab source={detail.specContent} emptyText="Spec 尚未生成" />,
          },
          {
            key: 'plan',
            label: 'Plan',
            children: <PlanTab source={detail.planContent} />,
          },
          {
            key: 'approvals',
            label: '审批历史',
            children: <ApprovalsTab waiters={detail.waiters ?? []} />,
          },
          {
            key: 'brainstorm',
            label: hasActiveBrainstorm ? <Badge dot offset={[6, 0]}>Brainstorm</Badge> : 'Brainstorm',
            children: (
              <BrainstormTab
                requirementId={detail.id}
                state={brainstormState}
                loading={brainstormLoading}
                onAnswered={onBrainstormAnswered}
              />
            ),
          },
        ]}
      />
    </div>
  )
}
