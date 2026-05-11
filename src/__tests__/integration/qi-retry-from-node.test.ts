import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { resetTestDb } from '../helpers/db.js'
import {
  createTestRun,
  updateTestRunStatus,
  getTestRunById,
} from '../../db/repositories/test-runs.js'
import { createTestPipeline } from '../../db/repositories/test-pipelines.js'
import { retryFromNode } from '../../pipeline/graph-runner.js'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerRequirementsRoutes } from '../../admin/routes/requirements.js'
import {
  createRequirement,
  setPipelineRunId,
  NODE_RETRY_CAP,
} from '../../db/repositories/requirements.js'
import { getPool } from '../../db/client.js'

// mock strategy（Sub-plan E.2 更新）：
// retryFromNode 内部：
//   第一次调 getTestPipelineById：校验 fromNodeId 在 pipeline.graph.nodes 中
//   第二次调 getTestPipelineById：restartRunFromNode → reloadContext → 返回 null → 静默退出
// 通过 mockResolvedValueOnce 按顺序控制每次调用的返回值。
vi.mock('../../db/repositories/test-pipelines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/repositories/test-pipelines.js')>()
  return {
    ...actual,
    getTestPipelineById: vi.fn().mockResolvedValue(null),
  }
})

const { getTestPipelineById } = await import('../../db/repositories/test-pipelines.js')
const mockGetPipeline = getTestPipelineById as ReturnType<typeof vi.fn>

// 有效 pipeline 结构（含 graph.nodes）
// 节点无 name 字段 → nodeStageResultName 回退用 id；stage_results.name 与 id 一致，保留测试 coverage
function makeValidPipeline(pipelineId: number) {
  return {
    id: pipelineId,
    name: 'test',
    description: '',
    stages: [],
    graph: {
      nodes: [
        { id: 'node-a', type: 'skill', params: {}, position: { x: 0, y: 0 } },
        { id: 'node-b', type: 'skill', params: {}, position: { x: 0, y: 0 } },
        { id: 'node-c', type: 'skill', params: {}, position: { x: 0, y: 0 } },
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

describe('retryFromNode', () => {
  let pipelineId: number
  let runId: number

  beforeAll(async () => {
    await resetTestDb()
    const pipeline = await createTestPipeline({
      name: 'test-retry-from-node-pipeline',
      description: 'test',
      stages: [],
      graph: {
        nodes: [
          { id: 'node-a', type: 'skill', params: {}, position: { x: 0, y: 0 } },
          { id: 'node-b', type: 'skill', params: {}, position: { x: 0, y: 0 } },
          { id: 'node-c', type: 'skill', params: {}, position: { x: 0, y: 0 } },
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
    // 默认：第一次调用返回 valid pipeline（校验 fromNodeId 用），第二次返回 null（reloadContext 用）
    mockGetPipeline
      .mockResolvedValueOnce(makeValidPipeline(pipelineId))
      .mockResolvedValue(null)

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

  it('rejects when fromNodeId not found in pipeline graph', async () => {
    await updateTestRunStatus(runId, 'failed')
    await expect(retryFromNode(runId, 'nonexistent-node')).rejects.toThrow(
      /not found in pipeline graph/i,
    )
  })

  it('rejects when run status is not failed', async () => {
    // createTestRun 默认 status='running'
    await expect(retryFromNode(runId, 'node-b')).rejects.toThrow(/expected 'failed'/i)
  })

  it('resets status to running and calls restartRunFromNode (no stage_results truncation)', async () => {
    // Sub-plan E.2: retryFromNode 不再截断 stage_results（reducer mergeStageResults 自动 overwrite）
    // 验证可观测 DB 副作用：status='running'（restartRunFromNode 因 reloadContext 返 null 而静默）
    await getPool().query(
      `UPDATE test_runs SET stage_results = $1::jsonb, status = 'failed' WHERE id = $2`,
      [
        JSON.stringify([
          { name: 'node-a', type: 'skill', status: 'success' },
          { name: 'node-b', type: 'skill', status: 'failed' },
          { name: 'node-c', type: 'skill', status: 'pending' },
        ]),
        runId,
      ],
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await retryFromNode(runId, 'node-b')
    } finally {
      warnSpy.mockRestore()
    }

    const after = await getTestRunById(runId)
    expect(after?.status).toBe('running')
    // stage_results 未截断（reducer 覆盖由 LangGraph re-run 完成）
    expect(after?.stageResults).toHaveLength(3)
  })

  it('rejects when node retry cap exceeded', async () => {
    await updateTestRunStatus(runId, 'failed')

    const req = await createRequirement({
      title: 'cap-test-req',
      rawInput: 'x',
      gitlabProject: 'g/p',
      source: 'web',
    })
    await setPipelineRunId(req.id, runId)

    // 写入 retry_counters：node-b 已达 cap
    await getPool().query(
      `UPDATE requirements SET retry_counters = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ node_retry_counts: { 'node-b': NODE_RETRY_CAP } }), req.id],
    )

    await expect(retryFromNode(runId, 'node-b')).rejects.toThrow(
      /retried \d+ times \(cap=\d+\)/i,
    )
  })

  it('increments retry count for fromNode', async () => {
    await getPool().query(
      `UPDATE test_runs SET stage_results = $1::jsonb, status = 'failed' WHERE id = $2`,
      [
        JSON.stringify([
          { name: 'node-a', type: 'skill', status: 'success' },
          { name: 'node-b', type: 'skill', status: 'failed' },
        ]),
        runId,
      ],
    )

    const req = await createRequirement({
      title: 'increment-test-req',
      rawInput: 'x',
      gitlabProject: 'g/p',
      source: 'web',
    })
    await setPipelineRunId(req.id, runId)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await retryFromNode(runId, 'node-b')
    } finally {
      warnSpy.mockRestore()
    }

    const row = await getPool().query(
      `SELECT retry_counters FROM requirements WHERE id = $1`,
      [req.id],
    )
    const counters = row.rows[0].retry_counters as { node_retry_counts: Record<string, number> }
    expect(counters.node_retry_counts?.['node-b']).toBe(1)
  })

  it('matches by display name (stage_results.name) too', async () => {
    // pipeline mock 含 node.id='spec_ai_review' + node.name='Spec AI Review'
    mockGetPipeline.mockReset()
    mockGetPipeline
      .mockResolvedValueOnce({
        id: pipelineId,
        name: 'test',
        description: '',
        stages: [],
        graph: {
          nodes: [
            { id: 'spec_author', type: 'skill', name: 'Spec Author', params: {}, position: { x: 0, y: 0 } },
            { id: 'spec_ai_review', type: 'skill', name: 'Spec AI Review', params: {}, position: { x: 0, y: 0 } },
            { id: 'plan_author', type: 'skill', name: 'Plan Author', params: {}, position: { x: 0, y: 0 } },
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
      })
      .mockResolvedValue(null)

    // stage_results 用 display name（真实场景：nodeStageResultName 优先返回 node.name）
    await getPool().query(
      `UPDATE test_runs SET stage_results = $1::jsonb, status = 'failed' WHERE id = $2`,
      [
        JSON.stringify([
          { name: 'Spec Author', status: 'success', type: 'llm_author' },
          { name: 'Spec AI Review', status: 'success', type: 'llm_review' },
          { name: 'Plan Author', status: 'failed', type: 'llm_author', error: 'boom' },
        ]),
        runId,
      ],
    )

    // 用 display name 调用（前端 timeline 传 sr.name）
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await retryFromNode(runId, 'Spec AI Review')
    } finally {
      warnSpy.mockRestore()
    }

    const after = await getTestRunById(runId)
    expect(after?.status).toBe('running')
    // Sub-plan E.2: 不再截断 stage_results，reducer 按 name 覆盖
    expect(after?.stageResults).toHaveLength(3)
  })
})

describe('POST /requirements/:id/retry-from-node', () => {
  let app: FastifyInstance
  let pipelineId: number
  let runId: number
  let requirementId: number

  beforeAll(async () => {
    const pipeline = await createTestPipeline({
      name: 'test-retry-from-node-route-pipeline',
      description: 'test',
      stages: [],
      graph: {
        nodes: [
          { id: 'node-x', type: 'skill', params: {}, position: { x: 0, y: 0 } },
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
    // 第一次调用（retryFromNode 校验用）返回 valid pipeline；第二次（reloadContext）返回 null
    mockGetPipeline
      .mockResolvedValueOnce({
        ...makeValidPipeline(pipelineId),
        graph: {
          nodes: [
            { id: 'node-x', type: 'skill', params: {}, position: { x: 0, y: 0 } },
          ],
          edges: [],
        },
      })
      .mockResolvedValue(null)

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
      title: 'test retry-from-node route',
      rawInput: 'x',
      gitlabProject: 'g/p',
      source: 'web',
    })
    requirementId = req.id
    await setPipelineRunId(requirementId, runId)
  })

  it('returns 400 when fromNodeId missing', async () => {
    await updateTestRunStatus(runId, 'failed')
    const resp = await app.inject({
      method: 'POST',
      url: `/requirements/${requirementId}/retry-from-node`,
      payload: {},
    })
    expect(resp.statusCode).toBe(400)
    expect(resp.json().error).toMatch(/fromNodeId is required/i)
  })

  it('returns 202 + retriedFromNode + async:true on success', async () => {
    await getPool().query(
      `UPDATE test_runs SET stage_results = $1::jsonb, status = 'failed' WHERE id = $2`,
      [
        JSON.stringify([{ name: 'node-x', type: 'skill', status: 'failed' }]),
        runId,
      ],
    )

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let resp: Awaited<ReturnType<typeof app.inject>>
    try {
      resp = await app.inject({
        method: 'POST',
        url: `/requirements/${requirementId}/retry-from-node`,
        payload: { fromNodeId: 'node-x' },
      })
    } finally {
      warnSpy.mockRestore()
    }

    // Sub-plan E.2 final review: retry helper fire-and-forget → endpoint 202 instead of 200
    expect(resp!.statusCode).toBe(202)
    expect(resp!.json()).toMatchObject({ ok: true, retriedFromNode: 'node-x', async: true })

    const after = await getTestRunById(runId)
    expect(after?.status).toBe('running')
  })

  it('returns 400 with node-not-in-graph error when fromNodeId does not exist', async () => {
    await updateTestRunStatus(runId, 'failed')

    // 覆盖 mock：让 getTestPipelineById 返回含 node-x 的 pipeline，但 fromNodeId 传不存在的值
    mockGetPipeline.mockReset()
    mockGetPipeline
      .mockResolvedValueOnce({
        ...makeValidPipeline(pipelineId),
        graph: {
          nodes: [
            { id: 'node-x', type: 'skill', params: {}, position: { x: 0, y: 0 } },
          ],
          edges: [],
        },
      })
      .mockResolvedValue(null)

    const resp = await app.inject({
      method: 'POST',
      url: `/requirements/${requirementId}/retry-from-node`,
      payload: { fromNodeId: 'nonexistent-node' },
    })
    expect(resp.statusCode).toBe(400)
    expect(resp.json().error).toMatch(/not found in pipeline graph/i)
  })
})
