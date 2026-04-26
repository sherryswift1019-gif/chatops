/**
 * Integration: IM → Coordinator → Pipeline → im_input → Resume 端到端
 *
 * 验证最初讨论里的核心诉求："IM 触发的操作走 Pipeline，遇到参数错能澄清"。
 *
 * 步骤：
 *   1. seed 一条只有 im_input stage 的 pipeline + 绑定它的 capability
 *   2. 注册内存 IM sender 收集推送
 *   3. 调 triggerCapability（= IM 入口）→ 返回 runId
 *   4. 等 graph 进入 interrupt → 验证 im-router 有 waiter + sender 收到 prompt
 *   5. resumeFromImInput 填完整参数 → 等 graph 完成
 *   6. 验证 waiter 清理 + test_runs.status='success'
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mkdir } from 'fs/promises'
import { resetTestDb } from '../helpers/db.js'
import { getPool } from '../../db/client.js'
import { triggerCapability } from '../../agent/coordinator.js'
import {
  findImInputWaiter,
  resumeFromImInput,
} from '../../pipeline/graph-runner.js'
import {
  registerImSender,
  __clearImSendersForTest,
} from '../../pipeline/im-notifier.js'
import { getTestRunById } from '../../db/repositories/test-runs.js'

const TMP_DATA_DIR = process.env.TEST_DATA_DIR ?? '/tmp/chatops-test-runs'

async function seedImOnlyPipeline(): Promise<{
  pipelineId: number
  capabilityKey: string
}> {
  const pool = getPool()
  const plRes = await pool.query(
    `INSERT INTO product_lines (name, display_name) VALUES ('im-it-pl', 'IM-IT')
     ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
  )
  const productLineId = plRes.rows[0].id as number

  const pipeRes = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, enabled)
     VALUES ($1, 'im-it-pipeline', '', $2::jsonb, '{}'::jsonb, true) RETURNING id`,
    [
      productLineId,
      JSON.stringify([
        {
          name: '参数澄清',
          stageType: 'im_input',
          targetRoles: [],
          parallel: false,
          timeoutSeconds: 60,
          retryCount: 0,
          onFailure: 'stop',
          imInputConfig: {
            prompt: '请告诉我 project / env / branch',
            paramSchema: {
              type: 'object',
              required: ['project', 'env', 'branch'],
              properties: {
                project: { type: 'string', title: '模块' },
                env:     { type: 'string', title: '环境', enum: ['dev', 'staging', 'prod'] },
                branch:  { type: 'string', title: '分支' },
              },
            },
            timeoutSeconds: 60,
          },
        },
      ]),
    ],
  )
  const pipelineId = pipeRes.rows[0].id as number

  const capKey = 'im-it-cap'
  await pool.query(
    `INSERT INTO capabilities (key, display_name, description, tool_names)
     VALUES ($1, 'IM IT', '', '[]')
     ON CONFLICT (key) DO NOTHING`,
    [capKey],
  )
  // phase 2 cleanup: pipeline 绑定从 capability.default_pipeline_id 迁到 im_triggers.pipeline_id
  await pool.query(
    `INSERT INTO im_triggers (key, display_name, description, pipeline_id)
     VALUES ($1, 'IM IT', '', $2)
     ON CONFLICT (key) DO UPDATE SET pipeline_id = EXCLUDED.pipeline_id`,
    [capKey, pipelineId],
  )

  return { pipelineId, capabilityKey: capKey }
}

async function waitUntil<T>(
  fn: () => T | Promise<T>,
  predicate: (v: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs
  const interval = opts.intervalMs ?? 50
  let last = await fn()
  while (!predicate(last)) {
    if (Date.now() > deadline) throw new Error(`waitUntil timeout; last value: ${JSON.stringify(last)}`)
    await new Promise(r => setTimeout(r, interval))
    last = await fn()
  }
  return last
}

describe('Integration: IM → Coordinator → Pipeline → im_input', () => {
  const received: Array<{ groupId: string; text: string }> = []
  let capabilityKey: string

  beforeAll(async () => {
    await mkdir(TMP_DATA_DIR, { recursive: true })
    await resetTestDb()
    const s = await seedImOnlyPipeline()
    capabilityKey = s.capabilityKey
  })

  beforeEach(() => {
    received.length = 0
    __clearImSendersForTest()
    registerImSender('test', async (groupId, text) => {
      received.push({ groupId, text })
    })
  })

  it('triggerCapability → pipeline 进入 im_input interrupt + IM sender 收到 prompt', async () => {
    const result = await triggerCapability({
      capabilityKey,
      context: {
        taskId: 't1', groupId: 'g-it-1', platform: 'test',
        initiatorId: 'user1', initiatorRole: 'ops',
      },
    })
    expect(result.success).toBe(true)
    const data = result.data as { runId: number }
    expect(typeof data.runId).toBe('number')

    // 等 graph 进入 interrupt（runPipeline 的 startRun 是 fire-and-forget）
    const waiter = await waitUntil(
      () => findImInputWaiter('test', 'g-it-1'),
      v => v !== null,
      { timeoutMs: 5000 },
    )
    expect(waiter).toEqual({ runId: data.runId, stageIndex: 0 })

    expect(received.some(m => m.groupId === 'g-it-1' && /project|模块/.test(m.text))).toBe(true)
  }, 10000)

  it('resumeFromImInput 填完整参数 → stage 成功 + waiter 清理 + run 完成', async () => {
    const result = await triggerCapability({
      capabilityKey,
      context: {
        taskId: 't2', groupId: 'g-it-2', platform: 'test',
        initiatorId: 'user2', initiatorRole: 'ops',
      },
    })
    const runId = (result.data as { runId: number }).runId

    // 等到 interrupt 挂起
    const waiter = await waitUntil(
      () => findImInputWaiter('test', 'g-it-2'),
      v => v !== null,
      { timeoutMs: 5000 },
    )

    // resume
    const handled = await resumeFromImInput(
      waiter!.runId,
      waiter!.stageIndex,
      'project=demo env=dev branch=main',
    )
    expect(handled).toBe(true)

    // waiter 应被清掉
    expect(findImInputWaiter('test', 'g-it-2')).toBeNull()

    // run 终态应为 success（只有一个 stage，resume 后立刻 END）
    const finalRun = await waitUntil(
      () => getTestRunById(runId),
      r => r?.status === 'success' || r?.status === 'failed',
      { timeoutMs: 10000, intervalMs: 100 },
    )
    expect(finalRun?.status).toBe('success')
    const results = (finalRun?.stageResults ?? []) as Array<{ status: string; output?: string }>
    expect(results[0]?.status).toBe('success')
    expect(JSON.parse(results[0]!.output!)).toEqual({
      project: 'demo', env: 'dev', branch: 'main',
    })
  }, 20000)

  it('resumeFromImInput with 取消 → run failed', async () => {
    const result = await triggerCapability({
      capabilityKey,
      context: {
        taskId: 't3', groupId: 'g-it-3', platform: 'test',
        initiatorId: 'user3', initiatorRole: 'ops',
      },
    })
    const runId = (result.data as { runId: number }).runId

    const waiter = await waitUntil(
      () => findImInputWaiter('test', 'g-it-3'),
      v => v !== null,
      { timeoutMs: 5000 },
    )
    await resumeFromImInput(waiter!.runId, waiter!.stageIndex, '取消')

    const finalRun = await waitUntil(
      () => getTestRunById(runId),
      r => r?.status === 'success' || r?.status === 'failed',
      { timeoutMs: 10000, intervalMs: 100 },
    )
    expect(finalRun?.status).toBe('failed')
  }, 20000)
})
