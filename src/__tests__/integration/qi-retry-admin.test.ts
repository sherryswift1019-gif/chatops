import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetTestDb } from '../helpers/db.js'
import {
  createTestRun,
  updateTestRunStatus,
  getTestRunById,
} from '../../db/repositories/test-runs.js'
import { createTestPipeline } from '../../db/repositories/test-pipelines.js'
import { retryFailedRun } from '../../pipeline/graph-runner.js'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerRequirementsRoutes } from '../../admin/routes/requirements.js'
import {
  createRequirement,
  setPipelineRunId,
  NODE_RETRY_CAP,
} from '../../db/repositories/requirements.js'
import { getPool } from '../../db/client.js'

// getTestPipelineById mock：让 retryFailedRun 内部 reloadContext 在调 streamGraph 之前 return null，
// 避免触发真实 LangGraph 执行（测试库无真实 checkpoint，会抛 EmptyInputError）。
// createTestPipeline 走 actual（写 DB 用），getTestPipelineById 默认 vi.fn() 可按测试按需控制。
vi.mock('../../db/repositories/test-pipelines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/test-pipelines.js')>()
  return {
    ...actual,
    getTestPipelineById: vi.fn().mockResolvedValue(null),
  }
})

describe('retryFailedRun', () => {
  let pipelineId: number
  let runId: number

  beforeAll(async () => {
    await resetTestDb()
    const pipeline = await createTestPipeline({
      name: 'test-retry-pipeline',
      description: 'test',
      stages: [],
      graph: { nodes: [], edges: [] } as any,
      enabled: true,
      variables: {},
    })
    pipelineId = pipeline.id
  })

  beforeEach(async () => {
    const run = await createTestRun({
      pipelineId,
      triggerType: 'manual',
      triggeredBy: 'test',
      servers: {},
      triggerParams: {},
      runtimeVars: {},
    })
    runId = run.id
  })

  it('rejects retry when run is not failed', async () => {
    // createTestRun 默认 status='running'，直接测
    await expect(retryFailedRun(runId)).rejects.toThrow(/expected 'failed'/i)
  })

  it('rejects retry when run not found', async () => {
    await expect(retryFailedRun(999999)).rejects.toThrow(/not found/i)
  })

  it('resets failed run to running (smoke: restartRunFromCheckpoint called but not asserted due to ESM binding)', async () => {
    // 注：此测试只 verify 可观测的 DB 副作用（status='running'）。
    // retryFailedRun 内部确实调 restartRunFromCheckpoint，但 ESM same-module binding 让
    // vi.mock('graph-runner.js') 无法拦截，所以 mock 改为让 reloadContext 提前
    // return null（mock getTestPipelineById 返回 null），restartRunFromCheckpoint 静默 return。
    // 真实 LangGraph 行为（"在 failed 节点 checkpoint 处 restart 是否真重试该节点"）
    // 留手动 smoke verify。Plan §Risks 已记录。
    await updateTestRunStatus(runId, 'failed')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await retryFailedRun(runId)
    } finally {
      warnSpy.mockRestore()
    }

    const after = await getTestRunById(runId)
    expect(after?.status).toBe('running')
  })
})

describe('POST /requirements/:id/retry', () => {
  let app: FastifyInstance
  let pipelineId: number
  let runId: number
  let requirementId: number

  beforeAll(async () => {
    const pipeline = await createTestPipeline({
      name: 'test-retry-route-pipeline',
      description: 'test',
      stages: [],
      graph: { nodes: [], edges: [] } as any,
      enabled: true,
      variables: {},
    })
    pipelineId = pipeline.id
    app = await buildAdminTestApp(async (a) => {
      await registerRequirementsRoutes(a)
    })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(async () => {
    const run = await createTestRun({
      pipelineId,
      triggerType: 'manual',
      triggeredBy: 'test',
      servers: {},
      triggerParams: {},
      runtimeVars: {},
    })
    runId = run.id

    const req = await createRequirement({
      title: 'test retry route',
      rawInput: 'x',
      gitlabProject: 'g/p',
      baseBranch: 'main',
      source: 'web',
    })
    requirementId = req.id
    await setPipelineRunId(requirementId, runId)
  })

  it('returns 404 when requirement not found', async () => {
    const resp = await app.inject({ method: 'POST', url: '/requirements/999999/retry' })
    expect(resp.statusCode).toBe(404)
    expect(resp.json().error).toMatch(/not found/i)
  })

  it('returns 400 when requirement has no pipelineRunId', async () => {
    const orphan = await createRequirement({
      title: 'orphan',
      rawInput: 'x',
      gitlabProject: 'g/p',
      source: 'web',
    })
    const resp = await app.inject({ method: 'POST', url: `/requirements/${orphan.id}/retry` })
    expect(resp.statusCode).toBe(400)
    expect(resp.json().error).toMatch(/no pipelineRunId/i)
  })

  it('returns 200 + retried:true on valid failed requirement', async () => {
    await updateTestRunStatus(runId, 'failed')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resp: Awaited<ReturnType<typeof app.inject>>
    try {
      resp = await app.inject({ method: 'POST', url: `/requirements/${requirementId}/retry` })
    } finally {
      warnSpy.mockRestore()
    }

    expect(resp!.statusCode).toBe(200)
    expect(resp!.json()).toMatchObject({ ok: true, retried: true })

    const after = await getTestRunById(runId)
    expect(after?.status).toBe('running')
  })

  it('returns 400 when run is not failed', async () => {
    // createTestRun 默认 status='running'，直接测
    const resp = await app.inject({ method: 'POST', url: `/requirements/${requirementId}/retry` })
    expect(resp.statusCode).toBe(400)
    expect(resp.json().error).toMatch(/expected 'failed'/i)
  })

  it('rejects retry after NODE_RETRY_CAP exceeded', async () => {
    // 直接写 retry_counters：模拟已 retry NODE_RETRY_CAP 次
    await getPool().query(
      `UPDATE requirements SET retry_counters = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ node_retry_counts: { spec_author: NODE_RETRY_CAP } }), requirementId],
    )
    // 模拟 stage_results 含 spec_author failed
    await getPool().query(
      `UPDATE test_runs SET stage_results = $1::jsonb, status = 'failed' WHERE id = $2`,
      [JSON.stringify([{ name: 'spec_author', status: 'failed', type: 'llm_author' }]), runId],
    )

    const resp = await app.inject({
      method: 'POST',
      url: `/requirements/${requirementId}/retry`,
      payload: {},
    })
    expect(resp.statusCode).toBe(400)
    expect(resp.json().error).toMatch(/retried \d+ times \(cap=\d+\)/i)
  })
})
