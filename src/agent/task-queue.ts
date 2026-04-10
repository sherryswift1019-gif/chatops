import { createTask, updateTaskStatus, getExecutingTask, getQueuedTasks, getTaskById } from '../db/repositories/tasks.js'
import type { Task } from '../db/repositories/tasks.js'

type TaskExecutor = (task: Task) => Promise<void>

interface QueuedEntry {
  task: Task
  executor: TaskExecutor
}

export class TaskQueue {
  private executing = false
  private queue: QueuedEntry[] = []
  private pendingApprovalExecutors = new Map<string, TaskExecutor>()

  constructor(
    private readonly groupId: string,
    private readonly platform: string
  ) {}

  async submit(
    data: { initiatorId: string; intent: string; toolName?: string; toolParams?: unknown },
    executor: TaskExecutor
  ): Promise<void> {
    const task = await createTask({
      groupId: this.groupId,
      platform: this.platform,
      initiatorId: data.initiatorId,
      intent: data.intent,
      toolName: data.toolName,
      toolParams: data.toolParams,
    })

    if (this.executing) {
      await updateTaskStatus(task.id, 'queued')
      this.queue.push({ task, executor })
    } else {
      await this.run({ task, executor })
    }
  }

  async setPendingApproval(taskId: string): Promise<void> {
    await updateTaskStatus(taskId, 'pending_approval')
  }

  async approve(taskId: string, approverId: string): Promise<void> {
    const task = await getTaskById(taskId)
    if (!task || task.status !== 'pending_approval') return
    await updateTaskStatus(taskId, 'approved', { approvedBy: approverId })

    const executor = this.pendingApprovalExecutors.get(taskId)
    if (executor) {
      this.pendingApprovalExecutors.delete(taskId)
      const updatedTask = await getTaskById(taskId)
      if (updatedTask) {
        if (this.executing) {
          this.queue.push({ task: updatedTask, executor })
        } else {
          await this.run({ task: updatedTask, executor })
        }
      }
    }
  }

  registerResumeExecutor(taskId: string, executor: TaskExecutor): void {
    this.pendingApprovalExecutors.set(taskId, executor)
  }

  private async run(entry: QueuedEntry): Promise<void> {
    this.executing = true
    const { task, executor } = entry
    await updateTaskStatus(task.id, 'executing')
    try {
      await executor(task)
      const current = await getTaskById(task.id)
      if (current?.status === 'executing') {
        await updateTaskStatus(task.id, 'done')
      }
    } catch (err) {
      await updateTaskStatus(task.id, 'done', { result: { error: String(err) } })
    } finally {
      this.executing = false
      await this.drain()
    }
  }

  private async drain(): Promise<void> {
    const next = this.queue.shift()
    if (next) {
      await this.run(next)
    }
  }
}
