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
} from '../../db/repositories/requirements.js'

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

  it('resets failed run to running + calls resumeRun (status confirmed via DB)', async () => {
    await updateTestRunStatus(runId, 'failed')

    // resumeRun 内部 reloadContext → getTestPipelineById 返回 null（已 mock）→
    // reloadContext 返回 null → resumeRun 打 warn 后 return，不触发真实 graph 执行。
    // 验证：DB status 已被 retryFailedRun 重置为 'running'。
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
})
