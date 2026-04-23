import { registerTool } from './index.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'
import { findRuleById } from '../prd/rules.js'
import {
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * submit_review MCP 工具（V2.0）：
 *
 * PRD 审查 Agent 完成审查后调用本工具提交结构化 findings，
 * 替代 V1 "LLM 输出自由文本 JSON" 的脆弱契约。
 *
 * 设计要点（见 docs/prds/prd-agent-v2-iteration.md §7.4）：
 *   - MCP 层做 schema 强校验：枚举错误 / 类型错误 / required 缺失 → 工具返回失败
 *     LLM 收到失败消息可自行修正后重试，而不是污染 review_result 持久化
 *   - **跨进程 buffer**：MCP server 以子进程形式被 Porygon 启动，tool 写入进程内 Map
 *     对父进程不可见。所以持久化走文件系统：/tmp/chatops-submit-review-{taskId}.json
 *     runPrdReview 在 Claude 返回后调用 takeSubmittedReview(taskId) 读取并删除
 *   - 非幂等：同一 taskId 多次 submit 以最后一次为准，并在 output 明示覆盖
 */

export type SubmitReviewStatus = 'pass' | 'blocked' | 'warnings_only'
export type SubmitReviewSeverity = 'blocker' | 'warning' | 'info'
export type SubmitReviewOwnership = 'pm' | 'admin' | 'business'
export type SubmitReviewAction = 'approve' | 'approve_with_edits' | 'reject'
export type SubmitReviewConfidence = 'high' | 'medium' | 'low'

export interface SubmitReviewFinding {
  ruleId: string
  severity: SubmitReviewSeverity
  location: string
  issue: string
  suggestion?: string
  canAutoFix?: boolean
  autoFixBlockedReason?: string | null
  ownership?: SubmitReviewOwnership
}

export interface SubmitReviewPayload {
  status: SubmitReviewStatus
  summary?: string
  findings: SubmitReviewFinding[]
  recommendation?: {
    action: SubmitReviewAction
    reason: string
    confidence?: SubmitReviewConfidence
  }
}

// =============================================================================
// 跨进程 buffer（文件系统）
// =============================================================================

const BUFFER_DIR = join(tmpdir(), 'chatops-submit-review')

function ensureBufferDir(): void {
  if (!existsSync(BUFFER_DIR)) {
    mkdirSync(BUFFER_DIR, { recursive: true })
  }
}

function bufferPath(taskId: string): string {
  // 规避路径注入：仅保留字母数字 / 常见分隔
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_')
  return join(BUFFER_DIR, `${safe}.json`)
}

/** 读取 + 清空 buffer 文件；未收到提交返回 null */
export function takeSubmittedReview(taskId: string): SubmitReviewPayload | null {
  const p = bufferPath(taskId)
  if (!existsSync(p)) return null
  try {
    const raw = readFileSync(p, 'utf-8')
    unlinkSync(p)
    return JSON.parse(raw) as SubmitReviewPayload
  } catch (err) {
    console.error(`[submit_review] 读取 buffer 失败 taskId=${taskId}:`, err)
    try { unlinkSync(p) } catch { /* ignore */ }
    return null
  }
}

/** 主动清空（runPrdReview 在每轮开始前调用，防跨轮脏数据） */
export function clearSubmittedReview(taskId: string): void {
  const p = bufferPath(taskId)
  if (existsSync(p)) {
    try { unlinkSync(p) } catch { /* ignore */ }
  }
}

/** 测试/诊断用：读取但不删除 */
export function peekSubmittedReview(taskId: string): SubmitReviewPayload | null {
  const p = bufferPath(taskId)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SubmitReviewPayload
  } catch {
    return null
  }
}

// =============================================================================
// Schema 校验（手写，不引入 ajv/zod 以减少依赖）
// =============================================================================

const STATUS_ENUM: SubmitReviewStatus[] = ['pass', 'blocked', 'warnings_only']
const SEVERITY_ENUM: SubmitReviewSeverity[] = ['blocker', 'warning', 'info']
const OWNERSHIP_ENUM: SubmitReviewOwnership[] = ['pm', 'admin', 'business']
const ACTION_ENUM: SubmitReviewAction[] = ['approve', 'approve_with_edits', 'reject']
const CONFIDENCE_ENUM: SubmitReviewConfidence[] = ['high', 'medium', 'low']

interface ValidationOk {
  ok: true
  value: SubmitReviewPayload
}
interface ValidationErr {
  ok: false
  errors: string[]
}

export function validateSubmitReviewPayload(
  raw: unknown
): ValidationOk | ValidationErr {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['顶层必须是对象'] }
  }
  const r = raw as Record<string, unknown>

  // 容错：LLM 常把复杂嵌套字段误作 JSON 字符串传入（findings/recommendation）。
  // 在正式 schema 校验前尝试 parse 一次；仍失败则交给下方 Array.isArray/typeof 校验报错。
  if (typeof r.findings === 'string') {
    try {
      const parsed = JSON.parse(r.findings)
      if (Array.isArray(parsed)) r.findings = parsed
    } catch { /* 留给下方校验报 "必须是数组" */ }
  }
  if (typeof r.recommendation === 'string') {
    try {
      const parsed = JSON.parse(r.recommendation)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        r.recommendation = parsed
      }
    } catch { /* 留给下方校验报错 */ }
  }

  // status
  if (typeof r.status !== 'string' || !STATUS_ENUM.includes(r.status as SubmitReviewStatus)) {
    errors.push(`status 必须为 ${STATUS_ENUM.join('/')} 之一，收到 ${JSON.stringify(r.status)}`)
  }

  // findings
  if (!Array.isArray(r.findings)) {
    errors.push('findings 必须是数组')
  } else {
    r.findings.forEach((f, i) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        errors.push(`findings[${i}] 必须是对象`)
        return
      }
      const ff = f as Record<string, unknown>
      if (typeof ff.ruleId !== 'string' || !ff.ruleId) {
        errors.push(`findings[${i}].ruleId 必须为非空字符串`)
      } else if (!findRuleById(ff.ruleId as string)) {
        errors.push(
          `findings[${i}].ruleId = "${ff.ruleId}" 不在 rules.ts 注册清单中；可选 id 见系统 prompt`
        )
      }
      if (
        typeof ff.severity !== 'string' ||
        !SEVERITY_ENUM.includes(ff.severity as SubmitReviewSeverity)
      ) {
        errors.push(
          `findings[${i}].severity 必须为 ${SEVERITY_ENUM.join('/')} 之一，收到 ${JSON.stringify(ff.severity)}`
        )
      }
      if (typeof ff.location !== 'string' || !ff.location) {
        errors.push(`findings[${i}].location 必须为非空字符串`)
      }
      if (typeof ff.issue !== 'string' || !ff.issue) {
        errors.push(`findings[${i}].issue 必须为非空字符串`)
      }
      if (ff.suggestion !== undefined && typeof ff.suggestion !== 'string') {
        errors.push(`findings[${i}].suggestion 必须为字符串或省略`)
      }
      if (ff.canAutoFix !== undefined && typeof ff.canAutoFix !== 'boolean') {
        errors.push(`findings[${i}].canAutoFix 必须为布尔值或省略`)
      }
      if (
        ff.autoFixBlockedReason !== undefined &&
        ff.autoFixBlockedReason !== null &&
        typeof ff.autoFixBlockedReason !== 'string'
      ) {
        errors.push(`findings[${i}].autoFixBlockedReason 必须为字符串/null/省略`)
      }
      if (
        ff.ownership !== undefined &&
        (typeof ff.ownership !== 'string' ||
          !OWNERSHIP_ENUM.includes(ff.ownership as SubmitReviewOwnership))
      ) {
        errors.push(
          `findings[${i}].ownership 必须为 ${OWNERSHIP_ENUM.join('/')} 之一或省略`
        )
      }
    })
  }

  // recommendation (可选)
  if (r.recommendation !== undefined && r.recommendation !== null) {
    if (typeof r.recommendation !== 'object' || Array.isArray(r.recommendation)) {
      errors.push('recommendation 必须是对象或省略')
    } else {
      const rec = r.recommendation as Record<string, unknown>
      if (
        typeof rec.action !== 'string' ||
        !ACTION_ENUM.includes(rec.action as SubmitReviewAction)
      ) {
        errors.push(
          `recommendation.action 必须为 ${ACTION_ENUM.join('/')} 之一，收到 ${JSON.stringify(rec.action)}`
        )
      }
      if (typeof rec.reason !== 'string' || !rec.reason) {
        errors.push('recommendation.reason 必须为非空字符串')
      }
      if (
        rec.confidence !== undefined &&
        (typeof rec.confidence !== 'string' ||
          !CONFIDENCE_ENUM.includes(rec.confidence as SubmitReviewConfidence))
      ) {
        errors.push(
          `recommendation.confidence 必须为 ${CONFIDENCE_ENUM.join('/')} 之一或省略`
        )
      }
    }
  }

  // summary (可选)
  if (r.summary !== undefined && typeof r.summary !== 'string') {
    errors.push('summary 必须为字符串或省略')
  }

  if (errors.length > 0) return { ok: false, errors }

  const payload: SubmitReviewPayload = {
    status: r.status as SubmitReviewStatus,
    summary: typeof r.summary === 'string' ? r.summary : undefined,
    findings: (r.findings as Record<string, unknown>[]).map((f) => ({
      ruleId: f.ruleId as string,
      severity: f.severity as SubmitReviewSeverity,
      location: f.location as string,
      issue: f.issue as string,
      suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
      canAutoFix: typeof f.canAutoFix === 'boolean' ? f.canAutoFix : undefined,
      autoFixBlockedReason:
        typeof f.autoFixBlockedReason === 'string' ? f.autoFixBlockedReason : undefined,
      ownership:
        typeof f.ownership === 'string'
          ? (f.ownership as SubmitReviewOwnership)
          : undefined,
    })),
    recommendation: r.recommendation
      ? {
          action: (r.recommendation as Record<string, unknown>).action as SubmitReviewAction,
          reason: (r.recommendation as Record<string, unknown>).reason as string,
          confidence:
            typeof (r.recommendation as Record<string, unknown>).confidence === 'string'
              ? ((r.recommendation as Record<string, unknown>).confidence as SubmitReviewConfidence)
              : undefined,
        }
      : undefined,
  }
  return { ok: true, value: payload }
}

// =============================================================================
// Tool 定义
// =============================================================================

const submitReviewTool: AgentTool = {
  name: 'submit_review',
  description:
    '提交 PRD 自审结果（V2.0 合法出口）。审查完成后必须且只能调用一次本工具，不要另输出自由文本 JSON。schema 校验失败时工具返回错误，请按提示修正后再次调用。',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    required: ['status', 'findings'],
    properties: {
      status: {
        type: 'string',
        enum: STATUS_ENUM,
        description: '审查总体结果：blocked / warnings_only / pass',
      },
      summary: { type: 'string', description: '一句话总结（可选）' },
      findings: {
        type: 'array',
        description: '审查发现的问题列表；无问题传空数组',
        items: {
          type: 'object',
          required: ['ruleId', 'severity', 'location', 'issue'],
          properties: {
            ruleId: {
              type: 'string',
              description: '对应 rules.ts 规则 id（见系统 prompt 第二部分列表）',
            },
            severity: { type: 'string', enum: SEVERITY_ENUM },
            location: {
              type: 'string',
              description: '章节或功能名定位（例如 "3.2 CSV 批量导入"）',
            },
            issue: { type: 'string', description: '具体问题描述' },
            suggestion: { type: 'string', description: '修复建议' },
            canAutoFix: { type: 'boolean' },
            autoFixBlockedReason: { type: ['string', 'null'] },
            ownership: { type: 'string', enum: OWNERSHIP_ENUM },
          },
        },
      },
      recommendation: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ACTION_ENUM },
          reason: { type: 'string' },
          confidence: { type: 'string', enum: CONFIDENCE_ENUM },
        },
        required: ['action', 'reason'],
      },
    },
  },

  async execute(params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const result = validateSubmitReviewPayload(params)
    if (!result.ok) {
      const lines = result.errors.map((e, i) => `${i + 1}. ${e}`)
      return {
        success: false,
        output:
          `submit_review schema 校验失败（${result.errors.length} 条）：\n` +
          lines.join('\n') +
          '\n请修正参数后再次调用 submit_review；不要输出自由文本 JSON。',
      }
    }

    ensureBufferDir()
    const path = bufferPath(ctx.taskId)
    const overwriteNote = existsSync(path) ? '（覆盖了本轮之前的提交）' : ''
    try {
      writeFileSync(path, JSON.stringify(result.value), 'utf-8')
    } catch (err) {
      return {
        success: false,
        output: `submit_review 写入 buffer 失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }

    return {
      success: true,
      output:
        `已收到审查结果${overwriteNote}：status=${result.value.status}，findings ${result.value.findings.length} 条。` +
        '无需再次调用 submit_review，不要输出额外文本。',
      data: {
        status: result.value.status,
        findingCount: result.value.findings.length,
      },
    }
  },
}

registerTool(submitReviewTool)
export { submitReviewTool }
