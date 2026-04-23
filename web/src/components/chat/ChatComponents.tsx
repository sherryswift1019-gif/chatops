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

function displayToolName(toolName: string | null): string {
  if (!toolName) return '未知工具'
  // 去掉 MCP 前缀：mcp__<server>__<tool> → <tool>
  const m = toolName.match(/^mcp__[^_]+(?:__[^_]+)*?__(.+)$/)
  return m ? m[1] : toolName
}

function truncate(s: string, n = 60): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

function summarizeToolCall(toolName: string | null, input: unknown): string {
  if (!toolName || !input || typeof input !== 'object') return ''
  const arg = input as Record<string, unknown>
  const bare = displayToolName(toolName)

  const shortPath = (p: unknown): string => {
    const s = typeof p === 'string' ? p : ''
    if (!s) return ''
    const parts = s.split('/')
    return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : s
  }

  switch (bare) {
    case 'Read': {
      const fp = shortPath(arg.file_path)
      return fp ? `读取 ${fp}` : '读取文件'
    }
    case 'Write': {
      const fp = shortPath(arg.file_path)
      return fp ? `写入 ${fp}` : '写入文件'
    }
    case 'Edit':
    case 'MultiEdit': {
      const fp = shortPath(arg.file_path)
      return fp ? `编辑 ${fp}` : '编辑文件'
    }
    case 'Bash': {
      const cmd = typeof arg.command === 'string' ? arg.command : ''
      const desc = typeof arg.description === 'string' ? arg.description : ''
      return desc ? desc : cmd ? `执行: ${truncate(cmd, 80)}` : '执行命令'
    }
    case 'Glob': {
      const pat = typeof arg.pattern === 'string' ? arg.pattern : ''
      return pat ? `查找文件: ${pat}` : '查找文件'
    }
    case 'Grep': {
      const pat = typeof arg.pattern === 'string' ? arg.pattern : ''
      return pat ? `搜索: ${truncate(pat, 60)}` : '搜索内容'
    }
    case 'TodoWrite': {
      const todos = Array.isArray(arg.todos) ? arg.todos : []
      return `更新任务清单（${todos.length} 项）`
    }
    case 'WebFetch': {
      const url = typeof arg.url === 'string' ? arg.url : ''
      return url ? `抓取网页: ${truncate(url, 60)}` : '抓取网页'
    }
    case 'WebSearch': {
      const q = typeof arg.query === 'string' ? arg.query : ''
      return q ? `搜索: ${truncate(q, 60)}` : '联网搜索'
    }
    case 'Task': {
      const desc = typeof arg.description === 'string' ? arg.description : ''
      return desc ? `子任务: ${truncate(desc, 60)}` : '启动子任务'
    }
    case 'read_prd': {
      const id = arg.prdId ?? arg.prd_id
      return id != null ? `读取 PRD #${id}` : '读取 PRD'
    }
    case 'save_prd': {
      const id = arg.prdId ?? arg.prd_id
      const title = typeof arg.title === 'string' ? arg.title : ''
      if (id != null && title) return `保存 PRD #${id}「${truncate(title, 20)}」`
      if (id != null) return `保存 PRD #${id}`
      if (title) return `保存 PRD「${truncate(title, 20)}」`
      return '保存 PRD'
    }
    case 'search_existing_prds': {
      const kw = typeof arg.keyword === 'string' ? arg.keyword : (typeof arg.query === 'string' ? arg.query : '')
      return kw ? `搜索 PRD: ${truncate(kw, 40)}` : '搜索已有 PRD'
    }
    case 'search_knowledge': {
      const q = typeof arg.query === 'string' ? arg.query : ''
      return q ? `检索知识库: ${truncate(q, 40)}` : '检索知识库'
    }
    case 'update_prd_context': {
      return '更新 PRD 上下文'
    }
    default:
      return ''
  }
}

export function ToolCallBubble({
  msg,
  result,
  completed,
}: {
  msg: PrdChatMessage
  result?: PrdChatMessage
  completed?: boolean
}) {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(msg.content)
  } catch {
    parsed = msg.content
  }
  const summary = summarizeToolCall(msg.toolName, parsed)
  // Porygon 的 Claude 适配器不映射 user 事件里的 tool_result 块，所以 result 几乎永远为空。
  // 改用"后续是否已有其他持久化消息 / 流式是否结束"作为完成信号。
  const isDone = Boolean(result) || Boolean(completed)
  const header = (
    <Space size={8} wrap style={{ rowGap: 2 }}>
      <ToolOutlined style={{ color: '#6F42C1' }} />
      <span style={{ fontWeight: 500 }}>{displayToolName(msg.toolName)}</span>
      {summary && (
        <span style={{ color: '#5C6578', fontSize: 12.5 }}>{summary}</span>
      )}
      <Tag color={isDone ? 'green' : 'processing'}>{isDone ? '已完成' : '调用中'}</Tag>
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
  salvaged: {
    icon: <WarningOutlined />,
    borderColor: '#FFD591',
    background: '#FFF7E6',
    textColor: '#D46B08',
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

  // Group tool_result into its matching tool_use for paired display.
  //
  // 完成态判定：Porygon 0.10 的 Claude 适配器不处理 CLI 发回的 `user` 事件，
  // 而 Claude 的 tool_result 块正好封装在 user 事件里，所以后端永远拿不到工具输出、
  // DB 里也不存在 role='tool_result' 的行。原来仅靠 resultFor 匹配判完成，会让所有
  // tool_use 永远停在"调用中"。这里用 UI 层能看到的信号补一条：
  //   - 后面已经出现过其它持久化消息（Claude 已经在干下一件事），或
  //   - 整段流式已结束（loading 占位消失），
  // 就视为该 tool 已完成。tool_result 若哪天能真拿到，仍会优先用它（还能展示 Output）。
  let lastPersistedIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!isStreaming(messages[i])) {
      lastPersistedIdx = i
      break
    }
  }
  const hasStreamingPlaceholder = messages.some(isStreaming)

  const grouped: Array<{ item: ChatListItem; resultFor?: PrdChatMessage; completed?: boolean }> = []
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
      const completed = Boolean(match) || i < lastPersistedIdx || !hasStreamingPlaceholder
      grouped.push({ item: m, resultFor: match, completed })
      continue
    }
    grouped.push({ item: m })
  }

  // 找出"活跃"的 review_progress：最新的一条，且尚未到终态（review_finalized / review_error）。
  // 该条会显示 spinner + 已用时，用来告诉用户 agent 当前正在这个阶段工作。
  //
  // 超时保险丝：review 链路的 SSE 事件如果因为客户端断连没落盘（见 prd-chat.ts 的
  // clientClosed 处理），历史加载回来就只剩一条 review_started，导致 spinner 永远转。
  // runPrdReview 的最大时长受 MAX_REPAIR_ROUNDS(2) × MCP maxTurns(30) 限制，实际极少
  // 超过 20 分钟。所以超过 REVIEW_ACTIVE_TIMEOUT_MS 还没到终态事件，直接视为已结束。
  const REVIEW_ACTIVE_TIMEOUT_MS = 20 * 60 * 1000
  let activeReviewId: number | string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (isStreaming(m)) continue
    if (m.role !== 'assistant') continue
    if (m.metadata?.kind !== 'review_progress') continue
    const stage = String(m.metadata?.stage ?? '')
    if (stage === 'review_finalized' || stage === 'review_error') break
    const startedAt = Date.parse((m as PrdChatMessage).createdAt)
    if (Number.isFinite(startedAt) && Date.now() - startedAt > REVIEW_ACTIVE_TIMEOUT_MS) break
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
      {grouped.map(({ item, resultFor, completed }) => {
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
          return <ToolCallBubble key={item.id} msg={item} result={resultFor} completed={completed} />
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
