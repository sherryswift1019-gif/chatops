import { describe, it, expect, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'
import { runDryRun, decideSideEffect } from '../../pipeline/dryrun-runner.js'
import { listSnapshots } from '../../db/repositories/dryrun-snapshots.js'
import { getPool } from '../../db/client.js'

async function seedPipeline(graph: unknown): Promise<number> {
  const r = await getPool().query(
    `INSERT INTO test_pipelines (name, graph) VALUES ('p', $1::jsonb) RETURNING id`,
    [JSON.stringify(graph)])
  return r.rows[0].id as number
}

describe('runDryRun 端到端', () => {
  beforeEach(async () => { await resetTestDb() })

  it('从入口跑到目标节点：sql_query → script → http，跑到 http 之前 → 仅前两节点的 snapshot', async () => {
    const graph = {
      nodes: [
        { id: 'q', name: 'q', stageType: 'sql_query', params: { sqlTemplate: 'SELECT 1' }, position: { x: 0, y: 0 }, targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop' },
        { id: 's', name: 's', stageType: 'script', params: {}, script: 'echo 1', targetRoles: ['app'], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop', position: { x: 0, y: 0 } },
        { id: 'h', name: 'h', stageType: 'http', params: { url: 'http://x' }, position: { x: 0, y: 0 }, targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop' },
      ],
      edges: [
        { id: 'e1', source: 'q', target: 's' },
        { id: 'e2', source: 's', target: 'h' },
      ],
    }
    const pid = await seedPipeline(graph)
    const chunks: unknown[] = []
    const sessionId = 'sess1'

    // 决策 stub（script 是副作用）：
    // runDryRun 的 beforeSideEffect 先调用 ssePush('decision-needed')，然后才创建
    // Promise 并注册 waiter。因此 decideSideEffect 必须在 ssePush 返回后的微任务中执行，
    // 确保 waiter 已经注册完毕。
    let decisionCalled = false
    await runDryRun({
      sessionId, pipelineId: pid, targetNodeId: 'h',
      triggerParams: {}, triggerType: 'manual', triggeredBy: 'tester',
      ssePush: (chunk) => {
        chunks.push(chunk)
        // 收到 decision-needed 后，等一个微任务让 waiter 注册完毕再 resolve
        if ((chunk as { type: string }).type === 'decision-needed' && !decisionCalled) {
          decisionCalled = true
          Promise.resolve().then(() =>
            decideSideEffect(sessionId, 's', { decision: 'stub' })
          ).catch(() => {})
        }
      },
    })

    const snapshots = await listSnapshots(pid)
    expect(snapshots.map(s => s.nodeId).sort()).toEqual(['q', 's'])
    expect(snapshots.find(s => s.nodeId === 's')!.source).toBe('stub')

    // SSE chunks 应包含 progress + decision-needed + snapshot + done
    const types = (chunks as Array<{ type: string }>).map(c => c.type)
    expect(types).toContain('progress')
    expect(types).toContain('decision-needed')
    expect(types).toContain('snapshot')
    expect(types).toContain('done')
  }, 30_000)

  it('并发同一 pipeline：第二次 runDryRun 抛 advisory lock 错', async () => {
    // 用 '*' 跑整图，这样 pg_sleep(1) 确保第一个 run 持有锁时第二个尝试获取
    const graph = {
      nodes: [{ id: 'q', name: 'q', stageType: 'sql_query', params: { sqlTemplate: 'SELECT pg_sleep(0.5)' }, position: { x: 0, y: 0 }, targetRoles: [], parallel: false, timeoutSeconds: 60, retryCount: 0, onFailure: 'stop' }],
      edges: [],
    }
    const pid = await seedPipeline(graph)
    const p1 = runDryRun({ sessionId: 's1', pipelineId: pid, targetNodeId: '*', triggerParams: {}, triggerType: 'manual', triggeredBy: 't', ssePush: () => {} })
    const p2 = runDryRun({ sessionId: 's2', pipelineId: pid, targetNodeId: '*', triggerParams: {}, triggerType: 'manual', triggeredBy: 't', ssePush: () => {} })
    await expect(Promise.all([p1, p2])).rejects.toThrow(/advisory lock|concurrent/)
  }, 15_000)

  it('graph dirty 検査：admin route 层完成，此处 noop', async () => {
    // dirty 检查在 admin route 层做（前端传 graph hash），dryrun-runner 只接受已校验的 graph
    // 此 case 在 Task 7 admin route 测试里
    expect(true).toBe(true)
  })
})
