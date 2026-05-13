import { Alert, Button } from 'antd'
import { BulbOutlined } from '@ant-design/icons'
import type { BrainstormActive } from '../../api/brainstorm'

interface Props {
  active: BrainstormActive | null
  onJump: () => void
}

/**
 * L1 顶部横幅 — active brainstorm waiter 等待用户答复时强提示。
 * 不管用户停在哪个 Tab 都看得见，CTA 一键切到 Brainstorm Tab。
 */
export function BrainstormAlert({ active, onJump }: Props) {
  if (!active) return null

  const expiresIn = formatRemaining(active.expiresAt)

  return (
    <Alert
      type="warning"
      showIcon
      icon={<BulbOutlined />}
      message={
        <span>
          Brainstorm 等待你的答复（第 <strong>{active.round}/{active.maxRounds}</strong> 轮，
          {expiresIn}后超时）
        </span>
      }
      action={
        <Button type="primary" size="small" onClick={onJump}>
          去回答 →
        </Button>
      }
      style={{ marginBottom: 16 }}
    />
  )
}

function formatRemaining(expiresAtIso: string): string {
  const ms = new Date(expiresAtIso).getTime() - Date.now()
  if (ms <= 0) return '已'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h > 0) return `约 ${h}h${m > 0 ? `${m}m` : ''}`
  if (m > 0) return `约 ${m} 分钟`
  return '不到 1 分钟'
}
