import { Tag, Typography } from 'antd'
import type { V2StageResult } from '../../api/requirements'

const { Text } = Typography

export function NodeCommitsView({ stage }: { stage: V2StageResult }) {
  const commits = stage.skillOutput?.commits ?? []
  if (commits.length === 0) {
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        {stage.output ? stage.output : '无 commit 记录'}
      </Text>
    )
  }
  return (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>
        Commits（{commits.length} 个）
      </Text>
      <ul style={{ paddingLeft: 20, margin: 0, fontSize: 12 }}>
        {commits.map((c, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            <Tag color={c.tsc === 'pass' ? 'success' : 'error'}>{c.tsc}</Tag>
            {c.isFix && <Tag color="orange">fix r{c.round ?? 2}</Tag>}
            <Text code>{c.sha.slice(0, 7)}</Text>
            {' '}{c.message}
            {c.vitest && (
              <Text type="secondary"> · vitest {c.vitest.passed}p/{c.vitest.failed}f</Text>
            )}
          </li>
        ))}
      </ul>
      {stage.output && (
        <div style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {stage.output}
          </Text>
        </div>
      )}
    </div>
  )
}
