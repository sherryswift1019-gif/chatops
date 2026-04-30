import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  getPool: vi.fn(),
}))

import { getPool } from '../../db/client.js'
import { verifySandboxSafety } from '../../e2e/sandbox-sentinel.js'

function mockPool(dbName: string) {
  vi.mocked(getPool).mockReturnValue({
    query: vi.fn().mockResolvedValue({ rows: [{ current_database: dbName }] }),
  } as unknown as ReturnType<typeof getPool>)
}

describe('verifySandboxSafety', () => {
  it('非沙盒模式 → 直接返回（不查 DB）', async () => {
    delete process.env.E2E_SANDBOX_MODE
    await expect(verifySandboxSafety()).resolves.toBeUndefined()
    expect(getPool).not.toHaveBeenCalled()
  })

  it('沙盒模式 + DB 名以 sandbox- 开头 → 通过', async () => {
    process.env.E2E_SANDBOX_MODE = 'true'
    mockPool('sandbox-pg-test-iter-42')
    await expect(verifySandboxSafety()).resolves.toBeUndefined()
    delete process.env.E2E_SANDBOX_MODE
  })

  it('沙盒模式 + DB 名是生产库名 → 抛错', async () => {
    process.env.E2E_SANDBOX_MODE = 'true'
    mockPool('chatops_production')
    await expect(verifySandboxSafety()).rejects.toThrow('sandbox safety check failed')
    delete process.env.E2E_SANDBOX_MODE
  })
})
