import { randomBytes } from 'crypto'

/**
 * 生成 url-safe base64 token（去 padding）。
 * 32 字节 = 43 个 base64url 字符，熵 256 bit。
 */
export function generateWebhookToken(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

/** 列表展示：仅暴露前 8 字符 + 省略号。 */
export function maskToken(token: string): string {
  return token.slice(0, 8) + '…'
}
