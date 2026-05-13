import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { getPool } from '../../db/client.js'
import {
  createRequirement,
  getRequirementById,
  listRequirements,
  setRequirementStatus,
  forceSetRequirementStatus,
  setBranchAndWorktree,
  setMrUrl,
  setRetryCounter,
  appendRetryCounterArray,
  countActiveRequirements,
  isTerminalStatus,
} from '../../db/repositories/requirements.js'
import {
  createWaiter,
  claimWaiter,
  getActiveWaiter,
  getWaiterById,
  listWaitersByRequirement,
  forceClaimAllPending,
} from '../../db/repositories/requirement-approval-waiters.js'

describe('schema-v60 / requirements repository', () => {
  beforeAll(async () => {
    // testcontainer postgres 已由 globalSetup 拉起并跑过 schema-v60；这里只做表存在校验
    const pool = getPool()
    const t1 = await pool.query(
      `SELECT to_regclass('public.requirements') AS t`,
    )
    expect(t1.rows[0].t).toBe('requirements')
    const t2 = await pool.query(
      `SELECT to_regclass('public.requirement_approval_waiters') AS t`,
    )
    expect(t2.rows[0].t).toBe('requirement_approval_waiters')
  })

  afterEach(async () => {
    const pool = getPool()
    await pool.query(`DELETE FROM requirement_approval_waiters`)
    await pool.query(`DELETE FROM requirements`)
  })

  it('CREATE inserts row with default status=draft', async () => {
    const r = await createRequirement({
      title: '新增用户注册页面',
      rawInput: '新增一个用户注册页面，需要邮箱密码',
      gitlabProject: 'group/repo',
      createdBy: 'tester',
    })
    expect(r.id).toBeGreaterThan(0)
    expect(r.status).toBe('draft')
    expect(r.baseBranch).toBe('main')
    expect(r.source).toBe('web')
    expect(r.retryCounters).toEqual({})

    const fetched = await getRequirementById(r.id)
    expect(fetched?.title).toBe(r.title)
  })

  it('listRequirements paginates and filters by status', async () => {
    for (let i = 0; i < 5; i++) {
      await createRequirement({
        title: `req-${i}`,
        rawInput: `text ${i}`,
        gitlabProject: 'g/r',
      })
    }
    const all = await listRequirements({ size: 10 })
    expect(all.total).toBe(5)
    expect(all.items).toHaveLength(5)

    const first = all.items[0]!
    await setRequirementStatus(first.id, 'planning')

    const planning = await listRequirements({ status: 'planning' })
    expect(planning.total).toBe(1)
    expect(planning.items[0]!.id).toBe(first.id)
  })

  describe('status state machine', () => {
    it('setRequirementStatus advances non-terminal status', async () => {
      const r = await createRequirement({
        title: 't',
        rawInput: 'x',
        gitlabProject: 'g/r',
      })
      const ok = await setRequirementStatus(r.id, 'planning', 'plan_author')
      expect(ok).toBe(true)
      const fetched = await getRequirementById(r.id)
      expect(fetched?.status).toBe('planning')
      expect(fetched?.currentStage).toBe('plan_author')
    })

    it('setRequirementStatus refuses to overwrite terminal status', async () => {
      const r = await createRequirement({
        title: 't',
        rawInput: 'x',
        gitlabProject: 'g/r',
      })
      await forceSetRequirementStatus(r.id, 'aborted', 'user requested')
      const ok = await setRequirementStatus(r.id, 'developing')
      expect(ok).toBe(false)
      const fetched = await getRequirementById(r.id)
      expect(fetched?.status).toBe('aborted')
      expect(fetched?.abortReason).toBe('user requested')
      expect(fetched?.completedAt).not.toBeNull()
    })

    it('forceSetRequirementStatus overwrites terminal too', async () => {
      const r = await createRequirement({
        title: 't',
        rawInput: 'x',
        gitlabProject: 'g/r',
      })
      await forceSetRequirementStatus(r.id, 'failed')
      await forceSetRequirementStatus(r.id, 'aborted', 'cleanup')
      const fetched = await getRequirementById(r.id)
      expect(fetched?.status).toBe('aborted')
      expect(fetched?.abortReason).toBe('cleanup')
    })

    it('isTerminalStatus matches state machine', () => {
      expect(isTerminalStatus('merged')).toBe(true)
      expect(isTerminalStatus('aborted')).toBe(true)
      expect(isTerminalStatus('failed')).toBe(true)
      expect(isTerminalStatus('developing')).toBe(false)
      expect(isTerminalStatus('mr_open')).toBe(false)
    })
  })

  it('setBranchAndWorktree + setMrUrl', async () => {
    const r = await createRequirement({
      title: 't',
      rawInput: 'x',
      gitlabProject: 'g/r',
    })
    await setBranchAndWorktree(r.id, 'feat/qi-' + r.id, '/tmp/quick-impl/qi-' + r.id)
    await setMrUrl(r.id, 'https://gitlab.example/g/r/-/merge_requests/42')
    const fetched = await getRequirementById(r.id)
    expect(fetched?.branch).toBe('feat/qi-' + r.id)
    expect(fetched?.worktreePath).toContain('quick-impl')
    expect(fetched?.mrUrl).toContain('merge_requests/42')
  })

  describe('retry_counters atomic update', () => {
    it('setRetryCounter sets simple value', async () => {
      const r = await createRequirement({
        title: 't',
        rawInput: 'x',
        gitlabProject: 'g/r',
      })
      await setRetryCounter(r.id, 'spec_rounds', 3)
      const fetched = await getRequirementById(r.id)
      expect(fetched?.retryCounters.spec_rounds).toBe(3)
    })

    it('appendRetryCounterArray appends task_index dense', async () => {
      const r = await createRequirement({
        title: 't',
        rawInput: 'x',
        gitlabProject: 'g/r',
      })
      await appendRetryCounterArray(r.id, 'dev_completed_tasks', 0)
      await appendRetryCounterArray(r.id, 'dev_completed_tasks', 1)
      await appendRetryCounterArray(r.id, 'dev_completed_tasks', 2)
      const fetched = await getRequirementById(r.id)
      expect(fetched?.retryCounters.dev_completed_tasks).toEqual([0, 1, 2])
    })
  })

  it('countActiveRequirements excludes draft/queued/terminal', async () => {
    const a = await createRequirement({
      title: 'a',
      rawInput: 'x',
      gitlabProject: 'g/r',
    })
    const b = await createRequirement({
      title: 'b',
      rawInput: 'x',
      gitlabProject: 'g/r',
    })
    const c = await createRequirement({
      title: 'c',
      rawInput: 'x',
      gitlabProject: 'g/r',
    })

    expect(await countActiveRequirements()).toBe(0) // 全是 draft

    await setRequirementStatus(a.id, 'spec_review')
    await setRequirementStatus(b.id, 'developing')
    await forceSetRequirementStatus(c.id, 'failed')

    expect(await countActiveRequirements()).toBe(2)
  })
})

describe('schema-v60 / requirement_approval_waiters race-claim', () => {
  let reqId: number

  beforeAll(async () => {
    // 表存在校验
    const pool = getPool()
    await pool.query(`SELECT 1 FROM requirement_approval_waiters LIMIT 1`)
  })

  afterEach(async () => {
    const pool = getPool()
    await pool.query(`DELETE FROM requirement_approval_waiters`)
    await pool.query(`DELETE FROM requirements`)
  })

  async function setupRequirement(): Promise<number> {
    const r = await createRequirement({
      title: 't',
      rawInput: 'x',
      gitlabProject: 'g/r',
    })
    reqId = r.id
    return r.id
  }

  it('createWaiter inserts unclaimed row; getActiveWaiter returns it', async () => {
    const id = await setupRequirement()
    const w = await createWaiter({
      requirementId: id,
      pipelineRunId: 999,
      nodeId: 'spec_review_loop',
      approvalKind: 'spec',
      round: 1,
      decisionSet: 'binary',
      imGroupId: 'g1',
      imPlatform: 'dingtalk',
      contextSummary: '初版 spec 摘要',
    })
    expect(w.claimedBy).toBeNull()
    expect(w.round).toBe(1)
    expect(w.contextSummary).toBe('初版 spec 摘要')

    const active = await getActiveWaiter(id, 'spec_review_loop')
    expect(active?.id).toBe(w.id)
  })

  it('UNIQUE INDEX rejects second active waiter for same (requirement, node)', async () => {
    const id = await setupRequirement()
    await createWaiter({
      requirementId: id,
      pipelineRunId: 1,
      nodeId: 'spec_review_loop',
      approvalKind: 'spec',
      round: 1,
      decisionSet: 'binary',
    })
    await expect(
      createWaiter({
        requirementId: id,
        pipelineRunId: 1,
        nodeId: 'spec_review_loop',
        approvalKind: 'spec',
        round: 2,
        decisionSet: 'binary',
      }),
    ).rejects.toThrow(/duplicate key/)
  })

  it('claimWaiter race: only first call wins', async () => {
    const id = await setupRequirement()
    const w = await createWaiter({
      requirementId: id,
      pipelineRunId: 1,
      nodeId: 'spec_review_loop',
      approvalKind: 'spec',
      round: 1,
      decisionSet: 'binary',
    })

    // 模拟同时到达
    const [imResult, webResult] = await Promise.all([
      claimWaiter(w.id, 'im', { decision: 'approved', decidedBy: 'imuser' }),
      claimWaiter(w.id, 'web', { decision: 'approved', decidedBy: 'webuser' }),
    ])

    const claims = [imResult, webResult]
    const wins = claims.filter((c) => c.claimed)
    const losses = claims.filter((c) => !c.claimed)
    expect(wins).toHaveLength(1)
    expect(losses).toHaveLength(1)

    // 失败方应能拿到 'by'（被谁先 claim）
    expect(losses[0]!.by).toMatch(/^(im|web)$/)
    expect(losses[0]!.by).toBe(wins[0]!.waiter!.claimedBy)
  })

  it('after claim, new waiter can be created (UNIQUE INDEX is partial)', async () => {
    const id = await setupRequirement()
    const w1 = await createWaiter({
      requirementId: id,
      pipelineRunId: 1,
      nodeId: 'spec_review_loop',
      approvalKind: 'spec',
      round: 1,
      decisionSet: 'binary',
    })
    await claimWaiter(w1.id, 'web', {
      decision: 'rejected',
      rejectReason: 'spec 不够详细',
      decidedBy: 'reviewer1',
    })

    // 第二轮 INSERT 应当成功（前一行已 claimed）
    const w2 = await createWaiter({
      requirementId: id,
      pipelineRunId: 1,
      nodeId: 'spec_review_loop',
      approvalKind: 'spec',
      round: 2,
      decisionSet: 'binary',
    })
    expect(w2.round).toBe(2)
  })

  it('claim with reject_reason persists', async () => {
    const id = await setupRequirement()
    const w = await createWaiter({
      requirementId: id,
      pipelineRunId: 1,
      nodeId: 'n1',
      approvalKind: 'spec',
      round: 1,
      decisionSet: 'binary',
    })
    const result = await claimWaiter(w.id, 'web', {
      decision: 'rejected',
      rejectReason: '需要补充错误处理',
      decidedBy: 'reviewer1',
    })
    expect(result.claimed).toBe(true)
    const fetched = await getWaiterById(w.id)
    expect(fetched?.decision).toBe('rejected')
    expect(fetched?.rejectReason).toBe('需要补充错误处理')
    expect(fetched?.decidedBy).toBe('reviewer1')
  })

  it('escalation decision_set accepts force_passed / budget_extended / aborted', async () => {
    const id = await setupRequirement()
    const w = await createWaiter({
      requirementId: id,
      pipelineRunId: 1,
      nodeId: 'spec_review_loop',
      approvalKind: 'escalation',
      round: 1,
      decisionSet: 'escalation',
    })
    const result = await claimWaiter(w.id, 'web', {
      decision: 'budget_extended',
      budgetDelta: 3,
      decidedBy: 'admin',
    })
    expect(result.claimed).toBe(true)
    const fetched = await getWaiterById(w.id)
    expect(fetched?.decision).toBe('budget_extended')
    expect(fetched?.budgetDelta).toBe(3)
  })

  it('listWaitersByRequirement returns history in created_at order', async () => {
    const id = await setupRequirement()
    const w1 = await createWaiter({
      requirementId: id,
      pipelineRunId: 1,
      nodeId: 'spec_review_loop',
      approvalKind: 'spec',
      round: 1,
      decisionSet: 'binary',
    })
    await claimWaiter(w1.id, 'web', { decision: 'rejected', rejectReason: 'r1' })

    const w2 = await createWaiter({
      requirementId: id,
      pipelineRunId: 1,
      nodeId: 'spec_review_loop',
      approvalKind: 'spec',
      round: 2,
      decisionSet: 'binary',
    })
    await claimWaiter(w2.id, 'im', { decision: 'approved' })

    const history = await listWaitersByRequirement(id)
    expect(history).toHaveLength(2)
    expect(history[0]!.round).toBe(1)
    expect(history[1]!.round).toBe(2)
    expect(history[0]!.decision).toBe('rejected')
    expect(history[1]!.decision).toBe('approved')
  })

  it('forceClaimAllPending clears unclaimed for retry/abort', async () => {
    const id = await setupRequirement()
    await createWaiter({
      requirementId: id,
      pipelineRunId: 1,
      nodeId: 'spec_review_loop',
      approvalKind: 'spec',
      round: 1,
      decisionSet: 'binary',
    })

    // 创建后立刻 force-claim
    const cleared = await forceClaimAllPending(id, 'abort', 'aborted')
    expect(cleared).toBe(1)

    // 再创建新行不应被 UNIQUE INDEX 拦
    const w2 = await createWaiter({
      requirementId: id,
      pipelineRunId: 2,
      nodeId: 'spec_review_loop',
      approvalKind: 'spec',
      round: 1,
      decisionSet: 'binary',
    })
    expect(w2.id).toBeGreaterThan(0)
  })
})

describe('schema-v60 / pipeline_node_types extension', () => {
  it('8 quick_impl node types are registered (v60 + v61 + v62)', async () => {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT key, category, is_system FROM pipeline_node_types
        WHERE category = 'quick_impl' ORDER BY key`,
    )
    const keys = rows.map((r) => r.key)
    expect(keys).toEqual([
      'e2e_stub',        // v61
      'im_input',        // v62
      'init_qi_branch',  // v61
      'mr_create',       // v60
      'qi_e2e_runner',   // v62
      'skill_node',      // v60
      'skill_with_approval', // v60
      'skill_with_review',   // v60
    ])
    for (const r of rows) {
      expect(r.is_system).toBe(true)
    }
  })

  it('CHECK constraint allows quick_impl category', async () => {
    const pool = getPool()
    await pool.query(
      `INSERT INTO pipeline_node_types (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
       VALUES ('test_qi_extra', 'tmp', '', 'quick_impl', '{}'::jsonb, '{}'::jsonb, FALSE, FALSE)
       ON CONFLICT (key) DO NOTHING`,
    )
    await pool.query(`DELETE FROM pipeline_node_types WHERE key = 'test_qi_extra'`)
  })

  it('CHECK constraint rejects unknown category', async () => {
    const pool = getPool()
    await expect(
      pool.query(
        `INSERT INTO pipeline_node_types (key, display_name, description, category, param_schema, output_schema, is_system, enabled)
         VALUES ('test_invalid', 'tmp', '', 'invalid_xyz', '{}'::jsonb, '{}'::jsonb, FALSE, FALSE)`,
      ),
    ).rejects.toThrow(/check constraint/)
  })
})

describe('schema-v60 / test_pipelines.is_system column', () => {
  it('column exists and defaults to FALSE', async () => {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT column_name, data_type, column_default
         FROM information_schema.columns
        WHERE table_name = 'test_pipelines' AND column_name = 'is_system'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].data_type).toBe('boolean')
    expect(rows[0].column_default).toMatch(/false/i)
  })
})
