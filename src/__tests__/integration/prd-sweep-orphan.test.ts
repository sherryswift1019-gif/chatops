/**
 * sweepOrphanReviewingPrds 的单测（真实 pg）。
 *
 * 目的：自审进程被中断后 PRD 卡 reviewing 的兜底。验证：
 *   - status=reviewing 且 updated_at 足够旧 → 被推到 review_blocked + 合成 finding
 *   - status=reviewing 但刚更新（<阈值）→ 不动
 *   - status=draft / drafting / review_blocked / approved / archived → 永不触
 *   - 返回值 = 实际被推的条数
 *
 * 约束：需要真实 pg。CI 默认 skip；本地 RUN_CLAUDE_TESTS=1 开启（与 620bdaa 其他 integration spec 对齐）。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { getPool } from '../../db/client.js'
import { sweepOrphanReviewingPrds } from '../../db/repositories/prd-documents.js'

describe.skipIf(!process.env.RUN_CLAUDE_TESTS)('sweepOrphanReviewingPrds', () => {
  const pool = () => getPool()
  let productLineId: number
  const tempIds: number[] = []

  beforeAll(async () => {
    // 用任意已有产品线；没有就临时建一个专供测试
    const { rows } = await pool().query<{ id: number }>(
      `SELECT id FROM product_lines ORDER BY id LIMIT 1`
    )
    if (rows[0]) {
      productLineId = rows[0].id
    } else {
      const ins = await pool().query<{ id: number }>(
        `INSERT INTO product_lines (name, code) VALUES ('sweep-test', 'sweep-test') RETURNING id`
      )
      productLineId = ins.rows[0].id
    }
  })

  afterAll(async () => {
    if (tempIds.length > 0) {
      await pool().query(`DELETE FROM prd_documents WHERE id = ANY($1::int[])`, [tempIds])
    }
    await pool().end()
  })

  async function insertPrd(params: {
    status: string
    updatedAgoMinutes: number
  }): Promise<number> {
    const { rows } = await pool().query<{ id: number }>(
      `INSERT INTO prd_documents
         (product_line_id, title, content_markdown, content_json, tags,
          created_by, group_id, platform, agent_session_id, status, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10,
               NOW() - ($11 || ' minutes')::interval)
       RETURNING id`,
      [
        productLineId,
        `sweep-test-${params.status}-${params.updatedAgoMinutes}m`,
        '# sweep test',
        '{}',
        '[]',
        'tester',
        null,
        null,
        null,
        params.status,
        params.updatedAgoMinutes,
      ]
    )
    tempIds.push(rows[0].id)
    return rows[0].id
  }

  beforeEach(async () => {
    // 每个测试前清理上轮造的数据，保持幂等
    if (tempIds.length > 0) {
      await pool().query(`DELETE FROM prd_documents WHERE id = ANY($1::int[])`, [tempIds])
      tempIds.length = 0
    }
  })

  it('reviewing 且过期 → 被推到 review_blocked', async () => {
    const id = await insertPrd({ status: 'reviewing', updatedAgoMinutes: 10 })
    const swept = await sweepOrphanReviewingPrds(5 * 60 * 1000)
    expect(swept).toBeGreaterThanOrEqual(1)

    const { rows } = await pool().query<{
      status: string
      review_result: Record<string, unknown> | null
    }>(`SELECT status, review_result FROM prd_documents WHERE id = $1`, [id])
    expect(rows[0].status).toBe('review_blocked')
    const result = rows[0].review_result!
    expect(result.status).toBe('blocked')
    const findings = result.findings as Array<{ dimension: string; severity: string }>
    expect(findings[0].dimension).toBe('review_interrupted')
    expect(findings[0].severity).toBe('blocker')
  })

  it('reviewing 但刚更新（<阈值）→ 不动', async () => {
    const id = await insertPrd({ status: 'reviewing', updatedAgoMinutes: 1 })
    // 5 分钟阈值：1 分钟的不会被扫
    await sweepOrphanReviewingPrds(5 * 60 * 1000)

    const { rows } = await pool().query<{ status: string }>(
      `SELECT status FROM prd_documents WHERE id = $1`,
      [id]
    )
    expect(rows[0].status).toBe('reviewing')
  })

  it.each(['drafting', 'draft', 'review_blocked', 'approved', 'archived'])(
    'status=%s 即便过期也不被触碰',
    async (status) => {
      const id = await insertPrd({ status, updatedAgoMinutes: 60 })
      await sweepOrphanReviewingPrds(5 * 60 * 1000)

      const { rows } = await pool().query<{ status: string }>(
        `SELECT status FROM prd_documents WHERE id = $1`,
        [id]
      )
      expect(rows[0].status).toBe(status)
    }
  )

  it('返回值 = 实际被推的条数', async () => {
    await insertPrd({ status: 'reviewing', updatedAgoMinutes: 10 })
    await insertPrd({ status: 'reviewing', updatedAgoMinutes: 20 })
    await insertPrd({ status: 'reviewing', updatedAgoMinutes: 1 }) // 不过期
    await insertPrd({ status: 'draft', updatedAgoMinutes: 60 }) // 错状态

    const swept = await sweepOrphanReviewingPrds(5 * 60 * 1000)
    expect(swept).toBe(2)
  })

  it('合成 finding 的 canAutoFix=false + ownership=admin（避免自动重跑）', async () => {
    const id = await insertPrd({ status: 'reviewing', updatedAgoMinutes: 10 })
    await sweepOrphanReviewingPrds(5 * 60 * 1000)

    const { rows } = await pool().query<{ review_result: Record<string, unknown> }>(
      `SELECT review_result FROM prd_documents WHERE id = $1`,
      [id]
    )
    const findings = rows[0].review_result.findings as Array<{
      canAutoFix: boolean
      ownership: string
    }>
    expect(findings[0].canAutoFix).toBe(false)
    expect(findings[0].ownership).toBe('admin')
  })
})
