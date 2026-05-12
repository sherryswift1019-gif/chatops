/**
 * Integration test: reject 拓扑 + round-2 重写机制
 *
 * Verifies:
 *   - reject → retry_counters.reject_counts++ + last_reject_reasons 写入
 *   - cap=3 边界
 *   - approved 路径不触发 reject 计数
 *
 * NOT verified here (留 manual E2E)：
 *   - retryFromNode 真重起 graph stream（依赖 LangGraph runtime）
 *   - skill-runner feedback.md 真写入（依赖 worktree fs）
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import {
  createRequirement,
  getRejectCount,
  incrementRejectCount,
  getLastRejectReason,
} from '../../db/repositories/requirements.js'
import { REJECT_CAP } from '../../pipeline/graph-builder.js'

describe('reject reroute integration', () => {
  let reqId: number

  beforeAll(async () => { await resetTestDb() })

  beforeEach(async () => {
    const r = await createRequirement({
      title: 'integration test', rawInput: 'x', gitlabProject: 'g/p', source: 'web', status: 'draft',
    })
    reqId = r.id
  })

  it('e2e 5.2: reject round 1 → reject_counts=1 + reason 入 last_reject_reasons', async () => {
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(0)

    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 'AC 不够具体，缺边界条件',
    })

    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(1)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBe('AC 不够具体，缺边界条件')
  })

  it('e2e 5.3: 连续 3 次 reject → reject_counts=3 = REJECT_CAP', async () => {
    for (let i = 1; i <= REJECT_CAP; i++) {
      await incrementRejectCount({
        requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
        rejectReason: `round ${i} reject reason`,
      })
      expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(i)
    }

    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(REJECT_CAP)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBe(`round ${REJECT_CAP} reject reason`)
  })

  it('e2e 5.1: 不调 increment → reject_counts 保持 0（approved 路径不污染）', async () => {
    // 模拟 approved 路径：从未调 incrementRejectCount
    expect(await getRejectCount(reqId, 'spec_human_gate')).toBe(0)
    expect(await getLastRejectReason(reqId, 'spec_author')).toBeNull()
  })

  it('多阶段独立：spec reject 不影响 plan 计数（反之亦然）', async () => {
    await incrementRejectCount({
      requirementId: reqId, humanGateNodeId: 'spec_human_gate', authorNodeId: 'spec_author',
      rejectReason: 'spec reason',
    })

    expect(await getRejectCount(reqId, 'plan_human_gate')).toBe(0)
    expect(await getRejectCount(reqId, 'dev_human_gate')).toBe(0)
    expect(await getLastRejectReason(reqId, 'plan_author')).toBeNull()
    expect(await getLastRejectReason(reqId, 'dev_author')).toBeNull()
  })

  it('REJECT_CAP 后端常量值 = 3', () => {
    expect(REJECT_CAP).toBe(3)
  })
})
