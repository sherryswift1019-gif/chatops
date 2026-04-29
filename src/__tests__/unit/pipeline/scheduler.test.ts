import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(() => ({ destroy: vi.fn() })),
    validate: vi.fn(() => true),
  },
}))
vi.mock('../../../db/repositories/pipeline-schedules.js', () => ({
  listEnabledSchedules: vi.fn(),
}))
vi.mock('../../../pipeline/executor.js', () => ({
  runPipeline: vi.fn().mockResolvedValue(1),
  scheduledTrigger: vi.fn(args => ({ type: 'scheduled', ...args })),
}))
vi.mock('../../../pipeline/server-resolver.js', () => ({
  autoResolveServersByRole: vi.fn(),
}))

import cron from 'node-cron'
import { listEnabledSchedules } from '../../../db/repositories/pipeline-schedules.js'
import { runPipeline } from '../../../pipeline/executor.js'
import { autoResolveServersByRole } from '../../../pipeline/server-resolver.js'
import {
  startPipelineScheduler,
  reloadSchedules,
  resolveScheduleServers,
} from '../../../pipeline/scheduler.js'

beforeEach(() => { vi.clearAllMocks() })

const baseSchedule = {
  id: 1,
  pipelineId: 10,
  name: 'x',
  cronExpr: '0 9 * * *',
  presetParams: {} as Record<string, unknown>,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('startPipelineScheduler', () => {
  it('registers cron tasks for all enabled schedules', async () => {
    vi.mocked(listEnabledSchedules).mockResolvedValue([
      { ...baseSchedule, presetParams: { env: 'prod' } },
    ])
    await startPipelineScheduler()
    expect(cron.schedule).toHaveBeenCalledWith('0 9 * * *', expect.any(Function), expect.anything())
  })

  it('reloadSchedules destroys old tasks and registers new ones', async () => {
    const destroy = vi.fn()
    vi.mocked(cron.schedule).mockReturnValue({ destroy } as any)
    vi.mocked(listEnabledSchedules).mockResolvedValue([
      { ...baseSchedule, cronExpr: '* * * * *' },
    ])
    await startPipelineScheduler()
    await reloadSchedules()
    expect(destroy).toHaveBeenCalled()
    expect(cron.schedule).toHaveBeenCalledTimes(2)
  })
})

describe('resolveScheduleServers', () => {
  it('returns auto-resolved servers grouped by role', async () => {
    vi.mocked(autoResolveServersByRole).mockResolvedValue({ proxy: ['7'] })
    const out = await resolveScheduleServers(baseSchedule)
    expect(out).toEqual({ proxy: ['7'] })
  })

  it('returns {} when no role-bound servers exist', async () => {
    vi.mocked(autoResolveServersByRole).mockResolvedValue({})
    const out = await resolveScheduleServers(baseSchedule)
    expect(out).toEqual({})
  })
})

describe('scheduler cron callback (server assignment passthrough)', () => {
  it('passes auto-resolved servers to runPipeline when cron fires', async () => {
    let captured: (() => void) | null = null
    vi.mocked(cron.schedule).mockImplementation(((_expr: string, cb: () => void) => {
      captured = cb
      return { destroy: vi.fn() }
    }) as any)
    vi.mocked(listEnabledSchedules).mockResolvedValue([baseSchedule])
    vi.mocked(autoResolveServersByRole).mockResolvedValue({ proxy: ['7'] })

    await startPipelineScheduler()
    expect(captured).not.toBeNull()
    captured!()
    // cron callback is sync but invokes async resolver+runPipeline; flush.
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    expect(runPipeline).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runPipeline).mock.calls[0][1]).toEqual({ proxy: ['7'] })
  })

  it('passes {} to runPipeline when no role-bound servers exist', async () => {
    let captured: (() => void) | null = null
    vi.mocked(cron.schedule).mockImplementation(((_expr: string, cb: () => void) => {
      captured = cb
      return { destroy: vi.fn() }
    }) as any)
    vi.mocked(listEnabledSchedules).mockResolvedValue([baseSchedule])
    vi.mocked(autoResolveServersByRole).mockResolvedValue({})

    await startPipelineScheduler()
    captured!()
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))

    expect(runPipeline).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runPipeline).mock.calls[0][1]).toEqual({})
  })
})
