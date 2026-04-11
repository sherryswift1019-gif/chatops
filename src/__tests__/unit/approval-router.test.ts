import { describe, it, expect } from 'vitest'
import { ApprovalRouter } from '../../approval/router.js'
import type { ApprovalRule } from '../../db/repositories/approval-rules.js'

const rules: ApprovalRule[] = [
  { id: 1, productLineId: null, action: 'deploy', env: 'prod', primaryApprovers: ['ops-a', 'ops-b'], backupApprovers: ['admin'], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
  { id: 2, productLineId: null, action: 'deploy', env: 'staging', primaryApprovers: ['dev-lead'], backupApprovers: ['ops-a'], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
  { id: 3, productLineId: null, action: '*', env: 'prod', primaryApprovers: ['ops-group'], backupApprovers: ['admin'], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
  { id: 4, productLineId: null, action: 'rollback', env: '*', primaryApprovers: ['ops-group'], backupApprovers: ['admin'], primaryTimeoutMin: 5, totalTimeoutMin: 15 },
]

describe('ApprovalRouter', () => {
  const router = new ApprovalRouter(rules)

  it('prefers exact action+env match over wildcards', () => {
    const result = router.route('deploy', 'prod')
    expect(result?.primaryApprovers).toEqual(['ops-a', 'ops-b'])
  })

  it('matches exact action with wildcard env', () => {
    const result = router.route('rollback', 'prod')
    expect(result?.primaryApprovers).toEqual(['ops-group'])
    expect(result?.primaryTimeoutMin).toBe(5)
  })

  it('falls back to wildcard action when no exact match', () => {
    const result = router.route('restart', 'prod')
    expect(result?.primaryApprovers).toEqual(['ops-group'])
  })

  it('returns null when no rule matches', () => {
    const result = router.route('query', 'dev')
    expect(result).toBeNull()
  })
})
