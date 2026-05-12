import type React from 'react'
import { Tag, Typography } from 'antd'
import type { RequirementDetailDTO } from '../../api/requirements'
import { formatDateTime } from '../../components/WaiterTimeline'

const { Text } = Typography

interface Props {
  detail: RequirementDetailDTO
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 13 }}>
      <div style={{ width: 90, color: '#8C8C8C', textAlign: 'right', flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, color: '#1A1F2E', wordBreak: 'break-all' }}>{children}</div>
    </div>
  )
}

export function MetaInfoCard({ detail }: Props) {
  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid #EEF0F4',
      borderRadius: 8,
      padding: 16,
      marginBottom: 16,
    }}>
      <Text strong style={{ display: 'block', marginBottom: 12, fontSize: 14 }}>元信息</Text>

      <Row label="GitLab">{detail.gitlabProject}</Row>
      <Row label="基础分支">{detail.baseBranch}</Row>
      {detail.branch && <Row label="功能分支">{detail.branch}</Row>}
      {detail.skipE2E && <Row label="E2E"><Tag color="orange">已跳过</Tag></Row>}
      {detail.pipelineRunId != null && <Row label="Pipeline">#{detail.pipelineRunId}</Row>}
      {detail.mrUrl && (
        <Row label="MR">
          <a href={detail.mrUrl} target="_blank" rel="noreferrer">{detail.mrUrl}</a>
        </Row>
      )}
      <Row label="创建时间">{formatDateTime(detail.createdAt)}</Row>
      <Row label="创建者">{detail.createdBy ?? '—'}</Row>
      {detail.abortReason && (
        <Row label="中止原因">
          <Text type="danger">{detail.abortReason}</Text>
        </Row>
      )}
    </div>
  )
}
