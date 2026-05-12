import { Tabs } from 'antd'
import { useSearchParams } from 'react-router-dom'
import type { RequirementDetailDTO } from '../../api/requirements'
import { NodesTab } from './NodesTab'

const VALID_TABS = new Set(['nodes', 'spec', 'plan', 'approvals'])

interface Props {
  detail: RequirementDetailDTO
  onRetried: () => void
}

export function DetailTabs({ detail, onRetried }: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get('tab') ?? 'nodes'
  const activeTab = VALID_TABS.has(tabFromUrl) ? tabFromUrl : 'nodes'

  const handleTabChange = (key: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', key)
    setSearchParams(next, { replace: true })
  }

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
            children: <div>（Task 5 填充）</div>,
          },
          {
            key: 'plan',
            label: 'Plan',
            children: <div>（Task 5 填充）</div>,
          },
          {
            key: 'approvals',
            label: '审批历史',
            children: <div>（Task 5 填充）</div>,
          },
        ]}
      />
    </div>
  )
}
