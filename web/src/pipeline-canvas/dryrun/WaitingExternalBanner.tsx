import { Alert, Button, message } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import type { DryRunChunk } from './useDryRunSSE'

export function WaitingExternalBanner({ chunk }: { chunk: DryRunChunk }) {
  const hint = chunk.hint as { webhookTag?: string; webhookUrl?: string; imGroupId?: string; imPrompt?: string }
  return (
    <Alert
      type="warning"
      showIcon
      message={`等待外部触发：${chunk.nodeId}（${chunk.stageType}）`}
      description={
        <div>
          {hint.webhookUrl && (
            <div>
              复制并外部 POST 此 URL 触发：
              <code style={{ background: '#fff', padding: '2px 6px', marginLeft: 4 }}>{hint.webhookUrl}</code>
              <Button size="small" type="link" icon={<CopyOutlined />}
                onClick={() => { navigator.clipboard.writeText(hint.webhookUrl!); void message.success('已复制') }} />
            </div>
          )}
          {hint.imPrompt && (
            <div>请在 IM 群（{hint.imGroupId}）回复：<i>{hint.imPrompt}</i></div>
          )}
        </div>
      }
    />
  )
}
