import { useEffect, useState, useRef, useCallback } from 'react'

interface Options {
  /** 是否启用轮询（false 时仅 mount 触发一次 fetch） */
  active: boolean
  /** 轮询间隔（ms），默认 5000 */
  intervalMs?: number
  /** tab visibility hidden 时是否暂停轮询，默认 true */
  pauseOnHidden?: boolean
}

export interface UsePollingResult<T> {
  data: T | null
  lastFetchedAt: Date | null
  loading: boolean
  error: unknown
  refetch: () => Promise<T | null>
}

/**
 * 智能轮询：mount 立即拉一次，active 时按 intervalMs 周期拉，tab 切走时暂停。
 * 决策 Modal 等场景调用方传 active=false 即可暂停。
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  options: Options,
): UsePollingResult<T> {
  const { active, intervalMs = 5000, pauseOnHidden = true } = options
  const [data, setData] = useState<T | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const refetch = useCallback(async (): Promise<T | null> => {
    setLoading(true)
    try {
      const result = await fetcherRef.current()
      setData(result)
      setLastFetchedAt(new Date())
      setError(null)
      return result
    } catch (e) {
      setError(e)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  // mount 立即拉一次
  useEffect(() => {
    void refetch()
  }, [refetch])

  // 轮询调度（依赖 active）
  useEffect(() => {
    if (!active) return

    const isHidden = () =>
      pauseOnHidden && typeof document !== 'undefined' && document.visibilityState === 'hidden'

    const tick = async () => {
      if (!isHidden()) {
        await refetch()
      }
      timerRef.current = setTimeout(tick, intervalMs)
    }

    timerRef.current = setTimeout(tick, intervalMs)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [active, intervalMs, pauseOnHidden, refetch])

  // visibility 变化：从 hidden 回到 visible 立即拉一次
  useEffect(() => {
    if (!pauseOnHidden || typeof document === 'undefined') return
    const handler = () => {
      if (document.visibilityState === 'visible' && active) {
        void refetch()
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [active, pauseOnHidden, refetch])

  return { data, lastFetchedAt, loading, error, refetch }
}
