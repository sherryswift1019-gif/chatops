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

// mock strategy (Sub-plan E.2):
// retryFailedRun 现在：
//   第一次调 getTestPipelineById：校验 failed node 在 pipeline.graph.nodes 中
//   第二次调 getTestPipelineById：restartRunFromNode → reloadContext → 返回 null → 静默退出
// 因此默认 mock 返回 null，各测试按需用 mockResolvedValueOnce 控制第一次返回值。
vi.mock('../../db/repositories/test-pipelines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/test-pipelines.js')>()
  return {
    ...actual,
    getTestPipelineById: vi.fn().mockResolvedValue(null),
  }
})

const { getTestPipelineById } = await import('../../db/repositories/test-pipelines.js')
const mockGetPipeline = getTestPipelineById as ReturnType<typeof vi.fn>

function makePipelineWithNode(pipelineId: number, nodeId: string, nodeName?: string) {
  return {
    id: pipelineId,
    name: 'test',
    description: '',
    stages: [],
    graph: {
      nodes: [
        { id: nodeId, name: nodeName ?? nodeId, type: 'skill', params: {}, position: { x: 0, y: 0 } },
      ],
      edges: [],
    },
    enabled: true,
    variables: {},
    productLineId: 0,
    serverRoles: null,
    triggerParams: null,
    artifactInputs: null,
    containerImage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

describe('retryFailedRun', () => {
  let pipelineId: number
  let runId: number

  beforeAll(async () => {
    await resetTestDb()
    const pipeline = await createTestPipeline({
      name: 'test-retry-pipeline',
      description: 'test',
      stages: [],
      graph: {
        nodes: [
          { id: 'spec_author', type: 'skill', name: 'Spec Author', params: {}, position: { x: 0, y: 0 } },
        ],
        edges: [],
      } as any,
      enabled: true,
      variables: {},
    })
    pipelineId = pipeline.id
  })

  beforeEach(async () => {
    mockGetPipeline.mockReset()
    mockGetPipeline.mockResolvedValue(null)

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
    // createTestRun 默认 status='running'
    await expect(retryFailedRun(runId)).rejects.toThrow(/expected 'failed'/i)
  })

  it('rejects retry when run not found', async () => {
    await expect(retryFailedRun(999999)).rejects.toThrow(/not found/i)
  })

  it('rejects retry when run has no failed stage_results', async () => {
    // status=failed 但 stage_results 为空 → "no failed stage to retry from"
    await updateTestRunStatus(runId, 'failed')
    await expect(retryFailedRun(runId)).rejects.toThrow(/no failed stage to retry from/i)
  })

  it('resets failed run to running (verify call sequence: pipeline lookup → status=running → restartRunFromNode early-exit)', async () => {
    // 设置 stage_results 含 failed stage，mock pipeline 有对应节点
    await getPool().query(
      `UPDATE test_runs SET stage_results = $1::jsonb, status = 'failed' WHERE id = $2`,
      [JSON.stringify([{ name: 'spec_author', status: 'failed', type: 'llm_author' }]), runId],
    )
    // 第一次：retryFailedRun 校验 failed node 在 graph 中
    // 第二次：restartRunFromNode → reloadContext → null → 静默退出
    mockGetPipeline
      .mockResolvedValueOnce(makePipelineWithNode(pipelineId, 'spec_author', 'Spec Author'))
      .mockResolvedValue(null)

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
      graph: {
        nodes: [
          { id: 'spec_author', type: 'skill', name: 'Spec Author', params: {}, position: { x: 0, y: 0 } },
        ],
        edges: [],
      } as any,
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
    mockGetPipeline.mockReset()
    mockGetPipeline.mockResolvedValue(null)

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
    await getPool().query(
      `UPDATE test_runs SET stage_results = $1::jsonb, status = 'failed' WHERE id = $2`,
      [JSON.stringify([{ name: 'spec_author', status: 'failed', type: 'llm_author' }]), runId],
    )
    // 第一次：retryFailedRun 校验节点；第二次：restartRunFromNode → reloadContext → null
    mockGetPipeline
      .mockResolvedValueOnce(makePipelineWithNode(pipelineId, 'spec_author', 'Spec Author'))
      .mockResolvedValue(null)

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
    // createTestRun 默认 status='running'
    const resp = await app.inject({ method: 'POST', url: `/requirements/${requirementId}/retry` })
    expect(resp.statusCode).toBe(400)
    expect(resp.json().error).toMatch(/expected 'failed'/i)
  })

  it('rejects retry after NODE_RETRY_CAP exceeded', async () => {
    // 直接写 retry_counters：模拟已 retry NODE_RETRY_CAP 次（key = node.id）
    await getPool().query(
      `UPDATE requirements SET retry_counters = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ node_retry_counts: { spec_author: NODE_RETRY_CAP } }), requirementId],
    )
    // stage_results 含 spec_author failed（stage_results.name 匹配 node.name 'Spec Author' 或 node.id）
    await getPool().query(
      `UPDATE test_runs SET stage_results = $1::jsonb, status = 'failed' WHERE id = $2`,
      [JSON.stringify([{ name: 'spec_author', status: 'failed', type: 'llm_author' }]), runId],
    )
    // 第一次调用：retryFailedRun 校验节点（stage_results.name='spec_author' → 匹配 node.id）
    mockGetPipeline
      .mockResolvedValueOnce(makePipelineWithNode(pipelineId, 'spec_author', 'Spec Author'))
      .mockResolvedValue(null)

    const resp = await app.inject({
      method: 'POST',
      url: `/requirements/${requirementId}/retry`,
      payload: {},
    })
    expect(resp.statusCode).toBe(400)
    expect(resp.json().error).toMatch(/retried \d+ times \(cap=\d+\)/i)
  })
})
