import { SpecTab } from './SpecTab'

interface Props {
  source: string | null
}

export function PlanTab({ source }: Props) {
  // PlanTab 复用 SpecTab 渲染（同样是 markdown + copy）；空态文案不同
  return <SpecTab source={source} emptyText="Plan 尚未生成" />
}
