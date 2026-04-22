import { useMemo } from 'react'
import { Alert, Button, Card, Layout, Space, Tag, Tooltip, Typography } from 'antd'
import { ArrowLeftOutlined, FileTextOutlined, ReloadOutlined } from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { usePrdChatStream } from '../hooks/usePrdChatStream'
import { ChatInput, ChatMessageList } from '../components/chat/ChatComponents'

const { Content } = Layout
const { Title, Text } = Typography

const PHASE_LABELS: Record<string, { label: string; color: string }> = {
  discovery: { label: '需求探索', color: 'blue' },
  functional: { label: '功能梳理', color: 'geekblue' },
  scope_confirmation: { label: '范围确认', color: 'purple' },
  generating: { label: '生成中', color: 'orange' },
  generated: { label: '已生成', color: 'green' },
  features: { label: '功能梳理', color: 'geekblue' },
  scope: { label: '范围确认', color: 'purple' },
}

export default function PrdChatPage() {
  const { sessionKey = '' } = useParams()
  const navigate = useNavigate()
  const { session, messages, sending, error, send, loadHistory } = usePrdChatStream(sessionKey)

  const phaseTag = useMemo(() => {
    // 从最后一条 tool_use(update_prd_context) 推断 phase，若无则从 session 提示
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if ((m as { role?: string }).role === 'tool_use' && (m as { toolName?: string }).toolName === 'update_prd_context') {
        try {
          const parsed = JSON.parse((m as { content: string }).content) as {
            contextJson?: { phase?: string }
          }
          const phase = parsed.contextJson?.phase
          if (phase) return phase
        } catch {
          // ignore
        }
      }
    }
    return null
  }, [messages])

  return (
    <Layout style={{ height: 'calc(100vh - 104px)', background: '#FFFFFF', overflow: 'hidden' }}>
      <Content
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          minHeight: 0,
        }}
      >
        <Card
          size="small"
          style={{
            borderRadius: 0,
            borderLeft: 0,
            borderRight: 0,
            borderTop: 0,
          }}
          bodyStyle={{ padding: '12px 24px' }}
        >
          <Space align="center" size={12} style={{ width: '100%', justifyContent: 'space-between' }}>
            <Space size={12} align="center">
              <Button
                icon={<ArrowLeftOutlined />}
                onClick={() => navigate('/prd-documents')}
                type="text"
              />
              <Title level={5} style={{ margin: 0 }}>
                PRD 对话
              </Title>
              {session?.prdId ? (
                <Tooltip title="打开 PRD 详情">
                  <Tag
                    color="blue"
                    icon={<FileTextOutlined />}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/prd-documents?prdId=${session.prdId}`)}
                  >
                    PRD #{session.prdId}
                  </Tag>
                </Tooltip>
              ) : (
                <Tag>未关联 PRD</Tag>
              )}
              {phaseTag && (
                <Tag color={PHASE_LABELS[phaseTag]?.color ?? 'default'}>
                  阶段：{PHASE_LABELS[phaseTag]?.label ?? phaseTag}
                </Tag>
              )}
            </Space>
            <Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {session ? `产线 #${session.productLineId} · ${session.createdBy}` : '…'}
              </Text>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={loadHistory}
                disabled={sending}
              >
                刷新
              </Button>
            </Space>
          </Space>
        </Card>

        {error && (
          <Alert
            type="error"
            message={error}
            closable
            style={{ margin: '12px 24px 0' }}
          />
        )}

        <ChatMessageList
          messages={messages}
          emptyHint="说说你想要的 PRD，比如：「帮我写一个用户管理模块的 PRD」。"
        />

        <ChatInput sending={sending} onSend={send} />
      </Content>
    </Layout>
  )
}
