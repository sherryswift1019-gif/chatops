import cron from 'node-cron'
import { listScheduledPipelines } from '../db/repositories/test-pipelines.js'
import { listTestServers } from '../db/repositories/test-servers.js'
import { runPipeline, scheduledTrigger } from './executor.js'

const jobs = new Map<number, cron.ScheduledTask>()

export async function startScheduler(): Promise<void> {
  const pipelines = await listScheduledPipelines()
  for (const pipeline of pipelines) {
    if (!pipeline.schedule || !cron.validate(pipeline.schedule)) continue
    const task = cron.schedule(pipeline.schedule, async () => {
      try {
        // Auto-assign servers by role from the pipeline's product line
        const servers = await listTestServers(pipeline.productLineId)
        const idleServers = servers.filter(s => s.status === 'idle')
        const assignment: Record<string, string[]> = {}
        const roles = Object.keys(pipeline.serverRoles)

        for (const role of roles) {
          const roleServers = idleServers.filter(s => s.role === role)
          if (roleServers.length === 0) {
            console.error(`[scheduler] Pipeline ${pipeline.id}: no idle servers for role "${role}", skipping`)
            return
          }
          assignment[role] = roleServers.map(s => s.host)
        }

        await runPipeline(pipeline.id, assignment, scheduledTrigger({ triggeredBy: 'scheduler' }))
        console.log(`[scheduler] Pipeline ${pipeline.id} "${pipeline.name}" triggered successfully`)
      } catch (err) {
        console.error(`[scheduler] Pipeline ${pipeline.id} error:`, err)
      }
    })
    jobs.set(pipeline.id, task)
    console.log(`[scheduler] Registered pipeline ${pipeline.id} "${pipeline.name}" with schedule "${pipeline.schedule}"`)
  }
}

export async function reloadScheduler(): Promise<void> {
  // Stop all existing jobs
  for (const [, task] of jobs) {
    task.stop()
  }
  jobs.clear()
  // Restart
  await startScheduler()
}

export function stopScheduler(): void {
  for (const [, task] of jobs) {
    task.stop()
  }
  jobs.clear()
}
