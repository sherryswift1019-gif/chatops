/**
 * 审批命令纯函数解析器
 *
 * 从用户文本里解析审批命令（approve / reject / reanalyze）。
 * 不依赖 approval-manager 状态，便于单测覆盖。
 *
 * 规则（与 PipelineApprovalManager.tryHandleCommand 对齐）：
 * - 去掉前导中文 @机器人 mention + 空格
 * - 匹配 `approve <KEY>` / `reject <KEY> [reason]` / `reanalyze <KEY> [hint]`
 *   其中 KEY 可带可不带 #（例如 `approve #42` 或 `approve 42` 或 `approve uuid-str`）
 * - KEY 为 `\w+`（字母/数字/下划线），与 approval-manager 一致；approvalKey 在没有
 *   issueId 时是 randomUUID()，含字母，必须接受
 * - issueIid 字段：纯数字时解析为 number（便于下游用），否则保留原字符串
 * - 大小写不敏感（跟 approval-manager 里 /i 标志一致）
 * - 不匹配返回 null
 */
export type ApprovalCommand =
  | { kind: 'approve'; issueIid: number | string }
  | { kind: 'reject'; issueIid: number | string; reason?: string }
  | { kind: 'reanalyze'; issueIid: number | string; hint?: string }

// 注意：必须与 approval-manager.ts:62 tryHandleCommand 正则保持一致（\w+ 而非 \d+），
// 否则 claude-runner Step 0 的 parser 先判断会把合法 UUID key 命令误判为非命令。
const CMD_RE = /^(approve|reject|reanalyze)\s+#?(\w+)(?:\s+(.+))?$/i

/**
 * 解析审批命令。
 *
 * @param text 用户输入文本，可能包含 @机器人 前缀 / 前后空格
 * @returns 解析成功的命令对象，或 null（不是命令 / 非法格式）
 */
export function parseApprovalCommand(text: string): ApprovalCommand | null {
  if (typeof text !== 'string') return null

  // 去掉中文 @机器人 mention（如 "@助手 approve #42"）
  const withoutMention = text.replace(/@[\u4e00-\u9fff]+/g, '').trim()
  if (withoutMention === '') return null

  const m = withoutMention.match(CMD_RE)
  if (!m) return null

  const [, action, key, rest] = m
  const actionLower = action.toLowerCase()

  // 纯数字则转 number，否则保留字符串（UUID 等非数字 key）
  const issueIid: number | string = /^\d+$/.test(key) ? Number(key) : key
  if (typeof issueIid === 'number' && issueIid <= 0) return null

  const tail = rest ? rest.trim() : undefined

  if (actionLower === 'approve') {
    return { kind: 'approve', issueIid }
  }
  if (actionLower === 'reject') {
    return tail ? { kind: 'reject', issueIid, reason: tail } : { kind: 'reject', issueIid }
  }
  // reanalyze
  return tail ? { kind: 'reanalyze', issueIid, hint: tail } : { kind: 'reanalyze', issueIid }
}
