import { Timeline, Tag, Space, Typography, Badge } from 'antd'
import type { ApprovalWaiterDTO, ApprovalDecision } from '../api/requirements'
import { KIND_LABEL } from '../pages/requirements-helpers'

const { Text } = Typography

const DECISION_CONFIG: Record<ApprovalDecision, { color: string; label: string }> = {
  approved:       { color: 'success', label: '通过' },
  rejected:       { color: 'error',   label: '拒绝' },
  rejected_plan:  { color: 'error',   label: '拒绝 plan' },
  rejected_spec:  { color: 'error',   label: '拒绝 spec' },
  force_passed:   { color: 'warning', label: '强制通过' },
  budget_extended:{ color: 'blue',    label: '延期' },
  aborted:        { color: 'default', label: '中止' },
  fix:            { color: 'processing', label: '再修一轮' },
}

const CLAIMED_BY_LABEL: Record<NonNullable<ApprovalWaiterDTO['claimedBy']>, string> = {
  im: 'IM 群',
  web: '管理后台',
  retry: '重试',
  abort: '中止',
  system: '系统',
}

function formatRelativeDuration(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return '刚刚'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时`
  const day = Math.floor(hr / 24)
  return `${day} 天`
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function WaiterTimeline({ waiters }: { waiters: ApprovalWaiterDTO[] }) {
  // 过滤 orphan waiter（system-aborted）—— LangGraph interrupt-replay 时 buildHumanGateNode
  // 会创建一个 orphan waiter，由 invalidateWaiter 标 claimed_by='system' + decision='aborted'，
  // 是后端实现细节，不展示。
  const visible = waiters.filter(w => w.claimedBy !== 'system')
  if (visible.length === 0) return <Text type="secondary">暂无审批记录</Text>
  return (
    <Timeline
      items={visible.map(w => {
        const isPending = !w.claimedBy
        const dec = w.decision ? DECISION_CONFIG[w.decision] : null
        return {
          color: isPending ? 'blue' : (dec?.color === 'success' ? 'green' : dec?.color === 'error' ? 'red' : 'gray'),
          children: (
            <div>
              <Space size={6} wrap>
                <Text strong>{KIND_LABEL[w.approvalKind] ?? w.approvalKind}</Text>
                <Text type="secondary">第 {w.round} 轮</Text>
                {isPending && <Badge status="processing" text="等待决策" />}
                {dec && <Tag color={dec.color}>{dec.label}</Tag>}
              </Space>

              {isPending && (
                <div style={{ marginTop: 4, fontSize: 12, color: '#8C8C8C' }}>
                  已等待 {formatRelativeDuration(w.createdAt)}
                  {w.imPlatform && w.imGroupId && <span> · 已推送至 {w.imPlatform} 群</span>}
                </div>
              )}

              {!isPending && (
                <div style={{ marginTop: 4, fontSize: 12, color: '#8C8C8C' }}>
                  {w.claimedAt && <span>{formatDateTime(w.claimedAt)}</span>}
                  {w.decidedBy && <span> · 由 {w.decidedBy} 决策</span>}
                  {w.claimedBy && <span>（{CLAIMED_BY_LABEL[w.claimedBy]}）</span>}
                </div>
              )}

              {w.budgetDelta != null && (
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  <Tag color="blue">预算 +{w.budgetDelta}</Tag>
                </div>
              )}

              {w.rejectReason && (
                <div style={{
                  marginTop: 6, padding: '6px 10px',
                  background: '#FFF1F0', borderLeft: '3px solid #FF4D4F',
                  borderRadius: 4, fontSize: 12,
                  whiteSpace: 'pre-wrap', color: '#434343',
                }}>
                  <Text strong style={{ color: '#CF1322' }}>拒绝原因</Text>
                  <div style={{ marginTop: 2 }}>{w.rejectReason}</div>
                </div>
              )}
            </div>
          ),
        }
      })}
    />
  )
}

// 给详情页焦点卡复用
export { formatRelativeDuration, formatDateTime, DECISION_CONFIG, CLAIMED_BY_LABEL }
