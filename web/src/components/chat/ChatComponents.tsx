import { useEffect, useRef, useState } from 'react'
import { Avatar, Button, Card, Collapse, Input, Space, Spin, Tag, Tooltip } from 'antd'
import {
  RobotOutlined,
  SendOutlined,
  ToolOutlined,
  UserOutlined,
  ArrowDownOutlined,
  SafetyCertificateOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ToolFilled,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { Link } from 'react-router-dom'
import MarkdownViewer from '../MarkdownViewer'
import type { PrdChatMessage } from '../../types'
import type { ChatListItem, StreamingAssistant } from '../../hooks/usePrdChatStream'

function isStreaming(m: ChatListItem): m is StreamingAssistant {
  return (m as StreamingAssistant).streaming === true
}

export function UserMessage({ content }: { content: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '14px 0' }}>
      <div
        style={{
          maxWidth: '72%',
          background: '#DCE9FF',
          padding: '10px 14px',
          borderRadius: 12,
          borderTopRightRadius: 2,
          fontSize: 13,
          lineHeight: 1.7,
          color: '#1A1F2E',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {content}
      </div>
      <Avatar
        size={32}
        icon={<UserOutlined />}
        style={{ marginLeft: 10, background: '#4B8BFF', flexShrink: 0 }}
      />
    </div>
  )
}

export function AssistantMessage({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', margin: '14px 0' }}>
      <Avatar
        size={32}
        icon={<RobotOutlined />}
        style={{ marginRight: 10, background: '#6F42C1', flexShrink: 0 }}
      />
      <div
        style={{
          maxWidth: '82%',
          background: '#F6F7FA',
          padding: '6px 14px',
          borderRadius: 12,
          borderTopLeftRadius: 2,
          minHeight: 36,
        }}
      >
        {content.trim() ? (
          <>
            <MarkdownViewer source={content} />
            {streaming && (
              <span
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 14,
                  background: '#4B8BFF',
                  verticalAlign: 'middle',
                  animation: 'chatops-blink 1s steps(2) infinite',
                }}
              />
            )}
          </>
        ) : (
          <Spin size="small" />
        )}
      </div>
    </div>
  )
}

export function ToolCallBubble({ msg, result }: { msg: PrdChatMessage; result?: PrdChatMessage }) {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(msg.content)
  } catch {
    parsed = msg.content
  }
  const header = (
    <Space size={8}>
      <ToolOutlined style={{ color: '#6F42C1' }} />
      <span style={{ fontWeight: 500 }}>{msg.toolName ?? 'tool'}</span>
      <Tag color={result ? 'green' : 'processing'}>{result ? '已完成' : '调用中'}</Tag>
    </Space>
  )
  return (
    <div style={{ margin: '10px 0 10px 42px' }}>
      <Collapse
        size="small"
        ghost
        items={[
          {
            key: String(msg.id),
            label: header,
            children: (
              <div style={{ fontFamily: 'Menlo, Monaco, monospace', fontSize: 12 }}>
                <div style={{ color: '#5C6578', marginBottom: 4 }}>Input</div>
                <pre
                  style={{
                    background: '#0B0D14',
                    color: '#D1D5DB',
                    padding: 10,
                    borderRadius: 6,
                    overflow: 'auto',
                    margin: 0,
                  }}
                >
                  {JSON.stringify(parsed, null, 2)}
                </pre>
                {result && (
                  <>
                    <div style={{ color: '#5C6578', margin: '10px 0 4px' }}>Output</div>
                    <pre
                      style={{
                        background: '#F6F7FA',
                        color: '#1A1F2E',
                        padding: 10,
                        borderRadius: 6,
                        overflow: 'auto',
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {result.content}
                    </pre>
                  </>
                )}
              </div>
            ),
          },
        ]}
      />
    </div>
  )
}

export function ErrorMessage({ content }: { content: string }) {
  return (
    <div style={{ margin: '10px 42px' }}>
      <Card size="small" style={{ borderColor: '#FFCCC7', background: '#FFF2F0' }}>
        <span style={{ color: '#A8071A' }}>⚠️ {content}</span>
      </Card>
    </div>
  )
}

interface ReviewProgressStyle {
  icon: React.ReactNode
  borderColor: string
  background: string
  textColor: string
}

const REVIEW_PROGRESS_STYLES: Record<string, ReviewProgressStyle> = {
  review_started: {
    icon: <SafetyCertificateOutlined />,
    borderColor: '#91CAFF',
    background: '#E6F4FF',
    textColor: '#0958D9',
  },
  structure_failed: {
    icon: <ExclamationCircleOutlined />,
    borderColor: '#FFCCC7',
    background: '#FFF2F0',
    textColor: '#A8071A',
  },
  round_done: {
    icon: <WarningOutlined />,
    borderColor: '#FFE58F',
    background: '#FFFBE6',
    textColor: '#AD6800',
  },
  repair_started: {
    icon: <ToolFilled />,
    borderColor: '#ADC6FF',
    background: '#F0F5FF',
    textColor: '#2F54EB',
  },
  repair_done: {
    icon: <ThunderboltOutlined />,
    borderColor: '#B7EB8F',
    background: '#F6FFED',
    textColor: '#389E0D',
  },
  review_finalized: {
    icon: <CheckCircleOutlined />,
    borderColor: '#B7EB8F',
    background: '#F6FFED',
    textColor: '#389E0D',
  },
  review_error: {
    icon: <ExclamationCircleOutlined />,
    borderColor: '#FFCCC7',
    background: '#FFF2F0',
    textColor: '#A8071A',
  },
}

export function ReviewProgressBubble({ msg, active }: { msg: PrdChatMessage; active?: boolean }) {
  const meta = msg.metadata ?? {}
  const stage = String(meta.stage ?? '')
  const prdId = Number(meta.prdId ?? 0)
  const payload = (meta.payload ?? {}) as Record<string, unknown>

  let style = REVIEW_PROGRESS_STYLES[stage] ?? REVIEW_PROGRESS_STYLES.review_started
  if (stage === 'review_finalized') {
    const finalStatus = String(payload.finalStatus ?? '')
    if (finalStatus !== 'draft') {
      style = REVIEW_PROGRESS_STYLES.structure_failed
    }
  }

  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active) return
    const startedAt = Date.parse(msg.createdAt)
    if (Number.isNaN(startedAt)) return
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [active, msg.createdAt])

  const elapsedText = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`

  return (
    <div style={{ margin: '10px 42px' }}>
      <Card
        size="small"
        style={{
          borderColor: style.borderColor,
          background: style.background,
        }}
      >
        <Space size={10} align="start">
          <span style={{ color: style.textColor, fontSize: 16, lineHeight: '22px' }}>
            {style.icon}
          </span>
          <div style={{ color: style.textColor, fontSize: 13, lineHeight: 1.6 }}>
            {msg.content}
            {prdId > 0 && (
              <>
                {' '}
                <Link
                  to={`/prd-documents?prdId=${prdId}`}
                  style={{ color: style.textColor, textDecoration: 'underline' }}
                >
                  查看详情
                </Link>
              </>
            )}
            {active && (
              <div
                style={{
                  marginTop: 6,
                  fontSize: 12,
                  color: style.textColor,
                  opacity: 0.85,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Spin size="small" />
                <span>Agent 正在处理本阶段… 已用时 {elapsedText}</span>
              </div>
            )}
          </div>
        </Space>
      </Card>
    </div>
  )
}

interface Props {
  messages: ChatListItem[]
  emptyHint?: string
}

export function ChatMessageList({ messages, emptyHint }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, autoScroll])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(nearBottom)
  }

  // Group tool_result into its matching tool_use for paired display
  const grouped: Array<{ item: ChatListItem; resultFor?: PrdChatMessage }> = []
  const skip = new Set<number>()
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isStreaming(m) && m.role === 'tool_result') continue
    if (!isStreaming(m) && m.role === 'tool_use') {
      const match = messages.find(
        (x) =>
          !isStreaming(x) &&
          x.role === 'tool_result' &&
          (x as PrdChatMessage).toolUseId &&
          (x as PrdChatMessage).toolUseId === m.toolUseId &&
          !skip.has(x.id as number)
      ) as PrdChatMessage | undefined
      if (match) skip.add(match.id as number)
      grouped.push({ item: m, resultFor: match })
      continue
    }
    grouped.push({ item: m })
  }

  // 找出"活跃"的 review_progress：最新的一条，且尚未到终态（review_finalized / review_error）。
  // 该条会显示 spinner + 已用时，用来告诉用户 agent 当前正在这个阶段工作。
  let activeReviewId: number | string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isStreaming(m)) continue
    if (m.role !== 'assistant') continue
    if (m.metadata?.kind !== 'review_progress') continue
    const stage = String(m.metadata?.stage ?? '')
    if (stage === 'review_finalized' || stage === 'review_error') break
    activeReviewId = m.id
    break
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px 24px 24px',
        background: '#FFFFFF',
        position: 'relative',
      }}
    >
      <style>{`@keyframes chatops-blink { 50% { opacity: 0; } }`}</style>
      {grouped.length === 0 && emptyHint && (
        <div
          style={{
            color: '#8C97A7',
            textAlign: 'center',
            marginTop: 80,
            fontSize: 13,
          }}
        >
          {emptyHint}
        </div>
      )}
      {grouped.map(({ item, resultFor }) => {
        if (isStreaming(item)) {
          return (
            <AssistantMessage key={item.id} content={item.content} streaming />
          )
        }
        if (item.role === 'user') {
          return <UserMessage key={item.id} content={item.content} />
        }
        if (item.role === 'assistant') {
          if (item.metadata?.kind === 'review_progress') {
            return <ReviewProgressBubble key={item.id} msg={item} active={item.id === activeReviewId} />
          }
          return <AssistantMessage key={item.id} content={item.content} />
        }
        if (item.role === 'tool_use') {
          return <ToolCallBubble key={item.id} msg={item} result={resultFor} />
        }
        if (item.role === 'error') {
          return <ErrorMessage key={item.id} content={item.content} />
        }
        return null
      })}
      {!autoScroll && (
        <Tooltip title="滚动到底部">
          <Button
            shape="circle"
            icon={<ArrowDownOutlined />}
            onClick={() => {
              const el = scrollRef.current
              if (el) {
                el.scrollTop = el.scrollHeight
                setAutoScroll(true)
              }
            }}
            style={{ position: 'sticky', bottom: 8, left: '100%', marginRight: 4 }}
          />
        </Tooltip>
      )}
    </div>
  )
}

interface InputProps {
  sending: boolean
  onSend: (text: string) => void
  placeholder?: string
}

export function ChatInput({ sending, onSend, placeholder }: InputProps) {
  const [text, setText] = useState('')
  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }
  return (
    <div
      style={{
        borderTop: '1px solid #EEF0F4',
        padding: 14,
        background: '#FAFBFC',
        display: 'flex',
        gap: 10,
        alignItems: 'flex-end',
      }}
    >
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder ?? '说说你的需求...(Enter 发送,Shift+Enter 换行)'}
        autoSize={{ minRows: 1, maxRows: 6 }}
        disabled={sending}
        onPressEnter={(e) => {
          if (!e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        style={{ flex: 1 }}
      />
      <Button
        type="primary"
        icon={<SendOutlined />}
        loading={sending}
        disabled={!text.trim()}
        onClick={submit}
      >
        发送
      </Button>
    </div>
  )
}
