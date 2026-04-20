/**
 * Task 3 — approval-manager / webhook-waiter thin-adapter unit tests.
 *
 * These exercise the new API shape: send IM card / register tag / on inbound
 * event call the externally-injected resumeHandler. Graph resumption itself
 * is out of scope (Task 4).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  PipelineApprovalManager,
  type ApprovalResumeParams,
} from '../../pipeline/approval-manager.js'
import {
  WebhookWaiter,
  type WebhookResumeParams,
} from '../../pipeline/webhook-waiter.js'
import {
  APPROVAL_APPROVED,
  APPROVAL_REJECTED,
} from '../../pipeline/graph-builder.js'
import type {
  IMAdapter,
  InteractiveCard,
  MessageTarget,
  TextContent,
} from '../../adapters/im/types.js'

// Minimal adapter stub: we only exercise sendDirectMessage.
function makeStubAdapter(): IMAdapter & {
  calls: Array<{ userId: string; card: InteractiveCard }>
} {
  const calls: Array<{ userId: string; card: InteractiveCard }> = []
  return {
    platform: 'dingtalk',
    onMessage: () => {},
    sendMessage: async (_t: MessageTarget, _c: TextContent) => {},
    sendCard: async (_t: MessageTarget, _c: InteractiveCard) => {},
    sendDirectMessage: async (
      userId: string,
      content: TextContent | InteractiveCard,
    ) => {
      // Only approval cards have `actions`, so narrow on that.
      if ('actions' in content) calls.push({ userId, card: content })
    },
    getUserInfo: async (userId: string) => ({
      userId,
      name: userId,
      platform: 'dingtalk' as const,
    }),
    onCardAction: () => {},
    handleWebhook: async () => {},
    calls,
  }
}

// --- PipelineApprovalManager --------------------------------------------------

describe('PipelineApprovalManager (Task 3 adapter shape)', () => {
  beforeEach(() => {
    PipelineApprovalManager.resetInstance()
  })

  it('requestCard: sends IM card and registers approvalId → (runId, stageIndex)', async () => {
    const adapter = makeStubAdapter()
    const mgr = PipelineApprovalManager.initialize([adapter])

    const approvalId = await mgr.requestCard({
      runId: 42,
      stageIndex: 1,
      approverIds: ['alice', 'bob'],
      description: '部署 prod',
    })

    expect(approvalId).toBeTruthy()
    expect(typeof approvalId).toBe('string')
    // Card sent to both approvers
    expect(adapter.calls).toHaveLength(2)
    expect(adapter.calls.map((c) => c.userId).sort()).toEqual(['alice', 'bob'])
    // Callback data carries the approvalId for later lookup
    expect(adapter.calls[0].card.callbackData.taskId).toBe(approvalId)
    expect(adapter.calls[0].card.callbackData.pipelineApproval).toBe('true')
    // Actions use the constants from graph-builder
    const values = adapter.calls[0].card.actions.map((a) => a.value)
    expect(values).toContain(APPROVAL_APPROVED)
    expect(values).toContain(APPROVAL_REJECTED)
  })

  it('handleCallback: looks up mapping and invokes resumeHandler with full params', async () => {
    const adapter = makeStubAdapter()
    const mgr = PipelineApprovalManager.initialize([adapter])
    const handler = vi.fn<(p: ApprovalResumeParams) => void>()
    mgr.setResumeHandler(handler)

    const approvalId = await mgr.requestCard({
      runId: 7,
      stageIndex: 2,
      approverIds: ['alice'],
      description: 'deploy',
    })

    await mgr.handleCallback(approvalId, APPROVAL_APPROVED, 'alice')
    // fire-and-forget — wait a tick for the scheduled handler
    await new Promise((r) => setTimeout(r, 10))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toEqual({
      approvalId,
      runId: 7,
      stageIndex: 2,
      decision: APPROVAL_APPROVED,
      approverId: 'alice',
    })
  })

  it('isPipelineApproval: true for a registered approvalId, false otherwise', async () => {
    const adapter = makeStubAdapter()
    const mgr = PipelineApprovalManager.initialize([adapter])
    const approvalId = await mgr.requestCard({
      runId: 1,
      stageIndex: 0,
      approverIds: ['alice'],
      description: 'deploy',
    })
    expect(mgr.isPipelineApproval(approvalId)).toBe(true)
    expect(mgr.isPipelineApproval('some-other-id')).toBe(false)
  })

  it('isPipelineApproval: false after handleCallback consumes the id', async () => {
    const adapter = makeStubAdapter()
    const mgr = PipelineApprovalManager.initialize([adapter])
    mgr.setResumeHandler(() => {})
    const approvalId = await mgr.requestCard({
      runId: 1,
      stageIndex: 0,
      approverIds: ['alice'],
      description: 'deploy',
    })
    expect(mgr.isPipelineApproval(approvalId)).toBe(true)
    await mgr.handleCallback(approvalId, APPROVAL_APPROVED, 'alice')
    expect(mgr.isPipelineApproval(approvalId)).toBe(false)
  })

  it('handleCallback: resumeHandler errors are logged, not propagated to caller', async () => {
    const adapter = makeStubAdapter()
    const mgr = PipelineApprovalManager.initialize([adapter])
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mgr.setResumeHandler(async () => {
      throw new Error('boom')
    })

    const approvalId = await mgr.requestCard({
      runId: 1,
      stageIndex: 0,
      approverIds: ['alice'],
      description: 'deploy',
    })

    // Must resolve, not reject, even though handler throws.
    await expect(
      mgr.handleCallback(approvalId, APPROVAL_APPROVED, 'alice'),
    ).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 10))
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('handleCallback: unknown approvalId does not throw and does not call handler', async () => {
    const adapter = makeStubAdapter()
    const mgr = PipelineApprovalManager.initialize([adapter])
    const handler = vi.fn<(p: ApprovalResumeParams) => void>()
    mgr.setResumeHandler(handler)

    await expect(
      mgr.handleCallback('no-such-id', APPROVAL_APPROVED, 'alice'),
    ).resolves.toBeUndefined()
    expect(handler).not.toHaveBeenCalled()
  })

  it('handleCallback: clears the mapping so a second callback is a no-op', async () => {
    const adapter = makeStubAdapter()
    const mgr = PipelineApprovalManager.initialize([adapter])
    const handler = vi.fn<(p: ApprovalResumeParams) => void>()
    mgr.setResumeHandler(handler)

    const approvalId = await mgr.requestCard({
      runId: 1,
      stageIndex: 0,
      approverIds: ['alice'],
      description: 'deploy',
    })

    await mgr.handleCallback(approvalId, APPROVAL_REJECTED, 'alice')
    await mgr.handleCallback(approvalId, APPROVAL_APPROVED, 'alice')
    await new Promise((r) => setTimeout(r, 10))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].decision).toBe(APPROVAL_REJECTED)
  })

  it('handleCallback: with no resumeHandler registered, swallows the decision (warn only)', async () => {
    const adapter = makeStubAdapter()
    const mgr = PipelineApprovalManager.initialize([adapter])
    // deliberately do NOT call setResumeHandler

    const approvalId = await mgr.requestCard({
      runId: 1,
      stageIndex: 0,
      approverIds: ['alice'],
      description: 'deploy',
    })

    await expect(
      mgr.handleCallback(approvalId, APPROVAL_APPROVED, 'alice'),
    ).resolves.toBeUndefined()
  })
})

// --- WebhookWaiter ------------------------------------------------------------

describe('WebhookWaiter (Task 3 adapter shape)', () => {
  beforeEach(() => {
    WebhookWaiter.resetInstance()
  })

  it('register + resume: invokes handler with { tag, runId, stageIndex, payload: { data } }', async () => {
    const waiter = WebhookWaiter.getInstance()
    const handler = vi.fn<(p: WebhookResumeParams) => void>()
    waiter.setResumeHandler(handler)

    waiter.register('mr-merge:proj:7', 99, 3)

    const matched = waiter.resume('mr-merge:proj:7', { iid: 7, action: 'merge' })
    expect(matched).toBe(true)
    // resumeHandler is fire-and-forget; wait a tick
    await new Promise((r) => setTimeout(r, 10))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toEqual({
      tag: 'mr-merge:proj:7',
      runId: 99,
      stageIndex: 3,
      payload: { data: { iid: 7, action: 'merge' } },
    })
  })

  it('resume: unregistered tag returns false and does not call handler', () => {
    const waiter = WebhookWaiter.getInstance()
    const handler = vi.fn<(p: WebhookResumeParams) => void>()
    waiter.setResumeHandler(handler)

    const matched = waiter.resume('no-such-tag', { foo: 1 })
    expect(matched).toBe(false)
    expect(handler).not.toHaveBeenCalled()
  })

  it('resume: clears the mapping so a second resume for the same tag returns false', async () => {
    const waiter = WebhookWaiter.getInstance()
    const handler = vi.fn<(p: WebhookResumeParams) => void>()
    waiter.setResumeHandler(handler)

    waiter.register('tag-x', 1, 0)
    expect(waiter.pendingCount).toBe(1)

    const first = waiter.resume('tag-x', { a: 1 })
    expect(first).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(waiter.pendingCount).toBe(0)

    const second = waiter.resume('tag-x', { a: 2 })
    expect(second).toBe(false)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('register: duplicate tag overwrites the previous entry', () => {
    const waiter = WebhookWaiter.getInstance()
    const handler = vi.fn<(p: WebhookResumeParams) => void>()
    waiter.setResumeHandler(handler)

    waiter.register('dup', 1, 0)
    waiter.register('dup', 2, 5)
    expect(waiter.pendingCount).toBe(1)

    waiter.resume('dup', { v: 'ok' })
    // The handler should have been called with the second (newer) entry
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(handler).toHaveBeenCalledTimes(1)
        expect(handler.mock.calls[0][0].runId).toBe(2)
        expect(handler.mock.calls[0][0].stageIndex).toBe(5)
        resolve()
      }, 10)
    })
  })

  it('resume with no resumeHandler registered: returns true but does not throw', () => {
    const waiter = WebhookWaiter.getInstance()
    // deliberately do NOT set a handler
    waiter.register('tag-y', 1, 0)
    const matched = waiter.resume('tag-y', { any: 'thing' })
    expect(matched).toBe(true)
    expect(waiter.pendingCount).toBe(0)
  })
})
