import { randomUUID } from 'crypto'
import type { IMAdapter } from '../adapters/im/types.js'

export class PipelineApprovalManager {
  private static instance: PipelineApprovalManager | null = null
  private adapters: IMAdapter[] = []
  private pending = new Map<string, { resolve: (decision: 'approved' | 'rejected') => void }>()

  static initialize(adapters: IMAdapter[]): PipelineApprovalManager {
    const mgr = new PipelineApprovalManager()
    mgr.adapters = adapters
    PipelineApprovalManager.instance = mgr
    return mgr
  }

  static getInstance(): PipelineApprovalManager {
    if (!PipelineApprovalManager.instance) {
      throw new Error('PipelineApprovalManager not initialized — call initialize() first')
    }
    return PipelineApprovalManager.instance
  }

  async requestApproval(
    approverIds: string[],
    description: string,
    timeoutMs: number,
  ): Promise<'approved' | 'rejected' | 'timeout'> {
    const approvalId = randomUUID()
    const adapter = this.adapters[0]
    if (!adapter) throw new Error('No IM adapter available')

    const approvalPromise = new Promise<'approved' | 'rejected'>((resolve) => {
      this.pending.set(approvalId, { resolve })
    })

    const card = {
      title: '🔐 流水线审批',
      body: `**操作：** ${description}`,
      actions: [
        { label: '✅ 批准', value: 'approved', style: 'primary' as const },
        { label: '❌ 拒绝', value: 'rejected', style: 'danger' as const },
      ],
      callbackData: { taskId: approvalId, pipelineApproval: 'true' },
    }

    await Promise.all(
      approverIds.map((approverId) => adapter.sendDirectMessage(approverId, card)),
    )

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs)
    })

    try {
      return await Promise.race([approvalPromise, timeoutPromise])
    } finally {
      this.pending.delete(approvalId)
    }
  }

  handleCallback(approvalId: string, decision: 'approved' | 'rejected', _approverId: string): void {
    const entry = this.pending.get(approvalId)
    if (!entry) return
    entry.resolve(decision)
    this.pending.delete(approvalId)
  }
}
