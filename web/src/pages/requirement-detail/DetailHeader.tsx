import { Button, Tag, Space, Typography, Popconfirm, message } from 'antd'
import {
  ArrowLeftOutlined, ReloadOutlined,
  PlayCircleOutlined, StopOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { RequirementDetailDTO, RequirementStatus } from '../../api/requirements'
import { requirementsApi } from '../../api/requirements'
import { effectiveStatus } from './effectiveStatus'
import { ProgressStepper } from './ProgressStepper'

const { Text } = Typography

const STOPPABLE_STATUSES: RequirementStatus[] = [
  'queued', 'spec_review', 'planning', 'developing',
  'reviewing', 'testing', 'mr_pending', 'mr_open',
]

function formatRelativeSeconds(date: Date | null): string {
  if (!date) return '—'
  const sec = Math.floor((Date.now() - date.getTime()) / 1000)
  if (sec < 5) return '刚刚'
  if (sec < 60) return `${sec}s 前`
  const min = Math.floor(sec / 60)
  return `${min}m 前`
}

interface Props {
  detail: RequirementDetailDTO
  lastFetchedAt: Date | null
  loading: boolean
  onRefresh: () => void
  onActed: () => void
}

export function DetailHeader({ detail, lastFetchedAt, loading, onRefresh, onActed }: Props) {
  const navigate = useNavigate()
  const eff = effectiveStatus(detail)

  const handleRun = async () => {
    try {
      await requirementsApi.run(detail.id)
      message.success('已加入队列，worker 将在 30 秒内启动流水线')
      onActed()
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '启动失败')
    }
  }

  const handleStop = async () => {
    try {
      await requirementsApi.abort(detail.id)
      message.success('需求已停止')
      onActed()
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '停止失败')
    }
  }

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 10,
      background: '#FFFFFF', padding: '16px 24px',
      borderBottom: '1px solid #EEF0F4',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Space size="middle">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/requirements')}>
            返回
          </Button>
          <Text strong style={{ fontSize: 16 }}>
            需求 #{detail.id} — {detail.title}
          </Text>
          <Tag color={eff.color}>{eff.label}</Tag>
        </Space>
        <Space size={12}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            上次更新 {formatRelativeSeconds(lastFetchedAt)}
          </Text>
          <Button icon={<ReloadOutlined />} size="small" loading={loading} onClick={onRefresh}>
            刷新
          </Button>
        </Space>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <ProgressStepper
          stageResults={detail.stageResults ?? []}
          skipE2E={detail.skipE2E}
        />
        <Space>
          {detail.status === 'draft' && (
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} size="small">
              运行
            </Button>
          )}
          {STOPPABLE_STATUSES.includes(detail.status) && (
            <Popconfirm
              title="确定要停止该需求吗？"
              description="停止后将标记为已中止，pipeline 将被终止。"
              onConfirm={handleStop}
              okText="停止"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Button danger icon={<StopOutlined />} size="small">中止</Button>
            </Popconfirm>
          )}
        </Space>
      </div>
    </div>
  )
}
