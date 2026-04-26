import { describe, it, expect } from 'vitest'
import { listCapabilities, getCapabilityByKey } from '../../db/repositories/capabilities.js'

describe('capabilities repository — phase 1 extended fields', () => {
  it('Capability 类型暴露 4 个新字段并默认值正确', async () => {
    const caps = await listCapabilities()
    expect(caps.length).toBeGreaterThan(0)
    for (const c of caps) {
      expect(typeof c.maxTurns).toBe('number')
      expect(c.maxTurns).toBeGreaterThan(0)
      expect(typeof c.timeoutMs).toBe('number')
      expect(c.timeoutMs).toBeGreaterThan(0)
      expect(typeof c.requiresWorktree).toBe('boolean')
      expect(typeof c.requiresDeployLock).toBe('boolean')
    }
  })

  it('deploy / rollback / restart 已 backfill requiresDeployLock=true', async () => {
    for (const key of ['deploy', 'rollback', 'restart']) {
      const c = await getCapabilityByKey(key)
      expect(c, `capability "${key}" not found`).not.toBeNull()
      expect(c!.requiresDeployLock, `${key}.requiresDeployLock`).toBe(true)
      expect(c!.requiresWorktree, `${key}.requiresWorktree`).toBe(false)
    }
  })

  it('analyze_bug + fix_bug_l1/l2/l3 已 backfill requiresWorktree=true', async () => {
    for (const key of ['analyze_bug', 'fix_bug_l1', 'fix_bug_l2', 'fix_bug_l3']) {
      const c = await getCapabilityByKey(key)
      expect(c, `capability "${key}" not found`).not.toBeNull()
      expect(c!.requiresWorktree, `${key}.requiresWorktree`).toBe(true)
      expect(c!.requiresDeployLock, `${key}.requiresDeployLock`).toBe(false)
    }
  })

  it('view_logs / view_deployments 等查询类 neither 标志为 true', async () => {
    for (const key of ['view_logs', 'view_deployments']) {
      const c = await getCapabilityByKey(key)
      if (!c) continue
      expect(c.requiresWorktree, `${key}.requiresWorktree`).toBe(false)
      expect(c.requiresDeployLock, `${key}.requiresDeployLock`).toBe(false)
    }
  })

  it('默认 maxTurns=30 / timeoutMs=1200000 来自 schema DEFAULT', async () => {
    const c = await getCapabilityByKey('view_logs')
    if (!c) return
    expect(c.maxTurns).toBe(30)
    expect(c.timeoutMs).toBe(1200000)
  })
})
