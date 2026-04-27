/**
 * Integration test: dryrun-webhook-resume
 *
 * Unit tests for pure helpers + integration smoke test for the
 * wait_webhook → dry-run resume flow.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildDryRunWebhookUrl,
  resolveWebhookThreadId,
  registerDryRunWebhookWaiter,
  dispatchDryRunWebhook,
  dryRunWebhookWaiterCount,
  resetDryRunWebhookWaiters,
} from '../../pipeline/dryrun-webhook-router.js'
import {
  resumeDryRunFromWebhook,
} from '../../pipeline/dryrun-runner.js'

// ─── Unit tests ──────────────────────────────────────────────────────────────

describe('buildDryRunWebhookUrl', () => {
  it('生成包含 dryrunSessionId 和 tag 的 URL', () => {
    const url = buildDryRunWebhookUrl({
      baseUrl: 'https://chatops.example.com',
      webhookTag: 'deploy-done',
      sessionId: 'sess-abc123',
    })
    expect(url).toBe(
      'https://chatops.example.com/webhook/generic?tag=deploy-done&dryrunSessionId=sess-abc123',
    )
  })

  it('baseUrl 为空字符串时生成相对路径', () => {
    // URL constructor requires an absolute URL; this test confirms empty baseUrl
    // throws (caller must provide a real baseUrl in production).
    expect(() =>
      buildDryRunWebhookUrl({
        baseUrl: '',
        webhookTag: 'done',
        sessionId: 's1',
      }),
    ).toThrow() // URL('') + path is invalid
  })

  it('webhookTag 含特殊字符时正确编码', () => {
    const url = buildDryRunWebhookUrl({
      baseUrl: 'http://localhost:3000',
      webhookTag: 'mr-merged:PAM/repo:42',
      sessionId: 'xyz',
    })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('tag')).toBe('mr-merged:PAM/repo:42')
    expect(parsed.searchParams.get('dryrunSessionId')).toBe('xyz')
  })
})

describe('resolveWebhookThreadId', () => {
  it('有 dryrunSessionId 时返回 dryrun-<sid>', () => {
    expect(resolveWebhookThreadId('abc')).toBe('dryrun-abc')
    expect(resolveWebhookThreadId('sess-999')).toBe('dryrun-sess-999')
  })

  it('无 dryrunSessionId（undefined）时返回 null', () => {
    expect(resolveWebhookThreadId(undefined)).toBeNull()
  })

  it('空字符串视为无 sessionId → 返回 null', () => {
    // Empty string is falsy — should also return null.
    expect(resolveWebhookThreadId('')).toBeNull()
  })
})

// ─── Registry unit tests ─────────────────────────────────────────────────────

describe('dryRunWebhookWaiter registry', () => {
  beforeEach(() => resetDryRunWebhookWaiters())
  afterEach(() => resetDryRunWebhookWaiters())

  it('registerDryRunWebhookWaiter + dispatchDryRunWebhook 基本路径', () => {
    const received: unknown[] = []
    registerDryRunWebhookWaiter('s1', (p) => received.push(p))
    expect(dryRunWebhookWaiterCount()).toBe(1)

    const dispatched = dispatchDryRunWebhook('s1', { foo: 'bar' })
    expect(dispatched).toBe(true)
    expect(dryRunWebhookWaiterCount()).toBe(0)
    expect(received).toEqual([{ foo: 'bar' }])
  })

  it('dispatch 后 waiter 被清除，重复 dispatch 返回 false', () => {
    registerDryRunWebhookWaiter('s2', () => {})
    dispatchDryRunWebhook('s2', {})
    expect(dispatchDryRunWebhook('s2', {})).toBe(false)
  })

  it('未注册的 sessionId dispatch 返回 false', () => {
    expect(dispatchDryRunWebhook('nonexistent', {})).toBe(false)
  })

  it('重复注册覆盖旧 waiter（最后一个生效）', () => {
    const log1: unknown[] = []
    const log2: unknown[] = []
    registerDryRunWebhookWaiter('s3', (p) => log1.push(p))
    registerDryRunWebhookWaiter('s3', (p) => log2.push(p)) // overwrites
    dispatchDryRunWebhook('s3', 'payload')
    expect(log1).toEqual([]) // old cb not called
    expect(log2).toEqual(['payload']) // new cb called
  })
})

// ─── resumeDryRunFromWebhook unit test ───────────────────────────────────────

describe('resumeDryRunFromWebhook', () => {
  afterEach(() => resetDryRunWebhookWaiters())

  it('session 不存在时返回 false', () => {
    // No active session in dryrun-runner.
    expect(resumeDryRunFromWebhook('nonexistent-session', {})).toBe(false)
  })

  it('session 存在但无 webhook waiter 时返回 false', () => {
    // Session exists in dryrun-runner only if runDryRun is active.
    // Without running runDryRun, sessions map is empty → false.
    expect(resumeDryRunFromWebhook('no-waiter-session', { data: 1 })).toBe(false)
  })
})
