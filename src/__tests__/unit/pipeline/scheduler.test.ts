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

import cron from 'node-cron'
import { listEnabledSchedules } from '../../../db/repositories/pipeline-schedules.js'
import { startPipelineScheduler, reloadSchedules } from '../../../pipeline/scheduler.js'

beforeEach(() => { vi.clearAllMocks() })

describe('startPipelineScheduler', () => {
  it('registers cron tasks for all enabled schedules', async () => {
    vi.mocked(listEnabledSchedules).mockResolvedValue([
      { id: 1, pipelineId: 10, name: 'daily', cronExpr: '0 9 * * *', presetParams: { env: 'prod' }, enabled: true, createdAt: new Date(), updatedAt: new Date() },
    ])
    await startPipelineScheduler()
    expect(cron.schedule).toHaveBeenCalledWith('0 9 * * *', expect.any(Function), expect.anything())
  })

  it('reloadSchedules destroys old tasks and registers new ones', async () => {
    const destroy = vi.fn()
    vi.mocked(cron.schedule).mockReturnValue({ destroy } as any)
    vi.mocked(listEnabledSchedules).mockResolvedValue([
      { id: 1, pipelineId: 10, name: 'x', cronExpr: '* * * * *', presetParams: {}, enabled: true, createdAt: new Date(), updatedAt: new Date() },
    ])
    await startPipelineScheduler()
    await reloadSchedules()
    expect(destroy).toHaveBeenCalled()
    expect(cron.schedule).toHaveBeenCalledTimes(2)
  })
})
