import { useEffect, useRef, useState, useCallback } from 'react'
import { getBrainstormState, type BrainstormState } from '../../api/brainstorm'

const POLL_NORMAL_MS = 5000
const POLL_FAST_MS = 1500

/**
 * Brainstorm state polling hook.
 *   - 默认 5s 间隔
 *   - submitted=true 时 fast-poll 1.5s × 10 次（最多 15s 等 LLM 出下一轮），收完 reset
 *   - active 非空时也用快轮询（用户可能马上提交）
 */
export function useBrainstormState(requirementId: number, enabled: boolean = true) {
  const [state, setState] = useState<BrainstormState | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fastPollUntil, setFastPollUntil] = useState<number>(0)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const mountedRef = useRef(true)

  const fetchOnce = useCallback(async () => {
    if (!enabled || !Number.isFinite(requirementId) || requirementId <= 0) return
    setLoading(true)
    try {
      const data = await getBrainstormState(requirementId)
      if (mountedRef.current) {
        setState(data)
        setError(null)
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'fetch_failed')
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [requirementId, enabled])

  useEffect(() => {
    mountedRef.current = true
    if (!enabled) return
    void fetchOnce()
    const tick = () => {
      const isFast = Date.now() < fastPollUntil
      const interval = isFast ? POLL_FAST_MS : POLL_NORMAL_MS
      timerRef.current = setTimeout(async () => {
        await fetchOnce()
        if (mountedRef.current) tick()
      }, interval)
    }
    tick()
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [fetchOnce, enabled, fastPollUntil])

  const triggerFastPoll = useCallback((durationMs: number = 20000) => {
    setFastPollUntil(Date.now() + durationMs)
  }, [])

  return { state, loading, error, refetch: fetchOnce, triggerFastPoll }
}
