/**
 * qi-approval-manager 扩展测试：QI E2E Phase 2 新增 3 按钮 / 2 按钮卡片 + 多值 decision 解析
 *
 * 测试焦点：buildCardActions 按 approvalKind 分发不同按钮集；handleQiCardCallback
 * 解析 fix/force_passed/aborted/retry 多值 action。
 *
 * Note: buildCardActions / parseDecision 是模块内函数，通过 sendQiApprovalCard /
 * handleQiCardCallback 间接验证。用 fake adapter 拦截 sendDirectMessage 拿卡片内容。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/requirement-approval-waiters.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../db/repositories/requirement-approval-waiters.js')
  >('../../db/repositories/requirement-approval-waiters.js')
  return {
    ...actual,
    claimWaiter: vi.fn(),
  }
})

import {
  initQiApprovalManager,
  sendQiApprovalCard,
  handleQiCardCallback,
  isQiApproval,
  clearQiApprovalCards,
} from '../../pipeline/qi-approval-manager.js'
import { claimWaiter } from '../../db/repositories/requirement-approval-waiters.js'
import type { IMAdapter } from '../../adapters/im/types.js'

interface CapturedCard {
  userId: string
  card: { actions?: Array<{ label: string; value: string; style: string }> }
}

class FakeAdapter implements Pick<IMAdapter, 'sendDirectMessage'> {
  cards: CapturedCard[] = []
  async sendDirectMessage(userId: string, msg: unknown): Promise<void> {
    this.cards.push({ userId, card: msg as CapturedCard['card'] })
  }
}

describe('qi-approval-manager Phase 2 扩展', () => {
  let adapter: FakeAdapter
  const resumeFn = vi.fn(async () => {})

  beforeEach(() => {
    adapter = new FakeAdapter()
    initQiApprovalManager([adapter as unknown as IMAdapter], resumeFn)
    clearQiApprovalCards()
    vi.mocked(claimWaiter).mockReset()
    resumeFn.mockClear()
  })

  describe('sendQiApprovalCard - 卡片按钮集', () => {
    it('approvalKind=spec → 经典 binary 2 按钮', async () => {
      await sendQiApprovalCard({
        waiterId: 1,
        requirementId: 100,
        requirementTitle: 't',
        contextSummary: 'ctx',
        approvalKind: 'spec',
        approverIds: ['user-a'],
      })
      expect(adapter.cards).toHaveLength(1)
      const actions = adapter.cards[0].card.actions!
      expect(actions).toHaveLength(2)
      expect(actions.map((a) => a.value)).toEqual(['agree', 'reject'])
    })

    it('approvalKind=qi_e2e_intervention → 3 按钮 fix/force_passed/aborted', async () => {
      await sendQiApprovalCard({
        waiterId: 2,
        requirementId: 101,
        requirementTitle: 't',
        contextSummary: 'e2e fail summary',
        approvalKind: 'qi_e2e_intervention',
        approverIds: ['user-b'],
      })
      const actions = adapter.cards[0].card.actions!
      expect(actions).toHaveLength(3)
      expect(actions.map((a) => a.value)).toEqual(['fix', 'force_passed', 'aborted'])
      expect(actions.map((a) => a.style)).toEqual(['primary', 'danger', 'default'])
    })

    it('approvalKind=qi_sandbox_failed → 2 按钮 retry/aborted', async () => {
      await sendQiApprovalCard({
        waiterId: 3,
        requirementId: 102,
        requirementTitle: 't',
        contextSummary: 'sandbox up failed',
        approvalKind: 'qi_sandbox_failed',
        approverIds: ['user-c'],
      })
      const actions = adapter.cards[0].card.actions!
      expect(actions).toHaveLength(2)
      expect(actions.map((a) => a.value)).toEqual(['retry', 'aborted'])
    })

    it('未知 approvalKind 退化到 binary（兼容老调用）', async () => {
      await sendQiApprovalCard({
        waiterId: 4,
        requirementId: 103,
        requirementTitle: 't',
        contextSummary: null,
        approvalKind: 'final',
        approverIds: ['user-d'],
      })
      const actions = adapter.cards[0].card.actions!
      expect(actions.map((a) => a.value)).toEqual(['agree', 'reject'])
    })

    it('approverIds 空 → 不发卡片（仅 web）', async () => {
      await sendQiApprovalCard({
        waiterId: 5,
        requirementId: 104,
        requirementTitle: 't',
        contextSummary: null,
        approvalKind: 'qi_e2e_intervention',
        approverIds: [],
      })
      expect(adapter.cards).toHaveLength(0)
    })

    it('approvalKind=human_gate + kindMeta.source=ai_escalation → 卡片标题含 "人工裁决"', async () => {
      await sendQiApprovalCard({
        waiterId: 6,
        requirementId: 105,
        requirementTitle: 't',
        contextSummary: 'ctx',
        approvalKind: 'human_gate',
        approverIds: ['user-e'],
        kindMeta: { source: 'ai_escalation' },
      })
      const card = adapter.cards[0].card as unknown as { title: string; templateParams: { title: string } }
      expect(card.title).toContain('人工裁决（AI 多轮未过）')
      expect(card.templateParams.title).toContain('人工裁决（AI 多轮未过）')
      // 仍走 binary（decisionSet 缺省）
      expect(adapter.cards[0].card.actions!.map((a) => a.value)).toEqual(['agree', 'reject'])
    })

    it('approvalKind=human_gate 无 kindMeta → 标题 "人工审批"', async () => {
      await sendQiApprovalCard({
        waiterId: 7,
        requirementId: 106,
        requirementTitle: 't',
        contextSummary: 'ctx',
        approvalKind: 'human_gate',
        approverIds: ['user-f'],
      })
      const card = adapter.cards[0].card as unknown as { title: string }
      expect(card.title).toContain('人工审批')
    })

    it('approvalKind=human_gate + kindMeta.source=final → 标题 "最终批准"', async () => {
      await sendQiApprovalCard({
        waiterId: 8,
        requirementId: 107,
        requirementTitle: 't',
        contextSummary: 'ctx',
        approvalKind: 'human_gate',
        approverIds: ['user-g'],
        kindMeta: { source: 'final' },
      })
      const card = adapter.cards[0].card as unknown as { title: string }
      expect(card.title).toContain('最终批准')
    })
  })

  describe('handleQiCardCallback - 多值 decision 解析', () => {
    function setupWaiter(waiterId: number, decision: string): void {
      vi.mocked(claimWaiter).mockResolvedValue({
        claimed: true,
        by: 'im',
        waiter: {
          id: waiterId,
          requirementId: 100,
          pipelineRunId: 1,
          nodeId: 'n',
          approvalKind: 'qi_e2e_intervention' as never,
          round: 1,
          decisionSet: 'qi_e2e_intervention' as never,
          imPlatform: null,
          imGroupId: null,
          contextSummary: null,
          claimedBy: 'im',
          claimedAt: new Date(),
          decision: decision as never,
          rejectReason: null,
          budgetDelta: null,
          decidedBy: 'user-a',
          targetTaskId: null,
          citedAiNotes: null,
          createdAt: new Date(),
        },
      })
    }

    it('action=fix → claim with decision=fix 并 resume', async () => {
      setupWaiter(10, 'fix')
      await sendQiApprovalCard({
        waiterId: 10,
        requirementId: 100,
        requirementTitle: 't',
        contextSummary: null,
        approvalKind: 'qi_e2e_intervention',
        approverIds: ['user-x'],
      })
      const trackId = (adapter.cards[0].card as { callbackData?: { taskId: string } }).callbackData!.taskId
      await handleQiCardCallback(trackId, 'fix', 'user-x')

      expect(vi.mocked(claimWaiter)).toHaveBeenCalledWith(10, 'im', expect.objectContaining({
        decision: 'fix',
      }))
      expect(resumeFn).toHaveBeenCalled()
    })

    it('action=force_passed → decision=force_passed', async () => {
      setupWaiter(11, 'force_passed')
      await sendQiApprovalCard({
        waiterId: 11,
        requirementId: 100,
        requirementTitle: 't',
        contextSummary: null,
        approvalKind: 'qi_e2e_intervention',
        approverIds: ['user-x'],
      })
      const trackId = (adapter.cards[0].card as { callbackData?: { taskId: string } }).callbackData!.taskId
      await handleQiCardCallback(trackId, 'force_passed', 'user-x')

      expect(vi.mocked(claimWaiter)).toHaveBeenCalledWith(11, 'im', expect.objectContaining({
        decision: 'force_passed',
      }))
    })

    it('action=aborted → decision=aborted', async () => {
      setupWaiter(12, 'aborted')
      await sendQiApprovalCard({
        waiterId: 12,
        requirementId: 100,
        requirementTitle: 't',
        contextSummary: null,
        approvalKind: 'qi_e2e_intervention',
        approverIds: ['user-x'],
      })
      const trackId = (adapter.cards[0].card as { callbackData?: { taskId: string } }).callbackData!.taskId
      await handleQiCardCallback(trackId, 'aborted', 'user-x')

      expect(vi.mocked(claimWaiter)).toHaveBeenCalledWith(12, 'im', expect.objectContaining({
        decision: 'aborted',
      }))
    })

    it('action=retry (qi_sandbox_failed) → 归一到 fix', async () => {
      setupWaiter(13, 'fix')
      await sendQiApprovalCard({
        waiterId: 13,
        requirementId: 100,
        requirementTitle: 't',
        contextSummary: null,
        approvalKind: 'qi_sandbox_failed',
        approverIds: ['user-x'],
      })
      const trackId = (adapter.cards[0].card as { callbackData?: { taskId: string } }).callbackData!.taskId
      await handleQiCardCallback(trackId, 'retry', 'user-x')

      expect(vi.mocked(claimWaiter)).toHaveBeenCalledWith(13, 'im', expect.objectContaining({
        decision: 'fix',
      }))
    })

    it('action=agree → 经典 approved（向后兼容）', async () => {
      setupWaiter(14, 'approved')
      await sendQiApprovalCard({
        waiterId: 14,
        requirementId: 100,
        requirementTitle: 't',
        contextSummary: null,
        approvalKind: 'spec',
        approverIds: ['user-x'],
      })
      const trackId = (adapter.cards[0].card as { callbackData?: { taskId: string } }).callbackData!.taskId
      await handleQiCardCallback(trackId, 'agree', 'user-x')

      expect(vi.mocked(claimWaiter)).toHaveBeenCalledWith(14, 'im', expect.objectContaining({
        decision: 'approved',
      }))
    })

    it('未知 action 静默 drop（不调 claim 不调 resume）', async () => {
      await sendQiApprovalCard({
        waiterId: 15,
        requirementId: 100,
        requirementTitle: 't',
        contextSummary: null,
        approvalKind: 'qi_e2e_intervention',
        approverIds: ['user-x'],
      })
      const trackId = (adapter.cards[0].card as { callbackData?: { taskId: string } }).callbackData!.taskId
      await handleQiCardCallback(trackId, 'unknown_action', 'user-x')

      expect(vi.mocked(claimWaiter)).not.toHaveBeenCalled()
      expect(resumeFn).not.toHaveBeenCalled()
    })
  })

  describe('isQiApproval', () => {
    it('卡片发出后 trackId 注册，可被 isQiApproval 识别', async () => {
      await sendQiApprovalCard({
        waiterId: 20,
        requirementId: 100,
        requirementTitle: 't',
        contextSummary: null,
        approvalKind: 'qi_e2e_intervention',
        approverIds: ['user-x'],
      })
      const trackId = (adapter.cards[0].card as { callbackData?: { taskId: string } }).callbackData!.taskId
      expect(isQiApproval(trackId)).toBe(true)
      expect(isQiApproval('random-other-id')).toBe(false)
    })
  })
})
