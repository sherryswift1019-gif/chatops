import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import {
  createRequirement,
  getRejectCount,
  incrementRejectCount,
  getLastRejectReason,
  getRequirementById,
} from '../../db/repositories/requirements.js'

describe('retry_counters reject helpers', () => {
  let reqId: number

  beforeAll(async () => { await resetTestDb() })

  beforeEach(async () => {
    const r = await createRequirement({
      title: 't', rawInput: 'r', gitlabProject: 'g/p', source: 'web', status: 'draft',
    })
    reqId = r.id
  })

  it('getRejectCount: 新需求返回 0', async () => {
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(0)
  })

  it('incrementRejectCount: 首次累加 0→1，写入 reject_counts + last_reject_reasons', async () => {
    const result = await incrementRejectCount({
      requirementId: reqId,
      humanGateNodeId: 'spec_human_gate',
      authorNodeId: 'spec_author',
      rejectReason: 'AC 不够具体',
    })
    expect(result.newCount).toBe(1)
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(1)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBe('AC 不够具体')
  })

  it('incrementRejectCount: 第 2 次累加 1→2，rejectReason 覆盖', async () => {
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 'round 1 reason',
    })
    const result = await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 'round 2 reason',
    })
    expect(result.newCount).toBe(2)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBe('round 2 reason')
  })

  it('incrementRejectCount: 多 node 互不干扰', async () => {
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 's',
    })
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'plan_human_gate', authorNodeId: 'plan_author',
      rejectReason: 'p',
    })
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(1)
    expect(await getRejectCount(reqId, 'plan_human_gate')).toBe(1)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBe('s')
    expect(await getLastRejectReason(reqId, 'plan_author')).toBe('p')
  })

  it('getLastRejectReason: 不存在返回 null', async () => {
    expect(await getLastRejectReason(reqId, 'spec_author')).toBeNull()
  })

  it('incrementRejectCount: 与现有 node_retry_counts 并存（不互相覆盖）', async () => {
    const pool = (await import('../../db/client.js')).getPool()
    await pool.query(
      `UPDATE requirements SET retry_counters = jsonb_set(
        jsonb_set(
          COALESCE(retry_counters, '{}'::jsonb),
          '{node_retry_counts}'::text[],
          '{}'::jsonb,
          true
        ),
        '{node_retry_counts,spec_author}',
        '2'::jsonb, true
      ) WHERE id = $1`,
      [reqId],
    )
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 'x',
    })
    const r = await getRequirementById(reqId)
    const counters = r!.retryCounters as {
      node_retry_counts?: Record<string, number>
      reject_counts?: Record<string, number>
    }
    expect(counters.node_retry_counts?.spec_author).toBe(2)
    expect(counters.reject_counts?.spec_human_gate).toBe(1)
  })
})
