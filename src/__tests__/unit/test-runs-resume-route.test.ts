/**
 * POST /admin/test-runs/:id/resume — route-level unit tests.
 *
 * Mocks the repositories and graph-runner helpers so only the route logic
 * (body validation, 404/409/400 branches, Command dispatch) is exercised.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Command } from '@langchain/langgraph'

// --- Hoisted mocks ----------------------------------------------------------

vi.mock('../../db/repositories/test-runs.js', () => ({
  // listTestRuns and updateTestRunStage / finishTestRun aren't used by the
  // resume route, but other routes in the same file import them. Provide
  // lightweight stubs so the module import succeeds.
  listTestRuns: vi.fn(async () => ({ data: [], total: 0 })),
  getTestRunById: vi.fn(),
  createTestRun: vi.fn(),
  updateTestRunStage: vi.fn(),
  finishTestRun: vi.fn(),
}))

vi.mock('../../db/repositories/dingtalk-users.js', () => ({
  getDingTalkUserById: vi.fn(async () => null),
  getDingTalkUsersByIds: vi.fn(async () => new Map()),
}))

vi.mock('../../pipeline/executor.js', () => ({
  runPipeline: vi.fn(async () => 1),
  manualTrigger: (args: any) => ({ type: 'manual', ...args }),
  apiTrigger: (args: any) => ({ type: 'api', ...args }),
}))

vi.mock('../../pipeline/graph-runner.js', () => ({
  getPendingInterrupt: vi.fn(),
  resumeRun: vi.fn(async () => {}),
}))

// Re-exported interrupt type constants — keep them real so route comparisons
// match the helper's returned `type` field.
vi.mock('../../pipeline/graph-builder.js', async () => {
  const actual = await vi.importActual<typeof import('../../pipeline/graph-builder.js')>(
    '../../pipeline/graph-builder.js',
  )
  return {
    ...actual,
    APPROVAL_INTERRUPT: 'approval',
    WEBHOOK_INTERRUPT: 'webhook',
  }
})

// --- Subject imports (after mocks are registered) --------------------------

import { registerTestRunRoutes } from '../../admin/routes/test-runs.js'
import { getTestRunById } from '../../db/repositories/test-runs.js'
import { getPendingInterrupt, resumeRun } from '../../pipeline/graph-runner.js'
import type { TestRun } from '../../db/repositories/test-runs.js'

// --- Helpers ----------------------------------------------------------------

/**
 * Build a Fastify instance with registerTestRunRoutes mounted under /admin,
 * and a shim `req.session.get('username')` so the route's audit-log call
 * doesn't throw. We don't exercise auth here — just the handler logic.
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async (req) => {
    // Minimal session stub — only .get('username') is touched by the route.
    ;(req as unknown as { session: { get: (k: string) => string | undefined } }).session = {
      get: (k: string) => (k === 'username' ? 'tester' : undefined),
    }
  })
  await app.register(async (scoped) => {
    await registerTestRunRoutes(scoped)
  }, { prefix: '/admin' })
  await app.ready()
  return app
}

function makeRun(overrides: Partial<TestRun> = {}): TestRun {
  return {
    id: 1,
    pipelineId: 10,
    triggerType: 'manual',
    triggeredBy: 'alice',
    status: 'running',
    servers: {},
    currentStage: 0,
    stageResults: [],
    reportPath: '',
    startedAt: new Date(),
    finishedAt: null,
    errorMessage: '',
    createdAt: new Date(),
    runtimeVars: {},
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(getTestRunById).mockReset()
  vi.mocked(getPendingInterrupt).mockReset()
  vi.mocked(resumeRun).mockReset()
  vi.mocked(resumeRun).mockResolvedValue(undefined)
})

// --- Tests ------------------------------------------------------------------

describe('POST /admin/test-runs/:id/resume', () => {
  it('404 when run not found', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(null)
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/test-runs/42/resume',
      payload: { approval: 'approved' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'run not found' })
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled()
    await app.close()
  })

  it('409 when run already finished', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun({ status: 'success' }))
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/test-runs/1/resume',
      payload: { approval: 'approved' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'run already success' })
    expect(vi.mocked(getPendingInterrupt)).not.toHaveBeenCalled()
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled()
    await app.close()
  })

  it('409 with "not started yet" when run is still pending', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun({ status: 'pending' }))
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/test-runs/1/resume',
      payload: { approval: 'approved' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'run not started yet' })
    expect(vi.mocked(getPendingInterrupt)).not.toHaveBeenCalled()
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled()
    await app.close()
  })

  it('409 when running but no pending interrupt', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun())
    vi.mocked(getPendingInterrupt).mockResolvedValueOnce(null)
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/test-runs/1/resume',
      payload: { approval: 'approved' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'no pending interrupt to resume' })
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled()
    await app.close()
  })

  it('200 approval approved → resumeRun called with Command({resume: "approved"})', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun())
    vi.mocked(getPendingInterrupt).mockResolvedValueOnce({
      type: 'approval',
      stageIndex: 0,
      approverIds: ['alice'],
      description: 'deploy prod',
    })
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/test-runs/1/resume',
      payload: { approval: 'approved' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, resumed: true, interruptType: 'approval' })
    expect(vi.mocked(resumeRun)).toHaveBeenCalledTimes(1)
    const [runIdArg, cmdArg] = vi.mocked(resumeRun).mock.calls[0]
    expect(runIdArg).toBe(1)
    expect(cmdArg).toBeInstanceOf(Command)
    expect((cmdArg as unknown as { resume: unknown }).resume).toBe('approved')
    await app.close()
  })

  it('400 when approval pending but body missing approval', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun())
    vi.mocked(getPendingInterrupt).mockResolvedValueOnce({
      type: 'approval',
      stageIndex: 0,
      approverIds: ['alice'],
      description: 'deploy prod',
    })
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/test-runs/1/resume',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/approval field required/)
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled()
    await app.close()
  })

  it('200 webhook with data → resumeRun called with Command({resume: {data: ...}})', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun())
    vi.mocked(getPendingInterrupt).mockResolvedValueOnce({
      type: 'webhook',
      stageIndex: 2,
      tag: 'deploy:ok',
    })
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/test-runs/1/resume',
      payload: { webhookData: { foo: 'bar' } },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, resumed: true, interruptType: 'webhook' })
    expect(vi.mocked(resumeRun)).toHaveBeenCalledTimes(1)
    const [, cmdArg] = vi.mocked(resumeRun).mock.calls[0]
    expect(cmdArg).toBeInstanceOf(Command)
    expect((cmdArg as unknown as { resume: unknown }).resume).toEqual({ data: { foo: 'bar' } })
    await app.close()
  })

  it('200 webhook with timeout → resumeRun called with Command({resume: {timeout: true}})', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun())
    vi.mocked(getPendingInterrupt).mockResolvedValueOnce({
      type: 'webhook',
      stageIndex: 2,
      tag: 'deploy:ok',
    })
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/test-runs/1/resume',
      payload: { webhookTimeout: true },
    })
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(resumeRun)).toHaveBeenCalledTimes(1)
    const [, cmdArg] = vi.mocked(resumeRun).mock.calls[0]
    expect(cmdArg).toBeInstanceOf(Command)
    expect((cmdArg as unknown as { resume: unknown }).resume).toEqual({ timeout: true })
    await app.close()
  })

  it('400 when webhook pending but body empty', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun())
    vi.mocked(getPendingInterrupt).mockResolvedValueOnce({
      type: 'webhook',
      stageIndex: 2,
      tag: 'deploy:ok',
    })
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/test-runs/1/resume',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/exactly one of webhookData or webhookTimeout/)
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled()
    await app.close()
  })

  it('400 when webhook pending but body has both webhookData and webhookTimeout', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun())
    vi.mocked(getPendingInterrupt).mockResolvedValueOnce({
      type: 'webhook',
      stageIndex: 2,
      tag: 'deploy:ok',
    })
    const app = await buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/admin/test-runs/1/resume',
      payload: { webhookData: { a: 1 }, webhookTimeout: true },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/exactly one of webhookData or webhookTimeout/)
    expect(vi.mocked(resumeRun)).not.toHaveBeenCalled()
    await app.close()
  })
})
