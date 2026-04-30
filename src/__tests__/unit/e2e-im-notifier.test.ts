import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IMAdapter } from '../../adapters/im/types.js'
import {
  notifyRunStarted,
  notifyScenarioFailed,
  notifyBugfixComplete,
  notifyRunPassed,
  notifyRunFailed,
  notifyRunAborted,
  notifyGovernorUnfixable,
} from '../../e2e/pipeline-b/im-notifier.js'
import type { ImNotifyOptions } from '../../e2e/pipeline-b/im-notifier.js'

function makeMockAdapter(): IMAdapter {
  return {
    platform: 'dingtalk',
    onMessage: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendDirectMessage: vi.fn().mockResolvedValue(undefined),
    getUserInfo: vi.fn(),
    onCardAction: vi.fn(),
    handleWebhook: vi.fn(),
  } as unknown as IMAdapter
}

function makeOpts(adapter: IMAdapter): ImNotifyOptions {
  return { adapter, groupId: 'group-123', runId: 42n }
}

describe('e2e im-notifier', () => {
  let adapter: IMAdapter
  let opts: ImNotifyOptions

  beforeEach(() => {
    adapter = makeMockAdapter()
    opts = makeOpts(adapter)
  })

  it('notifyRunStarted 发送含 runId 和 totalScenarios 的消息', async () => {
    await notifyRunStarted(opts, 5)
    expect(adapter.sendMessage).toHaveBeenCalledOnce()
    const [target, content] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(target).toEqual({ type: 'group', id: 'group-123' })
    expect(content.text).toContain('42')
    expect(content.text).toContain('5')
  })

  it('notifyRunStarted totalScenarios=0 时不报错', async () => {
    await expect(notifyRunStarted(opts, 0)).resolves.toBeUndefined()
    const [, content] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(content.text).not.toContain('跑 0')
  })

  it('notifyRunStarted 包含 admin URL 链接', async () => {
    await notifyRunStarted(opts, 3)
    const [, content] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(content.text).toContain('/e2e-runs/42')
  })

  it('notifyScenarioFailed 发送含 scenarioId 的失败消息', async () => {
    await notifyScenarioFailed(opts, 'scenario-login')
    const [target, content] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(target).toEqual({ type: 'group', id: 'group-123' })
    expect(content.text).toContain('scenario-login')
    expect(content.text).toContain('失败')
  })

  it('notifyBugfixComplete 发送含 scenarioId 的修复完成消息', async () => {
    await notifyBugfixComplete(opts, 'scenario-checkout')
    const [, content] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(content.text).toContain('scenario-checkout')
    expect(content.text).toContain('已修复')
  })

  it('notifyRunPassed 包含 fixedCount 和 mrUrl', async () => {
    await notifyRunPassed(opts, 3, 'https://gitlab.example.com/mr/99')
    const [, content] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(content.text).toContain('PASSED')
    expect(content.text).toContain('3')
    expect(content.text).toContain('https://gitlab.example.com/mr/99')
  })

  it('notifyRunPassed mrUrl=null 时不报错', async () => {
    await expect(notifyRunPassed(opts, 0, null)).resolves.toBeUndefined()
    const [, content] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(content.text).toContain('PASSED')
    expect(content.text).not.toContain('MR')
  })

  it('notifyRunFailed 包含 reason 和 FAILED 标记', async () => {
    await notifyRunFailed(opts, '超时退出')
    const [, content] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(content.text).toContain('FAILED')
    expect(content.text).toContain('超时退出')
  })

  it('notifyRunAborted 包含 reason', async () => {
    await notifyRunAborted(opts, '用户手动取消')
    const [, content] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(content.text).toContain('中止')
    expect(content.text).toContain('用户手动取消')
  })

  it('notifyGovernorUnfixable 包含 scenarioId 和 ⚠️', async () => {
    await notifyGovernorUnfixable(opts, 'scenario-payment')
    const [, content] = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(content.text).toContain('scenario-payment')
    expect(content.text).toContain('⚠️')
    expect(content.text).toContain('无法修复')
  })

  it('sendMessage 抛出时函数不向上抛（fire-and-forget 安全）', async () => {
    const throwingAdapter = {
      ...adapter,
      sendMessage: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as IMAdapter
    const throwingOpts = makeOpts(throwingAdapter)
    await expect(notifyRunStarted(throwingOpts, 1)).resolves.toBeUndefined()
    await expect(notifyScenarioFailed(throwingOpts, 'scen-1')).resolves.toBeUndefined()
    await expect(notifyRunFailed(throwingOpts, 'oops')).resolves.toBeUndefined()
  })
})
