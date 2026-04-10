import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EscalationTimer } from '../../approval/escalation.js'

describe('EscalationTimer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('calls onPrimaryTimeout after primary timeout', async () => {
    const onPrimary = vi.fn()
    const onTotal = vi.fn()

    const timer = new EscalationTimer({
      primaryTimeoutMs: 5000,
      totalTimeoutMs: 10000,
      onPrimaryTimeout: onPrimary,
      onTotalTimeout: onTotal,
    })
    timer.start()

    vi.advanceTimersByTime(5001)
    expect(onPrimary).toHaveBeenCalledOnce()
    expect(onTotal).not.toHaveBeenCalled()

    vi.advanceTimersByTime(5001)
    expect(onTotal).toHaveBeenCalledOnce()

    timer.cancel()
  })

  it('cancels both timers when cancel() is called', () => {
    const onPrimary = vi.fn()
    const onTotal = vi.fn()

    const timer = new EscalationTimer({
      primaryTimeoutMs: 5000,
      totalTimeoutMs: 10000,
      onPrimaryTimeout: onPrimary,
      onTotalTimeout: onTotal,
    })
    timer.start()
    timer.cancel()

    vi.advanceTimersByTime(15000)
    expect(onPrimary).not.toHaveBeenCalled()
    expect(onTotal).not.toHaveBeenCalled()
  })
})
