/**
 * Stage log endpoints — route-level unit tests.
 *
 * Covers two endpoints under /admin/test-runs/:runId/stage/:stageIndex/:
 *   - GET /log         — one-shot, returns {filePath, content, fileType}
 *   - GET /log/stream  — SSE stream of {hello, snapshot, append, done, error}
 *
 * File naming (per executor-hooks.ts / diagnose-repair-handler.ts):
 *   <DATA_DIR>/<runId>/<NN>-script.log
 *   <DATA_DIR>/<runId>/<NN>-capability.log
 * where NN = String(stageIndex+1).padStart(2,'0').
 *
 * Priority when both files exist: capability > script (capability is the agent
 * trace, richer; script may also exist if SSH stage emitted output).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// ─── Hoisted mocks ──────────────────────────────────────────────────────────

vi.mock('../../db/repositories/test-runs.js', () => ({
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

vi.mock('../../pipeline/server-resolver.js', () => ({
  autoResolveServersByRole: vi.fn(async () => ({})),
}))

// ─── Subject imports (after mocks) ───────────────────────────────────────────

import { registerTestRunRoutes } from '../../admin/routes/test-runs.js'
import { getTestRunById } from '../../db/repositories/test-runs.js'
import type { TestRun } from '../../db/repositories/test-runs.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpRoot: string

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async (req) => {
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
    stageResults: [
      { name: 'stage-0', type: 'script', status: 'running' },
      { name: 'stage-1', type: 'capability', status: 'pending' },
    ],
    reportPath: '',
    startedAt: new Date(),
    finishedAt: null,
    errorMessage: '',
    createdAt: new Date(),
    runtimeVars: {},
    triggerParams: {},
    ...overrides,
  }
}

async function writeLog(runId: number, stageIndex: number, kind: 'script' | 'capability', content: string): Promise<string> {
  const runDir = join(tmpRoot, String(runId))
  await mkdir(runDir, { recursive: true })
  const fileName = `${String(stageIndex + 1).padStart(2, '0')}-${kind}.log`
  const fp = join(runDir, fileName)
  await writeFile(fp, content)
  return fp
}

beforeEach(async () => {
  vi.mocked(getTestRunById).mockReset()
  tmpRoot = await mkdtemp(join(tmpdir(), 'stage-log-test-'))
  process.env.TEST_DATA_DIR = tmpRoot
})

afterEach(async () => {
  delete process.env.TEST_DATA_DIR
  await rm(tmpRoot, { recursive: true, force: true })
})

// ═══ One-shot endpoint tests ═════════════════════════════════════════════════

describe('GET /admin/test-runs/:runId/stage/:stageIndex/log', () => {
  it('404 when run not found', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(null)
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/test-runs/42/stage/0/log',
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/run not found/i) })
    await app.close()
  })

  it('400 when stageIndex out of range', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun({ id: 7 }))
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/test-runs/7/stage/99/log',
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('404 when neither script.log nor capability.log exists', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun({ id: 7 }))
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/test-runs/7/stage/0/log',
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('returns script.log content when only script.log exists', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun({ id: 7 }))
    await writeLog(7, 0, 'script', '=== host1 ===\n[stdout] ok\n[exit code] 0\n')
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/test-runs/7/stage/0/log',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { fileType: string; content: string; filePath: string }
    expect(body.fileType).toBe('script')
    expect(body.content).toContain('[stdout] ok')
    expect(body.filePath).toMatch(/01-script\.log$/)
    await app.close()
  })

  it('returns capability.log content when only capability.log exists', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun({ id: 7 }))
    await writeLog(7, 1, 'capability', '[2026-04-29T12:00:00Z] [assistant] hello\n')
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/test-runs/7/stage/1/log',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { fileType: string; content: string }
    expect(body.fileType).toBe('capability')
    expect(body.content).toContain('hello')
    await app.close()
  })

  it('priority: capability > script when both exist', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(makeRun({ id: 7 }))
    await writeLog(7, 0, 'script', 'script body\n')
    await writeLog(7, 0, 'capability', 'capability body\n')
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/test-runs/7/stage/0/log',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { fileType: string; content: string }
    expect(body.fileType).toBe('capability')
    expect(body.content).toContain('capability body')
    await app.close()
  })
})

// ═══ SSE stream endpoint tests ═══════════════════════════════════════════════

/**
 * Drain at most `maxMs` of SSE chunks from the inject stream into a string,
 * then close. Inject's payloadAsStream gives us a Node stream.
 */
async function drainSSE(app: FastifyInstance, url: string, maxMs: number): Promise<string> {
  const res = await app.inject({ method: 'GET', url, payloadAsStream: true })
  const chunks: Buffer[] = []
  const stream = res.stream()
  return await new Promise<string>((resolve) => {
    const timer = setTimeout(() => {
      stream.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }, maxMs)
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    stream.on('error', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

describe('GET /admin/test-runs/:runId/stage/:stageIndex/log/stream', () => {
  it('404 when run not found', async () => {
    vi.mocked(getTestRunById).mockResolvedValueOnce(null)
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/admin/test-runs/42/stage/0/log/stream',
    })
    expect(res.statusCode).toBe(404)
    await app.close()
  })

  it('emits hello + snapshot + done when stage already terminal and file exists', async () => {
    // Stage 0 already success → done event must fire after snapshot.
    const run = makeRun({
      id: 9,
      status: 'success',
      stageResults: [
        { name: 'stage-0', type: 'script', status: 'success', output: 'ok' },
      ],
    })
    vi.mocked(getTestRunById).mockResolvedValue(run)
    await writeLog(9, 0, 'script', 'final content\n')

    const app = await buildApp()
    const body = await drainSSE(app, '/admin/test-runs/9/stage/0/log/stream', 1500)

    expect(body).toMatch(/event: hello/)
    expect(body).toMatch(/event: snapshot/)
    expect(body).toContain('final content')
    expect(body).toMatch(/event: done/)
    await app.close()
  })

  it('emits hello with fileType=null when no log yet, and waits (no immediate done)', async () => {
    const run = makeRun({
      id: 11,
      status: 'running',
      stageResults: [{ name: 'stage-0', type: 'script', status: 'running' }],
    })
    vi.mocked(getTestRunById).mockResolvedValue(run)

    const app = await buildApp()
    const body = await drainSSE(app, '/admin/test-runs/11/stage/0/log/stream', 600)

    expect(body).toMatch(/event: hello/)
    // Should NOT have done while stage still running and file missing.
    expect(body).not.toMatch(/event: done/)
    await app.close()
  })

  it('emits append when file grows after connect', async () => {
    const run = makeRun({
      id: 13,
      status: 'running',
      stageResults: [{ name: 'stage-0', type: 'script', status: 'running' }],
    })
    vi.mocked(getTestRunById).mockResolvedValue(run)
    await writeLog(13, 0, 'script', 'line1\n')

    const app = await buildApp()
    // Open stream, then append after a delay, then drain.
    const drainP = drainSSE(app, '/admin/test-runs/13/stage/0/log/stream', 2000)
    await new Promise((r) => setTimeout(r, 250))
    const fp = join(tmpRoot, '13', '01-script.log')
    await appendFile(fp, 'line2-new\n')

    const body = await drainP
    expect(body).toMatch(/event: snapshot/)
    expect(body).toContain('line1')
    // append event should carry the new chunk
    expect(body).toMatch(/event: append/)
    expect(body).toContain('line2-new')
    await app.close()
  })
})
