import { useEffect, useRef, useState } from 'react'

export type StageLogStatus = 'connecting' | 'waiting' | 'streaming' | 'done' | 'error'
export type StageLogFileType = 'script' | 'capability' | null

interface HelloEvent {
  runId: number
  stageIndex: number
  fileType: StageLogFileType
  filePath: string | null
}

interface SnapshotEvent {
  content: string
  fileType: StageLogFileType
  size: number
}

interface AppendEvent {
  content: string
  size: number
}

interface DoneEvent {
  status: 'success' | 'failed' | 'skipped' | string
}

export interface UseStageLogStreamReturn {
  content: string
  status: StageLogStatus
  fileType: StageLogFileType
  errorMsg: string
  finalStatus: string | null
}

/**
 * SSE-driven stage log subscriber.
 *
 * Backend endpoint: GET /admin/test-runs/:runId/stage/:stageIndex/log/stream
 * Events: hello → snapshot → append* → done|error
 *
 * 错误恢复策略（按用户决策）：onerror 直接 setStatus('error') + es.close()，
 * 不做无限重连——浏览器 EventSource 没有暴露 reconnect attempts 上限给 onerror，
 * 用户 session 过期会无限重试，刷新页面是更可靠的兜底。
 */
export function useStageLogStream(
  runId: number | null,
  stageIndex: number | null,
  enabled: boolean,
): UseStageLogStreamReturn {
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<StageLogStatus>('connecting')
  const [fileType, setFileType] = useState<StageLogFileType>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [finalStatus, setFinalStatus] = useState<string | null>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    if (!enabled || runId === null || stageIndex === null) {
      esRef.current?.close()
      esRef.current = null
      return
    }

    setContent('')
    setStatus('connecting')
    setFileType(null)
    setErrorMsg('')
    setFinalStatus(null)

    const url = `/admin/test-runs/${runId}/stage/${stageIndex}/log/stream`
    const es = new EventSource(url, { withCredentials: true } as EventSourceInit)
    esRef.current = es

    es.addEventListener('hello', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as HelloEvent
        setFileType(data.fileType)
        setStatus(data.fileType ? 'streaming' : 'waiting')
      } catch { /* ignore malformed */ }
    })

    es.addEventListener('snapshot', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as SnapshotEvent
        setContent(data.content)
        setFileType(data.fileType)
        setStatus('streaming')
      } catch { /* ignore */ }
    })

    es.addEventListener('append', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as AppendEvent
        setContent((prev) => prev + data.content)
      } catch { /* ignore */ }
    })

    es.addEventListener('done', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as DoneEvent
        setFinalStatus(data.status)
      } catch { /* ignore */ }
      setStatus('done')
      es.close()
      esRef.current = null
    })

    es.addEventListener('error', (ev) => {
      // SSE 'error' event → 服务端主动发的语义错误（带 data）；浏览器底层错误
      // 走 es.onerror（无 data）。两路都终止流。
      try {
        const data = JSON.parse((ev as MessageEvent).data ?? '{}') as { error?: string }
        if (data.error) setErrorMsg(data.error)
      } catch { /* native error event has no data */ }
    })

    es.onerror = () => {
      // 用户 session 过期 / 网络抖动 → 浏览器自带重连，但我们立即停止
      // 让 UI 显示 error，让用户刷新页面重连。
      setStatus('error')
      if (!errorMsg) setErrorMsg('connection lost')
      es.close()
      esRef.current = null
    }

    return () => {
      es.close()
      esRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, stageIndex, enabled])

  return { content, status, fileType, errorMsg, finalStatus }
}
