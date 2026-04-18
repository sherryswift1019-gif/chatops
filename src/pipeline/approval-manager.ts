import { randomUUID } from 'crypto'
import type { IMAdapter } from '../adapters/im/types.js'

export class PipelineApprovalManager {
  private static instance: PipelineApprovalManager | null = null
  private adapters: IMAdapter[] = []
  private pending = new Map<string, { resolve: (decision: 'approved' | 'rejected') => void; description: string; issueId?: string }>()

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
    issueId?: string,
  ): Promise<'approved' | 'rejected' | 'timeout'> {
    const approvalKey = issueId ? `l3-fix-${issueId}` : randomUUID()
    const adapter = this.adapters[0]
    if (!adapter) throw new Error('No IM adapter available')

    const approvalPromise = new Promise<'approved' | 'rejected'>((resolve) => {
      this.pending.set(approvalKey, { resolve, description })
    })

    // 发送审批通知（markdown + 命令提示）
    const approvalCmd = `approve #${issueId ?? approvalKey}`
    const rejectCmd = `reject #${issueId ?? approvalKey}`
    const message = `🔐 **L3 修复方案审批**\n\n${description}\n\n---\n在群里 @机器人 回复以下命令：\n- \`${approvalCmd}\` 批准\n- \`${rejectCmd}\` 拒绝`

    await Promise.all(
      approverIds.map((approverId) => adapter.sendDirectMessage(approverId, { text: message })),
    )

    console.log(`[PipelineApproval] 审批消息已发送: key=${approvalKey}, approvers=${approverIds.join(',')}`)

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), timeoutMs)
    })

    try {
      return await Promise.race([approvalPromise, timeoutPromise])
    } finally {
      this.pending.delete(approvalKey)
    }
  }

  /** 处理群里的 approve/reject 命令（支持 approve #29 或 approve 29 或 approve xxxxxxxx） */
  tryHandleCommand(text: string): boolean {
    const match = text.match(/^(approve|reject)\s+#?(\w+)/i)
    if (!match) return false

    const [, action, key] = match
    const decision = action.toLowerCase() === 'approve' ? 'approved' : 'rejected'

    // 精确匹配或前缀匹配
    // 精确匹配或包含匹配（key 可能是 "33"，pending 里是 "l3-fix-33"）
    for (const [id, e] of this.pending) {
      if (id === key || id.endsWith(key) || id.startsWith(key)) {
        e.resolve(decision as 'approved' | 'rejected')
        this.pending.delete(id)
        console.log(`[PipelineApproval] ${decision}: ${id}`)
        return true
      }
    }
    return false
  }

  handleCallback(approvalId: string, decision: 'approved' | 'rejected', _approverId: string): void {
    const entry = this.pending.get(approvalId)
    if (!entry) return
    entry.resolve(decision)
    this.pending.delete(approvalId)
  }
}
