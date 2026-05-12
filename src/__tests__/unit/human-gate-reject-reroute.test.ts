import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock retryFromNode in graph-runner.ts (dynamic import to avoid mock timing issues)
vi.mock('../../pipeline/graph-runner.js', () => ({
  retryFromNode: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../db/repositories/requirements.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/requirements.js')>()
  return {
    ...actual,
    getRejectCount: vi.fn(),
    incrementRejectCount: vi.fn(),
    setRequirementStatus: vi.fn().mockResolvedValue(undefined),
  }
})

import { retryFromNode } from '../../pipeline/graph-runner.js'
import { getRejectCount, incrementRejectCount } from '../../db/repositories/requirements.js'
import { handleHumanGateRejection } from '../../pipeline/graph-builder.js'

describe('handleHumanGateRejection (extracted helper)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reject 未达 cap → 触发 retryFromNode + 累加 + return shouldReroute=true', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(0)
    vi.mocked(incrementRejectCount).mockResolvedValue({ newCount: 1 })

    const result = await handleHumanGateRejection({
      runId: 100,
      requirementId: 7,
      humanGateNodeId: 'spec_human_gate',
      retryToOnReject: 'spec_author',
      rejectReason: 'AC 不够具体',
    })

    expect(result.shouldReroute).toBe(true)
    expect(result.newCount).toBe(1)
    expect(getRejectCount).toHaveBeenCalledWith(7, 'spec_human_gate')
    expect(incrementRejectCount).toHaveBeenCalledWith({
      requirementId: 7,
      humanGateNodeId: 'spec_human_gate',
      authorNodeId: 'spec_author',
      rejectReason: 'AC 不够具体',
    })
    // retryFromNode scheduled via setTimeout(100ms) — wait for it to fire
    await new Promise(r => setTimeout(r, 150))
    expect(retryFromNode).toHaveBeenCalledWith(100, 'spec_author')
  })

  it('reject 已达 cap=3 → 不调 retryFromNode + 不累加 + shouldReroute=false', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(3)

    const result = await handleHumanGateRejection({
      runId: 100,
      requirementId: 7,
      humanGateNodeId: 'spec_human_gate',
      retryToOnReject: 'spec_author',
      rejectReason: '4th try',
    })

    expect(result.shouldReroute).toBe(false)
    expect(result.newCount).toBe(3)
    expect(incrementRejectCount).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 150))
    expect(retryFromNode).not.toHaveBeenCalled()
  })

  it('reject 未配 retryToOnReject → shouldReroute=false（不调 retry，不查 count）', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(0)

    const result = await handleHumanGateRejection({
      runId: 100,
      requirementId: 7,
      humanGateNodeId: 'final_approval',
      retryToOnReject: null,
      rejectReason: 'final reject',
    })

    expect(result.shouldReroute).toBe(false)
    expect(result.newCount).toBeNull()
    expect(getRejectCount).not.toHaveBeenCalled()
    expect(incrementRejectCount).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 150))
    expect(retryFromNode).not.toHaveBeenCalled()
  })

  it('cap 边界：count=2 时 reject 可执行（< 3）', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(2)
    vi.mocked(incrementRejectCount).mockResolvedValue({ newCount: 3 })

    const result = await handleHumanGateRejection({
      runId: 100,
      requirementId: 7,
      humanGateNodeId: 'spec_human_gate',
      retryToOnReject: 'spec_author',
      rejectReason: 'round 3 reject',
    })

    expect(result.shouldReroute).toBe(true)
    expect(result.newCount).toBe(3)
    // Drain pending setTimeout so it doesn't leak into the next test
    await new Promise(r => setTimeout(r, 150))
  })

  it('retryToOnReject="" → 视为无配置（不调 retry，不查 count）', async () => {
    const result = await handleHumanGateRejection({
      runId: 100,
      requirementId: 7,
      humanGateNodeId: 'spec_human_gate',
      retryToOnReject: '',
      rejectReason: 'x',
    })
    expect(result.shouldReroute).toBe(false)
    expect(result.newCount).toBeNull()
    expect(getRejectCount).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 150))
    expect(retryFromNode).not.toHaveBeenCalled()
  })
})

describe('computeWaiterRound (extracted helper)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('count=0 → round 1（首次进入 spec_human_gate）', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(0)
    const { computeWaiterRound } = await import('../../pipeline/graph-builder.js')
    expect(await computeWaiterRound(7, 'spec_human_gate')).toBe(1)
  })

  it('count=2 → round 3（已被 reject 2 次，下一轮是第 3 轮）', async () => {
    vi.mocked(getRejectCount).mockResolvedValue(2)
    const { computeWaiterRound } = await import('../../pipeline/graph-builder.js')
    expect(await computeWaiterRound(7, 'spec_human_gate')).toBe(3)
  })
})
