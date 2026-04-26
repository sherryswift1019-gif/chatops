import { registerNodeType } from './registry.js'
import type { ExecutionContext, NodeExecutionResult } from './types.js'
import { sendImDirect } from '../im-notifier.js'

/**
 * Phase 3 T10 — dm executor。
 *
 * 通过 IM adapter 给指定 user 发私聊文本消息。
 * 真正的 IMAdapter.sendDirectMessage 由 server.ts 启动时通过 registerImDmSender
 * 注入到 im-notifier 的 dm registry —— executor 不直接持有 adapter 实例。
 *
 * params:
 *   - platform: 'dingtalk' | 'feishu' (必填)
 *   - userId: string (必填)
 *   - text?: string  (与 card 二选一; v1 仅支持 text, card 字段忽略并回 fail)
 *   - card?: object (v1 不支持; 给出 explicit error)
 *
 * 成功: status='success', output={messageId, deliveredAt}
 * 失败: adapter 抛错 / 平台 sender 未注册 / 无 text → status='failed', error=...
 */
registerNodeType({
  key: 'dm',
  async execute(
    params: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<NodeExecutionResult> {
    const platform = params.platform as string | undefined
    const userId = params.userId as string | undefined
    const text = params.text as string | undefined
    const card = params.card as Record<string, unknown> | undefined

    if (!platform) {
      return { status: 'failed', output: {}, error: 'dm executor requires params.platform' }
    }
    if (!userId) {
      return { status: 'failed', output: {}, error: 'dm executor requires params.userId' }
    }
    if (card && !text) {
      // v1 不支持 card; phase 3 v1 范围内仅文本
      return {
        status: 'failed',
        output: {},
        error: 'dm executor v1 only supports text; card is not yet implemented',
      }
    }
    if (!text) {
      return { status: 'failed', output: {}, error: 'dm executor requires params.text' }
    }

    try {
      const result = await sendImDirect(platform, userId, text)
      return {
        status: 'success',
        output: {
          messageId: result.messageId ?? '',
          deliveredAt: new Date().toISOString(),
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { status: 'failed', output: {}, error: msg }
    }
  },
})
