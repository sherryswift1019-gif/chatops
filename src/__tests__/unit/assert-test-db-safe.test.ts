import { describe, it, expect, vi } from 'vitest'
import { assertTestDbSafeToReset, TEST_DB_MARKER_TABLE } from '../helpers/db.js'

describe('assertTestDbSafeToReset', () => {
  const markerRow = { rows: [{ tablename: TEST_DB_MARKER_TABLE }] }
  const emptyRows = { rows: [] }

  it('NODE_ENV=test + marker 表存在 → 通过', async () => {
    const pool = { query: vi.fn().mockResolvedValue(markerRow) }
    await expect(
      assertTestDbSafeToReset(pool as any, 'test', 'postgres://x/chatops_test'),
    ).resolves.toBeUndefined()
  })

  it('NODE_ENV=production → throw（第一道防御）', async () => {
    const pool = { query: vi.fn() }
    await expect(
      assertTestDbSafeToReset(pool as any, 'production', 'postgres://x/chatops_test'),
    ).rejects.toThrow(/NODE_ENV=production/)
    // 不能走到查 DB 步骤
    expect(pool.query).not.toHaveBeenCalled()
  })

  it('NODE_ENV=undefined → throw', async () => {
    const pool = { query: vi.fn() }
    await expect(
      assertTestDbSafeToReset(pool as any, undefined, 'postgres://x/chatops_test'),
    ).rejects.toThrow(/NODE_ENV=undefined/)
  })

  it('NODE_ENV=test 但 marker 表不存在 → throw（第二道防御）', async () => {
    const pool = { query: vi.fn().mockResolvedValue(emptyRows) }
    await expect(
      assertTestDbSafeToReset(pool as any, 'test', 'postgres://x/chatops'),
    ).rejects.toThrow(/marker.*chatops_test_db_marker/)
  })

  it('throw 信息包含 bootstrap 指南（CREATE + INSERT）', async () => {
    const pool = { query: vi.fn().mockResolvedValue(emptyRows) }
    await expect(
      assertTestDbSafeToReset(pool as any, 'test', 'postgres://x/chatops'),
    ).rejects.toThrow(/CREATE TABLE.*INSERT/s)
  })

  it('throw 信息里暴露 DATABASE_URL 以便诊断', async () => {
    const pool = { query: vi.fn().mockResolvedValue(emptyRows) }
    const dbUrl = 'postgres://xx/somedb'
    await expect(
      assertTestDbSafeToReset(pool as any, 'test', dbUrl),
    ).rejects.toThrow(new RegExp(dbUrl))
  })
})
