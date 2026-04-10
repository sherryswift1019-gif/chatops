import { describe, it, expect, vi } from 'vitest'
import { DingTalkAdapter } from '../../adapters/im/dingtalk.js'
import crypto from 'crypto'

function makeSignature(secret: string, timestamp: string): string {
  const msg = `${timestamp}\n${secret}`
  return encodeURIComponent(
    crypto.createHmac('sha256', secret).update(msg).digest('base64')
  )
}

describe('DingTalkAdapter', () => {
  const secret = 'test-secret'
  const adapter = new DingTalkAdapter({ appSecret: secret, accessToken: 'token' })

  it('normalizes @bot message from webhook payload', async () => {
    const messages: unknown[] = []
    adapter.onMessage(m => { messages.push(m) })

    const ts = String(Date.now())
    const payload = {
      msgtype: 'text',
      text: { content: '@bot deploy payment-service' },
      senderId: 'user-001',
      senderNick: '张三',
      conversationId: 'cid-001',
    }

    await adapter.handleWebhook(payload, {
      'x-dingtalk-timestamp': ts,
      'x-dingtalk-sign': makeSignature(secret, ts),
    })

    expect(messages).toHaveLength(1)
    const msg = messages[0] as { text: string; userId: string }
    expect(msg.text).toBe('deploy payment-service')
    expect(msg.userId).toBe('user-001')
  })

  it('rejects webhook with invalid signature', async () => {
    const ts = String(Date.now())
    await expect(
      adapter.handleWebhook({}, { 'x-dingtalk-timestamp': ts, 'x-dingtalk-sign': 'bad' })
    ).rejects.toThrow('Invalid signature')
  })
})
