import { describe, it, expect } from 'vitest'
import { generateWebhookToken, maskToken } from '../../pipeline/webhook-token.js'

describe('generateWebhookToken', () => {
  it('生成 43 字符 url-safe base64', () => {
    const token = generateWebhookToken()
    expect(token).toHaveLength(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('两次调用结果不同', () => {
    expect(generateWebhookToken()).not.toBe(generateWebhookToken())
  })
})

describe('maskToken', () => {
  it('返回前 8 字符 + 省略号', () => {
    expect(maskToken('abcdefghijklmnop')).toBe('abcdefgh…')
  })
})
