import { describe, it, expect } from 'vitest'
import { ApprovalRouter } from '../../approval/router.js'

describe('ApprovalRouter — phase 2 imTriggerKey', () => {
  it('matches exact imTriggerKey + env', () => {
    const r = new ApprovalRouter([
      { id: 1, productLineId: null, imTriggerKey: 'deploy', env: 'prod',
        primaryApprovers: ['ops'], backupApprovers: [], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
    ])
    expect(r.route('deploy', 'prod')?.id).toBe(1)
    expect(r.route('deploy', 'dev')).toBeNull()
  })

  it('falls back to wildcard env', () => {
    const r = new ApprovalRouter([
      { id: 2, productLineId: null, imTriggerKey: 'deploy', env: '*',
        primaryApprovers: ['ops'], backupApprovers: [], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
    ])
    expect(r.route('deploy', 'staging')?.id).toBe(2)
  })

  it('falls back to wildcard imTriggerKey', () => {
    const r = new ApprovalRouter([
      { id: 3, productLineId: null, imTriggerKey: '*', env: 'prod',
        primaryApprovers: ['ops'], backupApprovers: [], primaryTimeoutMin: 10, totalTimeoutMin: 20 },
    ])
    expect(r.route('rollback', 'prod')?.id).toBe(3)
  })
})
