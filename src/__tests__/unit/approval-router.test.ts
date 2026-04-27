import { describe, it, expect, beforeEach } from 'vitest'
import { ApprovalRouter } from '../../approval/router.js'
import type { ApprovalRule } from '../../db/repositories/approval-rules.js'

const rules: ApprovalRule[] = [
  { id: 1, productLineId: null, imTriggerKey: 'deploy', env: 'prod', primaryApprovers: ['ops-a', 'ops-b'], backupApprovers: ['admin'], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
  { id: 2, productLineId: null, imTriggerKey: 'deploy', env: 'staging', primaryApprovers: ['dev-lead'], backupApprovers: ['ops-a'], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
  { id: 3, productLineId: null, imTriggerKey: '*', env: 'prod', primaryApprovers: ['ops-group'], backupApprovers: ['admin'], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
  { id: 4, productLineId: null, imTriggerKey: 'rollback', env: '*', primaryApprovers: ['ops-group'], backupApprovers: ['admin'], primaryTimeoutMin: 5, totalTimeoutMin: 15 },
]

describe('ApprovalRouter', () => {
  let router: ApprovalRouter

  beforeEach(() => {
    router = new ApprovalRouter(rules)
  })

  it('prefers exact imTriggerKey+env match over wildcards', () => {
    const result = router.route('deploy', 'prod')
    expect(result?.primaryApprovers).toEqual(['ops-a', 'ops-b'])
  })

  it('matches exact imTriggerKey with wildcard env', () => {
    const result = router.route('rollback', 'prod')
    expect(result?.primaryApprovers).toEqual(['ops-group'])
    expect(result?.primaryTimeoutMin).toBe(5)
  })

  it('falls back to wildcard imTriggerKey when no exact match', () => {
    const result = router.route('restart', 'prod')
    expect(result?.primaryApprovers).toEqual(['ops-group'])
  })

  it('returns null when no rule matches', () => {
    const result = router.route('query', 'dev')
    expect(result).toBeNull()
  })
})
