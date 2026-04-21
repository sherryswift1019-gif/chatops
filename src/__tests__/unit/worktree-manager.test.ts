import { describe, it, expect } from 'vitest'
import { makeWorktreeKey } from '../../agent/worktree/manager.js'

describe('worktree manager', () => {
  it('different projects with same branch yield different keys', () => {
    const k1 = makeWorktreeKey({ productLineId: 1, projectPath: 'PAM/pas-6.0', branch: 'fix/bug-123' })
    const k2 = makeWorktreeKey({ productLineId: 1, projectPath: 'PAM/pas-api', branch: 'fix/bug-123' })
    expect(k1).not.toBe(k2)
  })

  it('same project + same branch yields same key (stable)', () => {
    const k1 = makeWorktreeKey({ productLineId: 1, projectPath: 'PAM/pas-6.0', branch: 'fix/bug-123' })
    const k2 = makeWorktreeKey({ productLineId: 1, projectPath: 'PAM/pas-6.0', branch: 'fix/bug-123' })
    expect(k1).toBe(k2)
  })

  it('key is filesystem-safe (slashes replaced)', () => {
    const key = makeWorktreeKey({ productLineId: 1, projectPath: 'PAM/java-code/pas-6.0', branch: 'fix/bug-123' })
    expect(key).not.toContain('/')
  })
})
