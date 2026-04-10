import type { IMAdapter } from '../adapters/im/types.js'
import { ApprovalRouter } from './router.js'
import { EscalationTimer } from './escalation.js'
import { getApprovalRules } from '../db/repositories/approval-rules.js'
import { createApprovalRequest, resolveApprovalRequest } from '../db/repositories/approval-requests.js'
import { updateTaskStatus, getTaskById } from '../db/repositories/tasks.js'

export interface ApprovalRequest {
  taskId: string
  action: string
  env: string
  description: string
  initiatorName: string
  groupId: string
}

type ApprovalCallback = (taskId: string, decision: 'approved' | 'rejected', approverId: string) => void

export class ApprovalGate {
  private timers = new Map<string, EscalationTimer>()
  private callbacks = new Map<string, ApprovalCallback>()

  constructor(
    private readonly adapters: IMAdapter[],
    private router: ApprovalRouter | null = null
  ) {}

  async initialize(): Promise<void> {
    const rules = await getApprovalRules()
    this.router = new ApprovalRouter(rules)
  }

  async request(req: ApprovalRequest, onDecision: ApprovalCallback): Promise<boolean> {
    if (!this.router) await this.initialize()
    const rule = this.router!.route(req.action, req.env)

    // No matching rule → auto-approve
    if (!rule) {
      onDecision(req.taskId, 'approved', 'system')
      return true
    }

    await updateTaskStatus(req.taskId, 'pending_approval')
    this.callbacks.set(req.taskId, onDecision)

    await this.sendToApprovers(req, rule.primaryApprovers, 'primary')

    const timer = new EscalationTimer({
      primaryTimeoutMs: rule.primaryTimeoutMin * 60 * 1000,
      totalTimeoutMs: rule.totalTimeoutMin * 60 * 1000,
      onPrimaryTimeout: async () => {
        const task = await getTaskById(req.taskId)
        if (task?.status !== 'pending_approval') return
        await this.sendToApprovers(req, rule.backupApprovers, 'backup')
        // Notify primary approvers of escalation
        for (const aid of rule.primaryApprovers) {
          const adapter = this.adapters[0]
          await adapter.sendDirectMessage(aid, {
            text: `⚠️ 审核请求已超时升级至备选审核人。任务：${req.description}`
          })
        }
      },
      onTotalTimeout: async () => {
        const task = await getTaskById(req.taskId)
        if (task?.status !== 'pending_approval') return
        await updateTaskStatus(req.taskId, 'timeout')
        this.timers.delete(req.taskId)
        this.callbacks.delete(req.taskId)
        // Notify group
        for (const adapter of this.adapters) {
          await adapter.sendMessage({ type: 'group', id: req.groupId }, {
            text: `❌ 审核超时，操作已取消：${req.description}`
          })
        }
      },
    })
    timer.start()
    this.timers.set(req.taskId, timer)
    return false
  }

  async respond(taskId: string, approverId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const task = await getTaskById(taskId)
    if (!task || task.status !== 'pending_approval') return

    await resolveApprovalRequest(taskId, approverId, decision)

    const timer = this.timers.get(taskId)
    timer?.cancel()
    this.timers.delete(taskId)

    const cb = this.callbacks.get(taskId)
    this.callbacks.delete(taskId)

    if (decision === 'approved') {
      await updateTaskStatus(taskId, 'approved', { approvedBy: approverId })
    } else {
      await updateTaskStatus(taskId, 'rejected')
    }

    cb?.(taskId, decision, approverId)
  }

  private async sendToApprovers(
    req: ApprovalRequest,
    approverIds: string[],
    type: 'primary' | 'backup'
  ): Promise<void> {
    const adapter = this.adapters[0]
    const card = {
      title: `🔐 审核请求${type === 'backup' ? '（已升级）' : ''}`,
      body: `**操作：** ${req.description}\n**发起人：** ${req.initiatorName}`,
      actions: [
        { label: '✅ 批准', value: 'approved', style: 'primary' as const },
        { label: '❌ 拒绝', value: 'rejected', style: 'danger' as const },
      ],
      callbackData: { taskId: req.taskId },
    }
    for (const approverId of approverIds) {
      await adapter.sendDirectMessage(approverId, card)
      await createApprovalRequest({ taskId: req.taskId, approverId, approverType: type })
    }
  }
}
