/**
 * qi-approval-manager v3 扩展测试：imSummary 优先 + URL openWaiter
 *
 * 焦点：sendQiApprovalCard 接到 imSummary 字段时优先用作卡片 body（≤ 250 字符）；
 * 缺失时降级 contextSummary 截断 1500。降级 DM 链接含 &openWaiter=N。
 */
import { describe, it, expect, beforeEach } from 'vitest'

import {
  initQiApprovalManager,
  sendQiApprovalCard,
  clearQiApprovalCards,
} from '../../pipeline/qi-approval-manager.js'
import type { IMAdapter } from '../../adapters/im/types.js'

interface CapturedCard {
  userId: string
  msg: { body?: string; templateParams?: { body?: string }; text?: string }
}

class FakeAdapter implements Pick<IMAdapter, 'sendDirectMessage'> {
  cards: CapturedCard[] = []
  failOnce = false
  async sendDirectMessage(userId: string, msg: unknown): Promise<void> {
    if (this.failOnce) {
      this.failOnce = false
      throw new Error('simulated card failure → fallback to text DM')
    }
    this.cards.push({ userId, msg: msg as CapturedCard['msg'] })
  }
}

describe('qi-approval-manager v3 — imSummary + openWaiter URL', () => {
  let adapter: FakeAdapter

  beforeEach(() => {
    adapter = new FakeAdapter()
    initQiApprovalManager([adapter as unknown as IMAdapter], async () => {})
    clearQiApprovalCards()
  })

  it('imSummary 提供时优先用作 body（不走 contextSummary 1500 截断）', async () => {
    const longContext = '# spec.md\n\n' + 'a'.repeat(2000)
    await sendQiApprovalCard({
      waiterId: 42,
      requirementId: 100,
      requirementTitle: 'test req',
      contextSummary: longContext,
      imSummary: '🤖 v3 简短摘要 ≤ 250',
      approvalKind: 'spec',
      approverIds: ['user-1'],
    })
    expect(adapter.cards).toHaveLength(1)
    const body = adapter.cards[0].msg.body
    expect(body).toBe('🤖 v3 简短摘要 ≤ 250')
    expect(body!.length).toBeLessThan(100) // 不会被 1500 截断
  })

  it('imSummary 缺失时降级 contextSummary 截断 1500', async () => {
    const longContext = '# spec.md\n\n' + 'a'.repeat(2000)
    await sendQiApprovalCard({
      waiterId: 42,
      requirementId: 100,
      requirementTitle: 'test req',
      contextSummary: longContext,
      approvalKind: 'spec',
      approverIds: ['user-1'],
    })
    const body = adapter.cards[0].msg.body!
    expect(body.length).toBeGreaterThan(1500)  // 1500 + "\n\n…（内容过长，请在 Web 端查看完整 Spec）"
    expect(body).toContain('内容过长')
  })

  it('降级 text DM 时 URL 含 &openWaiter=N', async () => {
    const oldEnv = process.env.WEB_BASE_URL
    process.env.WEB_BASE_URL = 'https://chatops.example.com'

    adapter.failOnce = true  // 触发降级到 text DM

    await sendQiApprovalCard({
      waiterId: 42,
      requirementId: 100,
      requirementTitle: 'test req',
      contextSummary: 'short',
      imSummary: '🤖 v3 摘要',
      approvalKind: 'spec',
      approverIds: ['user-1'],
    })

    // 第一次失败后 catch 内会再发 text DM
    expect(adapter.cards).toHaveLength(1)
    const text = adapter.cards[0].msg.text
    expect(text).toBeDefined()
    expect(text).toContain('openWaiter=42')
    expect(text).toContain('id=100')

    process.env.WEB_BASE_URL = oldEnv
  })

  it('降级时 imSummary 仍优先用作 body 内容', async () => {
    adapter.failOnce = true
    await sendQiApprovalCard({
      waiterId: 42,
      requirementId: 100,
      requirementTitle: 'test req',
      contextSummary: 'long context ' + 'a'.repeat(1000),
      imSummary: '🤖 短摘要',
      approvalKind: 'spec',
      approverIds: ['user-1'],
    })
    const text = adapter.cards[0].msg.text!
    // imSummary 整段（≤ 250）应在文本里出现
    expect(text).toContain('🤖 短摘要')
  })
})
