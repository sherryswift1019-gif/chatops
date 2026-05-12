import { useState, useEffect, useCallback } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { Spin, Result, Button, Tag, Space, Typography } from 'antd'
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  requirementsApi,
  type RequirementDetailDTO,
  type ApprovalWaiterDTO,
} from '../api/requirements'
import { effectiveStatus } from './requirement-detail/effectiveStatus'
import { usePolling } from './requirement-detail/usePolling'
import { DetailSidebar } from './requirement-detail/DetailSidebar'
import { DetailTabs } from './requirement-detail/DetailTabs'
import { DecideModal } from '../components/DecideModal'

const { Text } = Typography

function isValidId(s: string | undefined): s is string {
  if (!s) return false
  return /^\d+$/.test(s)
}

function formatRelativeSeconds(date: Date | null): string {
  if (!date) return '—'
  const sec = Math.floor((Date.now() - date.getTime()) / 1000)
  if (sec < 5) return '刚刚'
  if (sec < 60) return `${sec}s 前`
  const min = Math.floor(sec / 60)
  return `${min}m 前`
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

  const eff = effectiveStatus(detail)

  return (
    <div style={{ background: '#F6F7FA', minHeight: 'calc(100vh - 56px)' }}>
      {/* Header 占位（Task 5 替换为 DetailHeader 组件）*/}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: '#FFFFFF', padding: '16px 24px',
        borderBottom: '1px solid #EEF0F4',
      }}>
        <Space size="middle">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/requirements')}>
            返回
          </Button>
          <Text strong style={{ fontSize: 16 }}>
            需求 #{detail.id} — {detail.title}
          </Text>
          <Tag color={eff.color}>{eff.label}</Tag>
        </Space>
        <div style={{ float: 'right', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            上次更新 {formatRelativeSeconds(lastFetchedAt)}
          </Text>
          <Button
            icon={<ReloadOutlined />}
            size="small"
            loading={loading}
            onClick={() => void refetch()}
          >
            刷新
          </Button>
        </div>
      </div>

      {/* 左右栏占位（Task 3 / 4 / 5 填充）*/}
      <div style={{ display: 'flex', gap: 16, padding: 16 }}>
        <DetailSidebar
          detail={detail}
          onDecide={(w) => setDecideWaiter(w)}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <DetailTabs detail={detail} onRetried={() => void refetch()} />
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
