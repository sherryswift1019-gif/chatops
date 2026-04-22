import { useCallback, useEffect, useRef, useState } from 'react'
import { buildPrdChatStreamUrl, listPrdChatMessages, getPrdChatSession } from '../api/prd-chat'
import type { PrdChatMessage, PrdChatSession } from '../types'

export interface StreamingAssistant {
  id: string
  role: 'assistant'
  content: string
  createdAt: string
  streaming: true
}

export type ChatListItem = PrdChatMessage | StreamingAssistant

interface State {
  session: PrdChatSession | null
  messages: ChatListItem[]
  sending: boolean
  error: string | null
}

export function usePrdChatStream(sessionKey: string) {
  const [state, setState] = useState<State>({
    session: null,
    messages: [],
    sending: false,
    error: null,
  })

  const esRef = useRef<EventSource | null>(null)
  const streamingIdRef = useRef<string | null>(null)

  const refreshSession = useCallback(async () => {
    try {
      const s = await getPrdChatSession(sessionKey)
      setState((prev) => ({ ...prev, session: s }))
      return s
    } catch (err) {
      setState((prev) => ({ ...prev, error: String(err) }))
      return null
    }
  }, [sessionKey])

  const loadHistory = useCallback(async () => {
    try {
      const [s, rows] = await Promise.all([
        getPrdChatSession(sessionKey),
        listPrdChatMessages(sessionKey),
      ])
      setState({ session: s, messages: rows, sending: false, error: null })
    } catch (err) {
      setState((prev) => ({ ...prev, error: String(err) }))
    }
  }, [sessionKey])

  useEffect(() => {
    loadHistory()
    return () => {
      esRef.current?.close()
      esRef.current = null
    }
  }, [loadHistory])

  const send = useCallback(
    (text: string) => {
      if (!text.trim()) return
      if (state.sending) return

      // 本地立刻追加 user 消息（SSE 返回后替换成真实 id）
      const tempUserId = `tmp-user-${Date.now()}`
      const tempStreamingId = `streaming-${Date.now()}`
      streamingIdRef.current = tempStreamingId

      setState((prev) => ({
        ...prev,
        sending: true,
        error: null,
        messages: [
          ...prev.messages,
          {
            id: Number.NEGATIVE_INFINITY,
            sessionKey,
            role: 'user',
            content: text,
            toolName: null,
            toolUseId: null,
            metadata: { tempId: tempUserId },
            createdAt: new Date().toISOString(),
          },
          {
            id: tempStreamingId,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
            streaming: true,
          },
        ],
      }))

      const url = buildPrdChatStreamUrl(sessionKey, text)
      const es = new EventSource(url, { withCredentials: true } as EventSourceInit)
      esRef.current = es

      const appendToStreaming = (chunk: string) => {
        setState((prev) => ({
          ...prev,
          messages: prev.messages.map((m) => {
            if ((m as StreamingAssistant).streaming && m.id === tempStreamingId) {
              return { ...m, content: (m as StreamingAssistant).content + chunk } as StreamingAssistant
            }
            return m
          }),
        }))
      }

      const dropStreaming = () => {
        setState((prev) => ({
          ...prev,
          messages: prev.messages.filter(
            (m) => !((m as StreamingAssistant).streaming && m.id === tempStreamingId)
          ),
        }))
      }

      const insertPersistedMessage = (msg: PrdChatMessage) => {
        setState((prev) => ({
          ...prev,
          messages: (() => {
            // 如果是 user 消息且有同 tempId 的占位 → 替换；否则插入
            if (msg.role === 'user') {
              const idx = prev.messages.findIndex(
                (m) =>
                  m.role === 'user' &&
                  (m as PrdChatMessage).id === Number.NEGATIVE_INFINITY
              )
              if (idx >= 0) {
                const next = [...prev.messages]
                next[idx] = msg
                return next
              }
            }
            // 在 streaming 占位之前插入
            const streamIdx = prev.messages.findIndex(
              (m) => (m as StreamingAssistant).streaming
            )
            if (streamIdx >= 0) {
              const next = [...prev.messages]
              next.splice(streamIdx, 0, msg)
              return next
            }
            return [...prev.messages, msg]
          })(),
        }))
      }

      es.addEventListener('user_msg', (e: MessageEvent) => {
        const data = JSON.parse(e.data) as PrdChatMessage
        insertPersistedMessage(data)
      })

      es.addEventListener('stream_chunk', (e: MessageEvent) => {
        const data = JSON.parse(e.data) as { text: string }
        appendToStreaming(data.text)
      })

      es.addEventListener('assistant_done', () => {
        // 整段 assistant 已 flush 到 DB；但后端不立刻回 id，用 done 里刷历史覆盖
      })

      es.addEventListener('tool_use', (e: MessageEvent) => {
        const data = JSON.parse(e.data) as PrdChatMessage
        insertPersistedMessage(data)
      })

      es.addEventListener('tool_result', (e: MessageEvent) => {
        const data = JSON.parse(e.data) as PrdChatMessage
        insertPersistedMessage(data)
      })

      es.addEventListener('review_progress', (e: MessageEvent) => {
        const data = JSON.parse(e.data) as PrdChatMessage
        insertPersistedMessage(data)
        // 若 review_finalized → 刷新 session 以更新 prdId 状态关联
        const stage = String(data.metadata?.stage ?? '')
        if (stage === 'review_finalized') {
          void refreshSession()
        }
      })

      es.addEventListener('error_msg', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data) as Partial<PrdChatMessage> & { content?: string }
          if (data.id) {
            insertPersistedMessage(data as PrdChatMessage)
          } else {
            setState((prev) => ({ ...prev, error: data.content ?? 'unknown error' }))
          }
        } catch {
          setState((prev) => ({ ...prev, error: 'stream error' }))
        }
      })

      es.addEventListener('prd_linked', async (e: MessageEvent) => {
        const data = JSON.parse(e.data) as { prdId: number }
        const s = await getPrdChatSession(sessionKey).catch(() => null)
        setState((prev) => ({
          ...prev,
          session: s ?? (prev.session ? { ...prev.session, prdId: data.prdId } : null),
        }))
      })

      es.addEventListener('done', async () => {
        es.close()
        esRef.current = null
        dropStreaming()
        // 刷历史，拿到持久化后的真实 id
        try {
          const rows = await listPrdChatMessages(sessionKey)
          setState((prev) => ({ ...prev, messages: rows, sending: false }))
        } catch {
          setState((prev) => ({ ...prev, sending: false }))
        }
      })

      es.onerror = () => {
        es.close()
        esRef.current = null
        setState((prev) => ({
          ...prev,
          sending: false,
          error: prev.error ?? '连接断开',
        }))
      }
    },
    [sessionKey, state.sending, refreshSession]
  )

  return { ...state, send, refreshSession, loadHistory }
}
