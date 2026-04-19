/**
 * 审批命令纯函数解析器
 *
 * 从用户文本里解析审批命令（approve / reject / reanalyze）。
 * 不依赖 approval-manager 状态，便于单测覆盖。
 *
 * 规则（与 PipelineApprovalManager.tryHandleCommand 对齐）：
 * - 去掉前导中文 @机器人 mention + 空格
 * - 匹配 `approve <N>` / `reject <N> [reason]` / `reanalyze <N> [hint]`
 *   其中 N 可带可不带 #（例如 `approve #42` 或 `approve 42`）
 * - issueIid 限制为全数字，保证转 number 安全
 * - 大小写不敏感（跟 approval-manager 里 /i 标志一致）
 * - 不匹配返回 null
 */
export type ApprovalCommand =
  | { kind: 'approve'; issueIid: number }
  | { kind: 'reject'; issueIid: number; reason?: string }
  | { kind: 'reanalyze'; issueIid: number; hint?: string }

const CMD_RE = /^(approve|reject|reanalyze)\s+#?(\d+)(?:\s+(.+))?$/i

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
  const issueIid = Number(key)
  if (!Number.isFinite(issueIid) || issueIid <= 0) return null

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
