import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('../../db/client.js', () => ({
  getPool: () => ({ query: mockQuery, connect: vi.fn() }),
}))

import { checkCapabilityAccess } from '../../db/repositories/product-line-capabilities.js'

beforeEach(() => { mockQuery.mockReset() })

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    product_line_id: 1,
    capability_key: 'deploy',
    env_name: '*',
    enabled: true,
    allowed_roles: ['developer'],
    trigger_sources: ['im', 'web'],
    ...overrides,
  }
}

describe('checkCapabilityAccess - trigger_sources', () => {
  it('allows IM when trigger_sources contains im', async () => {
    mockQuery.mockResolvedValue({ rows: [row()] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'im')
    expect(res.allowed).toBe(true)
  })

  it('blocks IM with reason=source-blocked when trigger_sources excludes im', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ trigger_sources: ['web'] })] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'im')
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('source-blocked')
  })

  it('defaults to allow when trigger_sources column missing (legacy row)', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ trigger_sources: undefined })] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'im')
    expect(res.allowed).toBe(true)
  })

  it('priority: enabled=false rejects before trigger_sources check', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ enabled: false, trigger_sources: ['web'] })] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'im')
    expect(res.allowed).toBe(false)
    expect(res.reason).not.toBe('source-blocked')
  })

  it('priority: allowedRoles mismatch rejects before trigger_sources check', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ allowed_roles: ['admin'], trigger_sources: ['web'] })] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'im')
    expect(res.allowed).toBe(false)
    expect(res.reason).not.toBe('source-blocked')
  })

  it('web source allowed when trigger_sources contains web', async () => {
    mockQuery.mockResolvedValue({ rows: [row({ trigger_sources: ['web'] })] })
    const res = await checkCapabilityAccess(1, 'deploy', 'dev', 'developer', 'web')
    expect(res.allowed).toBe(true)
  })
})
