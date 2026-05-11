import { describe, it, expect, beforeAll } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { createRequirement } from '../../db/repositories/requirements.js'
import {
  NODE_RETRY_CAP,
  getNodeRetryCount,
  incrementNodeRetryCount,
} from '../../db/repositories/requirements.js'
import { setRetryCounter } from '../../db/repositories/requirements.js'

describe('node retry cap helpers', () => {
  let requirementId: number

  beforeAll(async () => {
    await resetTestDb()
    const req = await createRequirement({
      title: 'retry-cap-test',
      rawInput: 'x',
      gitlabProject: 'g/p',
      baseBranch: 'main',
      source: 'web',
    })
    requirementId = req.id
  })

  it('getNodeRetryCount returns 0 when no history', async () => {
    const count = await getNodeRetryCount(requirementId, 'spec_author')
    expect(count).toBe(0)
  })

  it('incrementNodeRetryCount per node independently', async () => {
    await incrementNodeRetryCount(requirementId, 'spec_author')
    await incrementNodeRetryCount(requirementId, 'spec_author')
    await incrementNodeRetryCount(requirementId, 'dev_loop')

    const specAuthorCount = await getNodeRetryCount(requirementId, 'spec_author')
    const devLoopCount = await getNodeRetryCount(requirementId, 'dev_loop')
    const otherCount = await getNodeRetryCount(requirementId, 'reviewer')

    expect(specAuthorCount).toBe(2)
    expect(devLoopCount).toBe(1)
    expect(otherCount).toBe(0)
  })

  it('incrementNodeRetryCount preserves other retry_counters fields', async () => {
    // set a non-node_retry_counts key (e.g. spec_rounds) before increment
    await setRetryCounter(requirementId, 'spec_rounds', 3)

    await incrementNodeRetryCount(requirementId, 'plan_author')

    const { getRequirementById } = await import('../../db/repositories/requirements.js')
    const req = await getRequirementById(requirementId)

    // spec_rounds must still be 3
    expect((req!.retryCounters as any).spec_rounds).toBe(3)

    // node_retry_counts.plan_author should be 1
    const planCount = await getNodeRetryCount(requirementId, 'plan_author')
    expect(planCount).toBe(1)
  })

  it('NODE_RETRY_CAP constant > 0 and <= 10', () => {
    expect(NODE_RETRY_CAP).toBeGreaterThan(0)
    expect(NODE_RETRY_CAP).toBeLessThanOrEqual(10)
  })
})
