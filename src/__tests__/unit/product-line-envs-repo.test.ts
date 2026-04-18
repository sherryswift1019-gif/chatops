import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockQuery = vi.fn()
vi.mock('../../db/client.js', () => ({
  getPool: () => ({ query: mockQuery, connect: vi.fn() }),
}))

import { upsertProductLineEnv } from '../../db/repositories/product-line-envs.js'

beforeEach(() => { mockQuery.mockReset() })

describe('product-line-envs repo - defaultBranch', () => {
  it('persists defaultBranch on upsert', async () => {
    mockQuery.mockResolvedValue({ rows: [{
      id: 1, product_line_id: 1, env_id: 2,
      runtime: 'docker', namespace: '', enabled: true,
      connection_config: { serverIds: [5] },
      default_branch: 'develop',
    }]})
    const res = await upsertProductLineEnv({
      productLineId: 1, envId: 2, runtime: 'docker',
      connectionConfig: { serverIds: [5] }, defaultBranch: 'develop',
    })
    expect(res.defaultBranch).toBe('develop')
    const callArgs = mockQuery.mock.calls[0]
    expect(callArgs[1]).toContain('develop')
  })

  it('defaults defaultBranch to empty string when mapping row', async () => {
    mockQuery.mockResolvedValue({ rows: [{
      id: 1, product_line_id: 1, env_id: 2,
      runtime: 'docker', namespace: '', enabled: true,
      connection_config: {},
      default_branch: '',
    }]})
    const res = await upsertProductLineEnv({
      productLineId: 1, envId: 2, runtime: 'docker',
    })
    expect(res.defaultBranch).toBe('')
  })
})
