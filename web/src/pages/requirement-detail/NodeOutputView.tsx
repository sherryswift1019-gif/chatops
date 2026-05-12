import { Typography } from 'antd'
import type { V2StageResult } from '../../api/requirements'

const { Text } = Typography

export function NodeOutputView({ stage }: { stage: V2StageResult }) {
  if (!stage.output && !stage.error) {
    return <Text type="secondary" style={{ fontSize: 12 }}>该节点无输出</Text>
  }
  return (
    <div>
      {stage.output && (
        <pre style={{
          background: '#F6F8FA',
          border: '1px solid #E4E7EE',
          borderRadius: 6,
          padding: 12,
          fontSize: 12,
          margin: 0,
          whiteSpace: 'pre-wrap',
          maxHeight: 320,
          overflowY: 'auto',
        }}>
          {stage.output}
        </pre>
      )}
    </div>
  )
}
