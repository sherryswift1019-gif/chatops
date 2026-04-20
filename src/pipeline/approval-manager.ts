import { randomUUID } from 'crypto'
import type { IMAdapter } from '../adapters/im/types.js'
import {
  APPROVAL_APPROVED,
  APPROVAL_REJECTED,
} from './graph-builder.js'

export type ApprovalDecision =
  | typeof APPROVAL_APPROVED
  | typeof APPROVAL_REJECTED

export interface ApprovalResumeParams {
  approvalId: string
  runId: number
  stageIndex: number
  decision: ApprovalDecision
  approverId: string
}

export type ApprovalResumeHandler = (
  params: ApprovalResumeParams,
) => void | Promise<void>

interface ApprovalEntry {
  runId: number
  stageIndex: number
}

/**
 * Adapter layer between IM card callbacks and LangGraph Command({resume}).
 *
 * Responsibility (Task 3):
 *   - Send approval card out on a stage entering interrupt()
 *   - Remember approvalId → (runId, stageIndex) in memory
 *   - Translate the inbound card action into a resume call on the
 *     externally-injected handler (Task 4 wires this to graph-runner)
 *
 * Non-responsibility:
 *   - Approval timeout is owned by Task 4 graph-runner (setTimeout /
 *     AbortController); it dispatches `new Command({resume: 'timeout'})`
 *     directly and does NOT go through handleCallback here.
 */
export class PipelineApprovalManager {
  private static instance: PipelineApprovalManager | null = null
  private adapters: IMAdapter[] = []
  private approvals = new Map<string, ApprovalEntry>()
  private resumeHandler: ApprovalResumeHandler | null = null

  static initialize(adapters: IMAdapter[]): PipelineApprovalManager {
    const mgr = new PipelineApprovalManager()
    mgr.adapters = adapters
    PipelineApprovalManager.instance = mgr
    return mgr
  }

  static getInstance(): PipelineApprovalManager {
    if (!PipelineApprovalManager.instance) {
      throw new Error(
        'PipelineApprovalManager not initialized — call initialize() first',
      )
    }
    return PipelineApprovalManager.instance
  }

  /** Test utility: clear all internal state and drop the singleton. */
  static resetInstance(): void {
    if (PipelineApprovalManager.instance) {
      PipelineApprovalManager.instance.approvals.clear()
      PipelineApprovalManager.instance.resumeHandler = null
    }
    PipelineApprovalManager.instance = null
  }

  /**
   * Inject the resume handler. Called once at startup by graph-runner (Task 4).
   * Setting a new handler overrides any previous one.
   */
  setResumeHandler(handler: ApprovalResumeHandler): void {
    this.resumeHandler = handler
  }

  /**
   * Send the approval card to every approver and register the mapping.
   *
   * @returns the generated approvalId — graph-runner should persist this into
   *   the run state so a process restart can reconcile.
   */
  async requestCard(params: {
    runId: number
    stageIndex: number
    approverIds: string[]
    description: string
  }): Promise<string> {
    const adapter = this.adapters[0]
    if (!adapter) throw new Error('No IM adapter available')

    const approvalId = randomUUID()
    this.approvals.set(approvalId, {
      runId: params.runId,
      stageIndex: params.stageIndex,
    })

    const card = {
      title: '🔐 流水线审批',
      body: `**操作：** ${params.description}`,
      actions: [
        { label: '✅ 批准', value: APPROVAL_APPROVED, style: 'primary' as const },
        { label: '❌ 拒绝', value: APPROVAL_REJECTED, style: 'danger' as const },
      ],
      callbackData: { taskId: approvalId, pipelineApproval: 'true' },
    }

    await Promise.all(
      params.approverIds.map((approverId) =>
        adapter.sendDirectMessage(approverId, card),
      ),
    )

    return approvalId
  }

  /**
   * Translate an inbound IM card action into a resume call.
   *
   * - Unknown approvalId → log + drop (no throw, to keep IM routing stable)
   * - No handler registered → log warn + drop (graph-runner not wired yet)
   * - Otherwise: call handler, then clear the mapping
   */
  async handleCallback(
    approvalId: string,
    decision: ApprovalDecision,
    approverId: string,
  ): Promise<void> {
    const entry = this.approvals.get(approvalId)
    if (!entry) {
      console.log(
        `[PipelineApprovalManager] callback for unknown approvalId=${approvalId} — ignoring`,
      )
      return
    }

    this.approvals.delete(approvalId)

    if (!this.resumeHandler) {
      console.warn(
        `[PipelineApprovalManager] no resumeHandler registered; dropping decision=${decision} for approvalId=${approvalId}`,
      )
      return
    }

    await this.resumeHandler({
      approvalId,
      runId: entry.runId,
      stageIndex: entry.stageIndex,
      decision,
      approverId,
    })
  }

  /**
   * @deprecated Legacy Promise-race API removed in Task 3.
   *   The executor (Task 4) will switch to graph-runner + `requestCard`.
   *   Kept only so `tsc --noEmit` keeps passing while Task 4 lands.
   */
  async requestApproval(
    _approverIds: string[],
    _description: string,
    _timeoutMs: number,
  ): Promise<'approved' | 'rejected' | 'timeout'> {
    throw new Error(
      'PipelineApprovalManager.requestApproval: legacy API removed in Task 3; use requestCard + resumeHandler instead',
    )
  }
}
