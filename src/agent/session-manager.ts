import type { IMAdapter, NormalizedMessage } from '../adapters/im/types.js'
import { TaskQueue } from './task-queue.js'
import { getUserRole } from '../db/repositories/roles.js'
import { getMaxConcurrency, getActiveCount } from './concurrency.js'
import type { TaskContext } from './tools/types.js'
import { findImInputWaiter, resumeFromImInput } from '../pipeline/graph-runner.js'
import { findParamCollectWaiter } from '../pipeline/im-router.js'

type MessageProcessor = (msg: NormalizedMessage, queue: TaskQueue) => Promise<void>

const RESET_COMMANDS = new Set(['/new', '/reset', '/end', '/restart'])

export class SessionManager {
  private queues = new Map<string, TaskQueue>()

  constructor(
    private readonly adapters: IMAdapter[],
    private readonly processMessage: MessageProcessor,
    private readonly onResetSession?: (userId: string) => boolean
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

    // Pipeline IM 路由：当前群是否有 pipeline 正等 im_input？有则把消息作为 resume value
    // 喂回 graph，绕过 SessionManager 的 queue/ack/并发流程。
    const waiter = findImInputWaiter(msg.platform, msg.groupId)
    if (waiter) {
      console.log(`[SessionManager] Routing to pipeline run=${waiter.runId} stage=${waiter.stageIndex}`)
      try {
        const handled = await resumeFromImInput(waiter.runId, waiter.stageIndex, msg.text)
        if (handled) return
        // claim 失败（例如 timeout 定时器先一步把 interrupt resolve 了）：
        // 继续走正常 Agent 流程；用户消息不会丢，但也不会被喂到该 pipeline。
      } catch (err) {
        console.error(`[SessionManager] resumeFromImInput failed run=${waiter.runId}:`, err)
      }
    }

    // Param collection routing: check before graph interrupt waiter
    const paramWaiter = findParamCollectWaiter(msg.platform, msg.groupId)
    if (paramWaiter) {
      console.log(`[SessionManager] Routing to param-collector for ${msg.platform}:${msg.groupId}`)
      paramWaiter.resolve(msg.text)
      return
    }

    // 重置命令：立刻清理该用户当前 session，下条消息走新意图
    const trimmed = msg.text.trim()
    if (RESET_COMMANDS.has(trimmed.toLowerCase())) {
      const had = this.onResetSession?.(msg.userId) ?? false
      await adapter.sendMessage(
        { type: 'group', id: msg.groupId },
        { text: had
            ? '✅ 已结束当前对话。下一条消息会开启新需求。'
            : 'ℹ️ 当前没有进行中的对话。直接描述你的新需求即可。' }
      ).catch(err => console.error('[SessionManager] reset ack failed:', err))
      return
    }

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
