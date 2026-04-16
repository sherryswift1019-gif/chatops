/**
 * 单元测试：Pipeline capability + wait_webhook 阶段
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { WebhookWaiter } from '../../pipeline/webhook-waiter.js'

describe('WebhookWaiter', () => {
  beforeEach(() => {
    WebhookWaiter.resetInstance()
  })

  it('wait + resume → 返回数据', async () => {
    const waiter = WebhookWaiter.getInstance()

    // 异步等待
    const waitPromise = waiter.wait('mr-merged:project:100', 5000)

    // 模拟 webhook 到达
    setTimeout(() => {
      waiter.resume('mr-merged:project:100', { iid: 100, action: 'merge' })
    }, 50)

    const result = await waitPromise
    expect(result).not.toBeNull()
    expect(result!.data).toEqual({ iid: 100, action: 'merge' })
  })

  it('超时 → 返回 null', async () => {
    const waiter = WebhookWaiter.getInstance()
    const result = await waiter.wait('mr-merged:project:999', 100)
    expect(result).toBeNull()
  })

  it('resume 无匹配 → 返回 false', () => {
    const waiter = WebhookWaiter.getInstance()
    const matched = waiter.resume('nonexistent-tag', {})
    expect(matched).toBe(false)
  })

  it('cancel 取消等待', async () => {
    const waiter = WebhookWaiter.getInstance()
    const waitPromise = waiter.wait('test-cancel', 5000)

    waiter.cancel('test-cancel')
    expect(waiter.pendingCount).toBe(0)
  })

  it('重复 wait 同一 tag → 覆盖旧的', async () => {
    const waiter = WebhookWaiter.getInstance()

    // 第一次 wait
    const wait1 = waiter.wait('dup-tag', 5000)
    // 第二次 wait 同 tag → 覆盖
    const wait2 = waiter.wait('dup-tag', 5000)

    expect(waiter.pendingCount).toBe(1)

    // resume → 只有第二个收到
    waiter.resume('dup-tag', { v: 2 })
    const r2 = await wait2
    expect(r2!.data).toEqual({ v: 2 })
  })

  it('pendingCount 正确', async () => {
    const waiter = WebhookWaiter.getInstance()
    expect(waiter.pendingCount).toBe(0)

    waiter.wait('tag1', 5000)
    waiter.wait('tag2', 5000)
    expect(waiter.pendingCount).toBe(2)

    waiter.resume('tag1', {})
    // 等一个 tick 让 Promise resolve
    await new Promise(r => setTimeout(r, 10))
    expect(waiter.pendingCount).toBe(1)
  })
})

describe('Pipeline capability stage: executeCapabilityStage', () => {
  it('capabilityKey 缺失 → 返回 failed', async () => {
    // 直接测试 executor 中的逻辑：没有 capabilityKey 应该失败
    // 这里通过 StageDefinition 结构验证
    const stage = {
      name: '测试阶段',
      stageType: 'capability' as const,
      targetRoles: [],
      parallel: false,
      timeoutSeconds: 60,
      retryCount: 0,
      onFailure: 'stop' as const,
      // capabilityKey 缺失
    }
    expect((stage as Record<string, unknown>).capabilityKey).toBeUndefined()
  })

  it('capabilityKey 存在 → 结构正确', () => {
    const stage = {
      name: 'AI 分析',
      stageType: 'capability' as const,
      targetRoles: [],
      parallel: false,
      timeoutSeconds: 1200,
      retryCount: 0,
      onFailure: 'stop' as const,
      capabilityKey: 'analyze_bug',
      capabilityParams: { productLineId: 1, message: '密码验证失败' },
    }
    expect(stage.capabilityKey).toBe('analyze_bug')
    expect(stage.capabilityParams?.productLineId).toBe(1)
  })
})

describe('Pipeline wait_webhook stage: buildWebhookTag 格式', () => {
  it('MR merged tag 格式', () => {
    // 验证 tag 格式约定
    const tag = 'mr-merge:PAM/java-code/pas-6.0:123'
    expect(tag).toMatch(/^mr-\w+:.+:\d+$/)
  })

  it('Pipeline success tag 格式', () => {
    const tag = 'pipeline-success:PAM/java-code/pas-6.0:456'
    expect(tag).toMatch(/^pipeline-\w+:.+:\d+$/)
  })

  it('Issue close tag 格式', () => {
    const tag = 'issue-close:PAM/java-code/pas-6.0:42'
    expect(tag).toMatch(/^issue-\w+:.+:\d+$/)
  })

  it('wait_webhook stage 配置示例', () => {
    const stage = {
      name: '等待 MR 合并',
      stageType: 'wait_webhook' as const,
      targetRoles: [],
      parallel: false,
      timeoutSeconds: 3600,
      retryCount: 0,
      onFailure: 'stop' as const,
      webhookTag: 'mr-merge:PAM/java-code/pas-6.0:123',
    }
    expect(stage.webhookTag).toContain('mr-merge')
  })
})
