import cron from 'node-cron'
import { listEnabledSchedules } from '../db/repositories/pipeline-schedules.js'
import { runPipeline, scheduledTrigger } from './executor.js'

let activeTasks: Array<{ destroy(): void }> = []

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
      void runPipeline(
        s.pipelineId,
        {},
        scheduledTrigger({ triggeredBy: `scheduler:${s.id}`, params: s.presetParams }),
      ).catch(err => {
        console.error(`[PipelineScheduler] schedule #${s.id} run failed:`, err)
      })
    }, { timezone: 'Asia/Shanghai' })
    activeTasks.push(task)
  }

  console.log(`[PipelineScheduler] loaded ${activeTasks.length} schedule(s)`)
}
