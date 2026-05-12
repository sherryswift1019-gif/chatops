// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePolling } from './usePolling'

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // 注：mount 后立即 fetch 一次（微任务），后续 5s 周期由 setTimeout 调度。
  // 用 advanceTimersByTimeAsync(0) 只 flush 微任务、不触发 pending 5s 计时器，
  // 避免 runOnlyPendingTimersAsync 把刚排上的 polling tick 一起跑掉。
  it('fetches once on mount', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    renderHook(() => usePolling(fetcher, { active: true, intervalMs: 5000 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('polls every intervalMs when active', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    renderHook(() => usePolling(fetcher, { active: true, intervalMs: 5000 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('does not poll when active=false', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    renderHook(() => usePolling(fetcher, { active: false, intervalMs: 5000 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refetches when refetch() is called', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    const { result } = renderHook(() => usePolling(fetcher, { active: false, intervalMs: 5000 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.refetch() })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('tracks lastFetchedAt', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    const { result } = renderHook(() => usePolling(fetcher, { active: true, intervalMs: 5000 }))
    expect(result.current.lastFetchedAt).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.lastFetchedAt).toBeInstanceOf(Date)
  })
})
