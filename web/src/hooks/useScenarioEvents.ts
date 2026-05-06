import { useEffect, useRef, useState } from 'react'

export type ScenarioEventType =
  | 'scenario_start'
  | 'tool_use'
  | 'assistant_text'
  | 'scenario_end'
  | 'fix_start'
  | 'fix_end'
  | 'agent_error'
  | 'closed'

export interface ScenarioEvent {
  type: ScenarioEventType
  ts: number
  // 其他字段按 type 分别存在；hook 不强类型化，让消费方按 type narrow
  [k: string]: unknown
}

export type ScenarioEventStatus = 'connecting' | 'live' | 'closed' | 'error'

export interface UseScenarioEventsReturn {
  events: ScenarioEvent[]
  status: ScenarioEventStatus
}

const MAX_EVENTS_KEPT = 500 // 保护 DOM 渲染规模

const SUBSCRIBED_EVENT_TYPES: ScenarioEventType[] = [
  'scenario_start',
  'tool_use',
  'assistant_text',
  'scenario_end',
  'fix_start',
  'fix_end',
  'agent_error',
]

/**
 * 订阅 e2e run 实时进度事件。
 *
 * Backend endpoint: GET /admin/e2e-runs/:runId/events
 * 同源 cookie 走 admin session（withCredentials=true）。
 *
 * - enabled=false 或 runId 缺失：关连接、不订阅
 * - 收到 'closed' 事件：主动 close + status='closed'，不再自动重连
 * - 网络/会话 error：同样 close + status='error'，让用户刷新页面恢复
 *   （EventSource 默认 5s 自动重连，断流后会形成无限重试，必须主动 close）
 *
 * heartbeat 不订阅、不进 events 数组（仅服务端保活用）。
 */
export function useScenarioEvents(
  runId: string | undefined,
  enabled: boolean,
): UseScenarioEventsReturn {
  const [events, setEvents] = useState<ScenarioEvent[]>([])
  const [status, setStatus] = useState<ScenarioEventStatus>('connecting')
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!runId || !enabled) {
      esRef.current?.close()
      esRef.current = null
      return
    }

    setEvents([])
    setStatus('connecting')

    const url = `/admin/e2e-runs/${runId}/events`
    const es = new EventSource(url, { withCredentials: true } as EventSourceInit)
    esRef.current = es

    const append = (type: ScenarioEventType) => (e: MessageEvent): void => {
      try {
        const payload = JSON.parse(e.data) as Record<string, unknown>
        setEvents((prev) => {
          const next = [...prev, { type, ...payload } as ScenarioEvent]
          // 保护 DOM：只留最近 N 条
          return next.length > MAX_EVENTS_KEPT
            ? next.slice(next.length - MAX_EVENTS_KEPT)
            : next
        })
      } catch {
        // ignore malformed payload
      }
      if (type === 'tool_use' || type === 'assistant_text') {
        setStatus('live')
      }
    }

    SUBSCRIBED_EVENT_TYPES.forEach((t) => es.addEventListener(t, append(t)))

    es.addEventListener('closed', () => {
      setStatus('closed')
      es.close()
      esRef.current = null
    })

    es.onerror = () => {
      setStatus('error')
      es.close()
      esRef.current = null
    }

    return () => {
      es.close()
      esRef.current = null
    }
  }, [runId, enabled])

  return { events, status }
}
