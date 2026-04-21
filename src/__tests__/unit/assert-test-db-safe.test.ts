import { describe, it, expect, vi } from 'vitest'
import { assertTestDbSafeToReset, TEST_DB_MARKER_TABLE } from '../helpers/db.js'

describe('assertTestDbSafeToReset', () => {
  const markerRow = { rows: [{ tablename: TEST_DB_MARKER_TABLE }] }
  const emptyRows = { rows: [] }
  const emptyPublicCount = { rows: [{ n: 0 }] }
  const nonEmptyPublicCount = { rows: [{ n: 12 }] }

  it('NODE_ENV=test + marker 表存在 → 通过（不查第二次）', async () => {
    const pool = { query: vi.fn().mockResolvedValue(markerRow) }
    await expect(
      assertTestDbSafeToReset(pool as any, 'test', 'postgres://x/chatops_test'),
    ).resolves.toBeUndefined()
    // 只查了 marker 一次
    expect(pool.query).toHaveBeenCalledTimes(1)
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

  it('NODE_ENV=test + marker 缺失 + public 有业务表 → throw（第二道防御）', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce(emptyRows)           // 查 marker 返回空
        .mockResolvedValueOnce(nonEmptyPublicCount), // 查 public 表数 = 12
    }
    await expect(
      assertTestDbSafeToReset(pool as any, 'test', 'postgres://x/chatops'),
    ).rejects.toThrow(/marker.*chatops_test_db_marker/)
  })

  it('throw 信息包含 bootstrap 指南（CREATE + INSERT）', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce(emptyRows)
        .mockResolvedValueOnce(nonEmptyPublicCount),
    }
    await expect(
      assertTestDbSafeToReset(pool as any, 'test', 'postgres://x/chatops'),
    ).rejects.toThrow(/CREATE TABLE.*INSERT/s)
  })

  it('throw 信息里暴露 DATABASE_URL 以便诊断', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce(emptyRows)
        .mockResolvedValueOnce(nonEmptyPublicCount),
    }
    const dbUrl = 'postgres://xx/somedb'
    await expect(
      assertTestDbSafeToReset(pool as any, 'test', dbUrl),
    ).rejects.toThrow(new RegExp(dbUrl))
  })

  /**
   * 方案 1 新增分支：marker 缺失但 public schema 完全空 → 视为全新测试库（典型 GitLab CI 容器）
   * 自动 bootstrap marker + 通过，避免 CI 每次手动 psql 建表
   */
  it('NODE_ENV=test + marker 缺失 + public 完全空 → 自动 bootstrap + 通过', async () => {
    const createdQueries: string[] = []
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('pg_tables') && sql.includes('tablename=$1')) {
          return Promise.resolve(emptyRows)
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve(emptyPublicCount)
        }
        createdQueries.push(sql)
        return Promise.resolve({ rows: [] })
      }),
    }
    await expect(
      assertTestDbSafeToReset(
        pool as any,
        'test',
        'postgres://chatops:chatops@postgres:5432/chatops',
      ),
    ).resolves.toBeUndefined()
    // 应该执行了 CREATE TABLE + INSERT
    expect(createdQueries.some(q => q.includes('CREATE TABLE'))).toBe(true)
    expect(createdQueries.some(q => q.includes('INSERT INTO'))).toBe(true)
  })
})
