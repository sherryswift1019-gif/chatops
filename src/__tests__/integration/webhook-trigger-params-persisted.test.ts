import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import { buildAdminTestApp } from '../helpers/admin-app.js'
import { registerWebhookRoute } from '../../pipeline/webhook-router.js'
import { createPipelineWebhook } from '../../db/repositories/pipeline-webhooks-repo.js'

/**
 * Regression: webhook → runPipeline → createTestRun must persist
 * triggerParams (the request body) into test_runs.trigger_params.
 *
 * Bug history: executor.ts built `triggerParams` locally and forwarded it to
 * `startRun(...)` (so runtime context worked) but did NOT pass it into
 * `createTestRun({...})` — the DB row was always `{}`. This made it impossible
 * to inspect what actually triggered a run after the fact.
 *
 * We mock `startRun` from graph-runner so runPipeline returns once the row is
 * created (no real graph execution needed); the assertion targets the persisted
 * column directly.
 */

vi.mock('../../pipeline/graph-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../pipeline/graph-runner.js')>(
    '../../pipeline/graph-runner.js',
  )
  return {
    ...actual,
    startRun: vi.fn().mockResolvedValue({
      runId: 0,
      pipelineId: 0,
      status: 'running',
      durationMs: 0,
      stageResults: [],
    }),
    registerRunMeta: vi.fn(),
    purgeRunMeta: vi.fn(),
  }
})

async function insertPipelineWithParamSchema(): Promise<number> {
  const paramSchema = {
    type: 'object',
    properties: {
      branch: { type: 'string' },
      env: { type: 'string' },
      pam_address: { type: 'string' },
    },
    required: ['branch', 'env', 'pam_address'],
  }
  const { rows } = await getPool().query(
    `INSERT INTO test_pipelines (name, description, stages, enabled, param_schema)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    ['wh-trigger-params', '', JSON.stringify([]), true, JSON.stringify(paramSchema)],
  )
  return rows[0].id as number
}

describe('webhook trigger persists trigger_params', () => {
  let app: Awaited<ReturnType<typeof buildAdminTestApp>>

  beforeEach(async () => {
    await resetTestDb()
    app = await buildAdminTestApp(async (a) => {
      await registerWebhookRoute(a)
    })
  })

  afterEach(async () => {
    await app.close()
    vi.clearAllMocks()
  })

  it('webhook body fields land in test_runs.trigger_params', async () => {
    const pipelineId = await insertPipelineWithParamSchema()
    const wh = await createPipelineWebhook({
      pipelineId,
      name: 'pam-proxy-deploy',
      createdBy: 'test',
    })

    const payload = {
      branch: 'master',
      env: 'test',
      pam_address: 'https://pam-test.example.com',
    }

    const res = await app.inject({
      method: 'POST',
      url: `/webhook/pipeline/${wh.token}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })

    expect(res.statusCode).toBe(202)
    const { runId } = res.json<{ runId: number }>()
    expect(runId).toBeGreaterThan(0)

    const { rows } = await getPool().query(
      'SELECT trigger_params FROM test_runs WHERE id = $1',
      [runId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].trigger_params).toEqual(payload)
  })
})
