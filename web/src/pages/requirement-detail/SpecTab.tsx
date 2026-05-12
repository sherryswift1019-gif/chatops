import { useState } from 'react'
import { Button, Typography, message } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import MarkdownViewer from '../../components/MarkdownViewer'

const { Text } = Typography

interface Props {
  source: string | null
  emptyText: string
}

export function SpecTab({ source, emptyText }: Props) {
  const [copyLoading, setCopyLoading] = useState(false)

  if (!source) {
    return <Text type="secondary">{emptyText}</Text>
  }

  const handleCopy = async () => {
    setCopyLoading(true)
    try {
      await navigator.clipboard.writeText(source)
      message.success('已复制')
    } catch {
      message.error('复制失败')
    } finally {
      setCopyLoading(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Button icon={<CopyOutlined />} size="small" loading={copyLoading} onClick={handleCopy}>
          复制
        </Button>
      </div>
      <MarkdownViewer source={source} />
    </div>
  )
}
