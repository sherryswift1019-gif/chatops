import { useState, useEffect, useCallback } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { Spin, Result, Button } from 'antd'
import {
  requirementsApi,
  type RequirementDetailDTO,
  type ApprovalWaiterDTO,
} from '../api/requirements'
import { usePolling } from './requirement-detail/usePolling'
import { DetailSidebar } from './requirement-detail/DetailSidebar'
import { DetailTabs } from './requirement-detail/DetailTabs'
import { DetailHeader } from './requirement-detail/DetailHeader'
import { BrainstormAlert } from './requirement-detail/BrainstormAlert'
import { useBrainstormState } from './requirement-detail/useBrainstormState'
import { DecideModal } from '../components/DecideModal'

function isValidId(s: string | undefined): s is string {
  if (!s) return false
  return /^\d+$/.test(s)
}

export default function RequirementDetailPage() {
  const { id: idStr } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  // 2. DecideModal 状态（用于暂停轮询）
  const [decideWaiter, setDecideWaiter] = useState<ApprovalWaiterDTO | null>(null)
  const decideOpen = decideWaiter !== null

  const validId = isValidId(idStr)
  const id = validId ? Number(idStr) : 0

  // 3. 数据加载 + 轮询
  // active 策略：决策 Modal 打开时暂停；其它情况都 5s 轮询。
  // 终态需求每 5s 一次空 GET 代价可忽略，省去 chicken-and-egg 的派生 active 复杂度。
  const fetcher = useCallback(async () => {
    if (!validId) {
      throw new Error('invalid id, skipping fetch')
    }
    return requirementsApi.get(id)
  }, [id, validId])
  const { data: detail, loading, error, lastFetchedAt, refetch } = usePolling<RequirementDetailDTO>(
    fetcher,
    {
      active: validId && !decideOpen,
      intervalMs: 5000,
    },
  )

  // Brainstorm 状态 — 独立 hook，跟 requirement polling 并行
  const {
    state: brainstormState,
    loading: brainstormLoading,
    refetch: refetchBrainstorm,
    triggerFastPoll,
  } = useBrainstormState(id, validId && !decideOpen)

  const handleBrainstormAnswered = useCallback(() => {
    triggerFastPoll(20000)
    void refetchBrainstorm()
  }, [refetchBrainstorm, triggerFastPoll])

  const jumpToBrainstormTab = useCallback(() => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', 'brainstorm')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  // 4. URL ?openWaiter=M 直达决策
  useEffect(() => {
    const wStr = searchParams.get('openWaiter')
    if (!wStr || !detail) return
    const wid = Number(wStr)
    if (!Number.isFinite(wid)) return
    const w = detail.waiters?.find(x => x.id === wid && !x.claimedBy)
    if (!w) return
    setDecideWaiter(w)
    const next = new URLSearchParams(searchParams)
    next.delete('openWaiter')
    setSearchParams(next, { replace: true })
  }, [detail, searchParams, setSearchParams])

  // 1. 路径参数校验（hooks 已全部 declare 完，可以提前 return）
  if (!validId) {
    return (
      <Result
        status="404"
        title="无效的需求 ID"
        subTitle="路径必须形如 /requirements/123"
        extra={<Button onClick={() => navigate('/requirements')}>返回列表</Button>}
      />
    )
  }

  // 5. 错误兜底
  if (error && !detail) {
    return (
      <Result
        status="404"
        title="需求不存在或已被删除"
        extra={<Button onClick={() => navigate('/requirements')}>返回列表</Button>}
      />
    )
  }

  // 6. 加载中
  if (!detail) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ background: '#F6F7FA', minHeight: 'calc(100vh - 56px)' }}>
      <DetailHeader
        detail={detail}
        lastFetchedAt={lastFetchedAt}
        loading={loading}
        onRefresh={() => void refetch()}
        onActed={() => void refetch()}
      />

      <div style={{ padding: '0 16px' }}>
        <BrainstormAlert
          active={brainstormState?.active ?? null}
          onJump={jumpToBrainstormTab}
        />
      </div>

      {/* 左右栏 */}
      <div style={{ display: 'flex', gap: 16, padding: 16 }}>
        <DetailSidebar
          detail={detail}
          onDecide={(w) => setDecideWaiter(w)}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <DetailTabs
            detail={detail}
            onRetried={() => void refetch()}
            brainstormState={brainstormState}
            brainstormLoading={brainstormLoading}
            onBrainstormAnswered={handleBrainstormAnswered}
          />
        </div>
      </div>

      {/* 决策 Modal */}
      <DecideModal
        open={decideOpen}
        waiter={decideWaiter}
        requirementId={id}
        detail={detail}
        onClose={() => setDecideWaiter(null)}
        onDecided={() => {
          setDecideWaiter(null)
          void refetch()
        }}
      />
    </div>
  )
}
