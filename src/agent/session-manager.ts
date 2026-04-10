import type { IMAdapter, NormalizedMessage } from '../adapters/im/types.js'
import { TaskQueue } from './task-queue.js'
import { getUserRole } from '../db/repositories/roles.js'
import type { TaskContext } from './tools/types.js'

type MessageProcessor = (msg: NormalizedMessage, queue: TaskQueue) => Promise<void>

export class SessionManager {
  private queues = new Map<string, TaskQueue>()
  private inactivityTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly INACTIVITY_MS = 24 * 60 * 60 * 1000

  constructor(
    private readonly adapters: IMAdapter[],
    private readonly processMessage: MessageProcessor
  ) {}

  start(): void {
    for (const adapter of this.adapters) {
      adapter.onMessage(msg => void this.handleMessage(adapter, msg))
    }
  }

  private async handleMessage(adapter: IMAdapter, msg: NormalizedMessage): Promise<void> {
    const queueKey = `${msg.platform}:${msg.groupId}`

    // Immediate ack
    await adapter.sendMessage(
      { type: 'group', id: msg.groupId },
      { text: `🤖 收到，处理中...` }
    )

    const queue = this.getOrCreateQueue(msg)
    this.resetInactivityTimer(queueKey, msg)

    await this.processMessage(msg, queue)
  }

  private getOrCreateQueue(msg: NormalizedMessage): TaskQueue {
    const key = `${msg.platform}:${msg.groupId}`
    if (!this.queues.has(key)) {
      this.queues.set(key, new TaskQueue(msg.groupId, msg.platform))
    }
    return this.queues.get(key)!
  }

  private resetInactivityTimer(queueKey: string, _msg: NormalizedMessage): void {
    const existing = this.inactivityTimers.get(queueKey)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.queues.delete(queueKey)
      this.inactivityTimers.delete(queueKey)
    }, this.INACTIVITY_MS)

    this.inactivityTimers.set(queueKey, timer)
  }

  async buildTaskContext(msg: NormalizedMessage, taskId: string): Promise<TaskContext> {
    const role = await getUserRole(msg.platform, msg.userId, msg.groupId)
    return {
      taskId,
      groupId: msg.groupId,
      platform: msg.platform,
      initiatorId: msg.userId,
      initiatorRole: role,
    }
  }
}
