import type { IMAdapter, NormalizedMessage } from '../adapters/im/types.js'
import { TaskQueue } from './task-queue.js'
import { getUserRole } from '../db/repositories/roles.js'
import { getMaxConcurrency, getActiveCount } from './concurrency.js'
import type { TaskContext } from './tools/types.js'

type MessageProcessor = (msg: NormalizedMessage, queue: TaskQueue) => Promise<void>

export class SessionManager {
  private queues = new Map<string, TaskQueue>()

  constructor(
    private readonly adapters: IMAdapter[],
    private readonly processMessage: MessageProcessor
  ) {}

  start(): void {
    for (const adapter of this.adapters) {
      adapter.onMessage(msg => void this.handleMessage(adapter, msg))
    }

    // idle queue 清理（每 10 分钟）
    setInterval(() => {
      for (const [key, queue] of this.queues) {
        if (queue.isIdle() && queue.idleSince() > 30 * 60 * 1000) {
          this.queues.delete(key)
        }
      }
    }, 10 * 60 * 1000)
  }

  private async handleMessage(adapter: IMAdapter, msg: NormalizedMessage): Promise<void> {
    if (!msg.userId) return // 系统消息/webhook 无 userId，跳过

    console.log(`[SessionManager] Message from ${msg.platform}:${msg.groupId} user=${msg.userName}: "${msg.text}"`)

    // 全局并发准入检查
    const max = await getMaxConcurrency()
    if (getActiveCount() >= max) {
      console.log(`[Concurrency] Rejected: ${getActiveCount()}/${max} active`)
      await adapter.sendMessage(
        { type: 'group', id: msg.groupId },
        { text: '⏳ 系统繁忙，请稍后再试。' }
      )
      return
    }

    // ACK 由 claude-runner.ts 的 handler 路径发送（带 @提问人）
    console.log(`[SessionManager] Ack sent`)

    // queue key = userId（同一用户跨群共享队列，串行执行）
    const queueKey = msg.userId
    const queue = this.getOrCreateQueue(queueKey, msg)

    try {
      await this.processMessage(msg, queue)
    } catch (err) {
      console.error('[SessionManager] processMessage error:', err)
    }
  }

  private getOrCreateQueue(key: string, msg: NormalizedMessage): TaskQueue {
    if (!this.queues.has(key)) {
      this.queues.set(key, new TaskQueue(msg.groupId, msg.platform))
    }
    return this.queues.get(key)!
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
