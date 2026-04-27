/**
 * dryrun-webhook-router — dry-run 命名空间中 wait_webhook 节点的路由辅助。
 *
 * 主要职责：
 *   1. 生成带 dryrunSessionId 参数的 webhookUrl，供前端/外部系统触发 dry-run resume
 *   2. 解析 webhook 请求里的 dryrunSessionId，映射到 `dryrun-<sid>` thread_id
 *   3. 维护 dry-run webhook waiter 注册表（sessionId → resolveCallback）
 *
 * 注意：HTTP 接收端点（/webhook/generic）由 T7 admin routes 实现，
 * 届时调用本模块的 `dispatchDryRunWebhook()` 完成路由分发。
 *
 * v1 简化（plan §v1 accepted）：
 *   im_input 节点在 dry-run 时走 beforeSideEffect fallback（不支持 IM 群消息触发），
 *   本模块只处理 wait_webhook 的 dry-run 路由，im-router.ts 改动推迟到 T7。
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * 给定 dry-run sessionId 与 wait_webhook 节点的 webhookTag，
 * 生成外部触发 URL。
 *
 * @example
 *   buildDryRunWebhookUrl({
 *     baseUrl: 'https://chatops.example.com',
 *     webhookTag: 'deploy-done',
 *     sessionId: 'abc123',
 *   })
 *   // → 'https://chatops.example.com/webhook/generic?tag=deploy-done&dryrunSessionId=abc123'
 */
export function buildDryRunWebhookUrl(opts: {
  baseUrl: string
  webhookTag: string
  sessionId: string
}): string {
  const u = new URL(opts.baseUrl + '/webhook/generic')
  u.searchParams.set('tag', opts.webhookTag)
  u.searchParams.set('dryrunSessionId', opts.sessionId)
  return u.toString()
}

/**
 * 给定 webhook 请求里的 dryrunSessionId（可空），返回应该 resume 的 thread_id。
 *
 *   - 有 dryrunSessionId → `dryrun-<sessionId>`（dry-run 命名空间）
 *   - 无 dryrunSessionId → null（让现有 prod WebhookWaiter 处理）
 */
export function resolveWebhookThreadId(dryrunSessionId: string | undefined): string | null {
  if (!dryrunSessionId) return null
  return `dryrun-${dryrunSessionId}`
}

// ---------------------------------------------------------------------------
// In-memory waiter registry
// ---------------------------------------------------------------------------

type WebhookWaiterCallback = (payload: unknown) => void

/** sessionId → callback waiting for the webhook payload */
const dryRunWebhookWaiters = new Map<string, WebhookWaiterCallback>()

/**
 * Register a dry-run session as waiting for a webhook.
 * Called by dryrun-runner when a wait_webhook interrupt fires in dry-run mode.
 *
 * If a waiter already exists for this sessionId (re-registration), it is
 * replaced — consistent with WebhookWaiter prod behaviour.
 */
export function registerDryRunWebhookWaiter(
  sessionId: string,
  callback: WebhookWaiterCallback,
): void {
  dryRunWebhookWaiters.set(sessionId, callback)
  console.log(`[DryRunWebhookRouter] registered waiter for session=${sessionId}`)
}

/**
 * Unregister a dry-run webhook waiter (e.g. on timeout or session cleanup).
 */
export function unregisterDryRunWebhookWaiter(sessionId: string): void {
  dryRunWebhookWaiters.delete(sessionId)
}

/**
 * Dispatch an incoming webhook payload to the waiting dry-run session.
 *
 * Called by the generic webhook HTTP handler (T7) when
 * `req.query.dryrunSessionId` is present.
 *
 * Returns `true` if a waiting session was found and notified;
 * `false` if no such waiter is registered.
 */
export function dispatchDryRunWebhook(sessionId: string, payload: unknown): boolean {
  const callback = dryRunWebhookWaiters.get(sessionId)
  if (!callback) return false

  dryRunWebhookWaiters.delete(sessionId)

  console.log(`[DryRunWebhookRouter] dispatching webhook to session=${sessionId}`)
  // Fire synchronously (callback may start async work internally).
  callback(payload)
  return true
}

/**
 * Number of currently-registered dry-run webhook waiters.
 * Useful for monitoring / tests.
 */
export function dryRunWebhookWaiterCount(): number {
  return dryRunWebhookWaiters.size
}

/**
 * Test utility: clear all registered waiters.
 */
export function resetDryRunWebhookWaiters(): void {
  dryRunWebhookWaiters.clear()
}
