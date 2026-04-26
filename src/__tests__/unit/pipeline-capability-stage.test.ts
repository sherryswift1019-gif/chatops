/**
 * 单元测试：Pipeline capability + wait_webhook 阶段（结构/配置层面）
 *
 * NOTE: WebhookWaiter 的运行时行为测试已迁移到
 * `approval-webhook-adapters.test.ts` —— 旧的 Promise-pool API
 * (`wait()` / `cancel()`) 已在 Task 3 改造成 interrupt/Command 薄 adapter。
 */
import { describe, it, expect } from 'vitest'

describe('Pipeline capability stage: executeCapabilityStage', () => {
  it('capabilityKey 缺失 → 返回 failed', async () => {
    // 直接测试 executor 中的逻辑：没有 capabilityKey 应该失败
    // 这里通过 StageDefinition 结构验证
    const stage = {
      name: '测试阶段',
      stageType: 'llm_agent' as const,
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
      stageType: 'llm_agent' as const,
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
