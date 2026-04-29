import cron from 'node-cron'
import { listEnabledSchedules, type PipelineSchedule } from '../db/repositories/pipeline-schedules.js'
import { runPipeline, scheduledTrigger } from './executor.js'
import { autoResolveServersByRole } from './server-resolver.js'

let activeTasks: Array<{ destroy(): void }> = []

/**
 * 决定 cron 触发时传给 runPipeline 的 serverAssignment。
 *
 * 优先级（pipeline_schedules 目前没有显式 servers 字段，schema-v53）：
 *   1. 按 test_servers.role 自动聚合（与 webhook-router / admin test-runs 行为对齐）
 *   2. 没有任何带 role 的 server 时返回 {}，serverless pipeline 仍可正常跑
 *
 * 抽出来导出，便于单测断言传给 runPipeline 的形状，无需触发真 cron。
 * 未来若 pipeline_schedules 加显式 servers 字段，这里是唯一插入点。
 */
export async function resolveScheduleServers(
  _schedule: PipelineSchedule,
): Promise<Record<string, string[]>> {
  return autoResolveServersByRole()
}

export async function startPipelineScheduler(): Promise<void> {
  await reloadSchedules()
  console.log('[PipelineScheduler] started')
}

export async function reloadSchedules(): Promise<void> {
  for (const t of activeTasks) t.destroy()
  activeTasks = []

  const schedules = await listEnabledSchedules()
  for (const s of schedules) {
    if (!cron.validate(s.cronExpr)) {
      console.warn(`[PipelineScheduler] invalid cron "${s.cronExpr}" for schedule #${s.id}, skipping`)
      continue
    }
    const task = cron.schedule(s.cronExpr, () => {
      void (async () => {
        const servers = await resolveScheduleServers(s)
        await runPipeline(
          s.pipelineId,
          servers,
          scheduledTrigger({ triggeredBy: `scheduler:${s.id}`, params: s.presetParams }),
        )
      })().catch(err => {
        console.error(`[PipelineScheduler] schedule #${s.id} run failed:`, err)
      })
    }, { timezone: 'Asia/Shanghai' })
    activeTasks.push(task)
  }

  console.log(`[PipelineScheduler] loaded ${activeTasks.length} schedule(s)`)
}
