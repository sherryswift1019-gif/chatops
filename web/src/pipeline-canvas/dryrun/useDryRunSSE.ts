import { useState, useCallback } from 'react'

export type DryRunPhase = 'idle' | 'running' | 'awaiting-decision' | 'awaiting-external' | 'done' | 'error'

export interface DryRunChunk {
  type: 'started' | 'progress' | 'snapshot' | 'decision-needed' | 'waiting-external' | 'stale-warning' | 'error' | 'done'
  sessionId?: string
  nodeId?: string
  [k: string]: unknown
}

export interface DryRunState {
  phase: DryRunPhase
  sessionId: string | null
  pendingDecision: DryRunChunk | null  // type='decision-needed' chunk
  pendingExternal: DryRunChunk | null  // type='waiting-external' chunk
  progressByNode: Record<string, 'running' | 'success' | 'failed' | 'skipped'>
  staleNodeIds: string[]
  error: string | null
}

const initialState: DryRunState = {
  phase: 'idle', sessionId: null, pendingDecision: null,
  pendingExternal: null, progressByNode: {}, staleNodeIds: [], error: null,
}

export function useDryRunSSE() {
  const [state, setState] = useState<DryRunState>(initialState)

  const start = useCallback((opts: {
    pipelineId: number
    targetNodeId: string
    graphHash: string
    triggerParams: Record<string, unknown>
    triggerType: string
    triggeredBy: string
  }) => {
    setState({ ...initialState, phase: 'running' })

    // SSE POST body 用 fetch ReadableStream（EventSource 不支持 POST）
    fetch(`/admin/test-pipelines/${opts.pipelineId}/dry-run/run-to/${opts.targetNodeId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        graphHash: opts.graphHash,
        triggerParams: opts.triggerParams,
        triggerType: opts.triggerType,
        triggeredBy: opts.triggeredBy,
      }),
    }).then(async (resp) => {
      if (!resp.ok || !resp.body) throw new Error(`SSE ${resp.status}`)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() ?? ''
        for (const ev of events) handleEvent(ev)
      }
    }).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      setState(s => ({ ...s, phase: 'error', error: msg }))
    })

    function handleEvent(rawEvent: string) {
      const lines = rawEvent.split('\n')
      let type = 'message', dataStr = ''
      for (const l of lines) {
        if (l.startsWith('event:')) type = l.slice(6).trim()
        else if (l.startsWith('data:')) dataStr += l.slice(5).trim()
      }
      let chunk: DryRunChunk
      try { chunk = { ...JSON.parse(dataStr), type: type as DryRunChunk['type'] } }
      catch { return }
      reduceChunk(chunk)
    }

    function reduceChunk(chunk: DryRunChunk) {
      setState(s => {
        switch (chunk.type) {
          case 'started':
            return { ...s, sessionId: chunk.sessionId as string, phase: 'running' }
          case 'progress':
            if (!chunk.nodeId) return s
            return {
              ...s, phase: 'running',
              progressByNode: { ...s.progressByNode, [chunk.nodeId as string]: 'running' as const },
            }
          case 'snapshot':
            if (!chunk.nodeId) return s
            return {
              ...s,
              progressByNode: { ...s.progressByNode, [chunk.nodeId as string]: chunk.status as 'success' | 'failed' | 'skipped' },
            }
          case 'decision-needed':
            return { ...s, phase: 'awaiting-decision', pendingDecision: chunk }
          case 'waiting-external':
            return { ...s, phase: 'awaiting-external', pendingExternal: chunk }
          case 'stale-warning':
            return { ...s, staleNodeIds: chunk.staleNodeIds as string[] }
          case 'error':
            return { ...s, phase: 'error', error: chunk.error as string }
          case 'done':
            return { ...s, phase: 'done', pendingDecision: null, pendingExternal: null }
          default:
            return s
        }
      })
    }
  }, [])

  const submitDecision = useCallback((
    pipelineId: number, sessionId: string,
    body: { nodeId: string; decision: 'real' | 'stub' | 'manual'; manualOutput?: Record<string, unknown>; remember?: boolean },
  ) => {
    return fetch(`/admin/test-pipelines/${pipelineId}/dry-run/sessions/${sessionId}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(() => {
      // 决策提交后状态机回到 running，等下一个 chunk
      setState(s => ({ ...s, phase: 'running', pendingDecision: null }))
    })
  }, [])

  const reset = useCallback(() => setState(initialState), [])

  return { state, start, submitDecision, reset }
}
