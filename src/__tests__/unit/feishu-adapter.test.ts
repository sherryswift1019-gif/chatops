import { describe, it, expect, vi } from 'vitest'
import { FeishuAdapter } from '../../adapters/im/feishu.js'

describe('FeishuAdapter', () => {
  const adapter = new FeishuAdapter({
    appId: 'cli_test', appSecret: 'secret', verificationToken: 'vtok'
  })

  it('handles URL verification challenge', async () => {
    const messages: unknown[] = []
    adapter.onMessage(m => { messages.push(m) })

    await adapter.handleWebhook(
      { type: 'url_verification', challenge: 'abc123', token: 'vtok' },
      {}
    )
    expect(messages).toHaveLength(0)
  })

  it('normalizes @bot message', async () => {
    const messages: unknown[] = []
    adapter.onMessage(m => { messages.push(m) })

    await adapter.handleWebhook({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1', token: 'vtok' },
      event: {
        message: {
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_1 deploy payment-service' }),
          chat_id: 'oc_group1',
          message_id: 'msg001',
        },
        sender: { sender_id: { union_id: 'user-001' }, sender_type: 'user' }
      }
    }, {})

    expect(messages).toHaveLength(1)
    const msg = messages[0] as { text: string }
    expect(msg.text).toBe('deploy payment-service')
  })
})
