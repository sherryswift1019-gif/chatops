/**
 * E2E 模式下的内存存储：
 *
 * 1. Mock 响应队列：按 key FIFO 存放 Claude 调用的 mock 返回值。
 *    key 约定：
 *      - `analyze_bug-filter`          — runFilterStage 响应
 *      - `analyze_bug-detail`          — runDetailStage 响应
 *      - `fix-<projectPath>`           — runFixForProject 响应（projectPath 按原样保留 URI 斜杠）
 *      - `review-<mrIid>`              — runClaudeReview 响应
 *
 * 2. MockIMAdapter 发送的消息记录：e2e 测试通过 GET /admin/_e2e/messages 查询做断言。
 *
 * 本模块仅在 E2E_MODE=1 / CLAUDE_MOCK=1 环境下有意义，生产代码路径不会碰这些 API。
 */

export type MockResponse = unknown

const mockQueues = new Map<string, MockResponse[]>()

export function setMockResponse(key: string, response: MockResponse): void {
  const queue = mockQueues.get(key) ?? []
  queue.push(response)
  mockQueues.set(key, queue)
}

export function popMockResponse(key: string): MockResponse | undefined {
  const queue = mockQueues.get(key)
  if (!queue || queue.length === 0) return undefined
  const head = queue.shift()
  if (queue.length === 0) mockQueues.delete(key)
  return head
}

/**
 * Pop + 校验必需字段，失败时抛明确错误（而非 unsafe cast 后下游诡异报错）。
 *
 * @param key         mock 队列 key
 * @param requiredFields 期望存在（非 undefined）的顶层字段名
 * @throws 若队列为空、或响应不是 object、或缺字段
 */
export function popMockResponseValidated<T>(key: string, requiredFields: (keyof T)[]): T {
  const raw = popMockResponse(key)
  if (raw === undefined) {
    throw new Error(`E2E: no mock response queued for ${key}`)
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`E2E: mock response for ${key} must be object, got ${typeof raw}`)
  }
  const obj = raw as Record<string, unknown>
  for (const field of requiredFields) {
    if (obj[field as string] === undefined) {
      throw new Error(`E2E: mock response for ${key} missing required field "${String(field)}"`)
    }
  }
  return raw as T
}

export function resetMockResponses(): void {
  mockQueues.clear()
}

export interface RecordedMessage {
  kind: 'group' | 'direct' | 'card'
  to: string
  text?: string
  card?: unknown
  timestamp: number
}

const sentMessages: RecordedMessage[] = []

export function recordSentMessage(msg: Omit<RecordedMessage, 'timestamp'>): void {
  sentMessages.push({ ...msg, timestamp: Date.now() })
}

export function getSentMessages(
  filter?: { kind?: RecordedMessage['kind']; to?: string },
): RecordedMessage[] {
  if (!filter) return [...sentMessages]
  return sentMessages.filter(m => {
    if (filter.kind && m.kind !== filter.kind) return false
    if (filter.to && m.to !== filter.to) return false
    return true
  })
}

export function clearSentMessages(): void {
  sentMessages.length = 0
}

export function isE2EMode(): boolean {
  return process.env.E2E_MODE === '1'
}

export function isClaudeMock(): boolean {
  return process.env.CLAUDE_MOCK === '1'
}
