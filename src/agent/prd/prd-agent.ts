import { getTool } from '../tools/index.js'
import { getPool } from '../../db/client.js'
import {
  getPrdDocumentById,
  updatePrdContent,
  updatePrdStatus,
  updatePrdReviewResult,
  appendReviewHistory,
  type PrdDocument,
  type PrdReviewFinding,
  type PrdReviewResult,
} from '../../db/repositories/prd-documents.js'
import { REVIEW_PRD_SYSTEM_PROMPT, REPAIR_PRD_SYSTEM_PROMPT } from './prompts.js'
import type { ClaudeRunner } from '../claude-runner.js'
import type { TaskContext } from '../tools/types.js'

let runner: ClaudeRunner | null = null
export function setPrdClaudeRunner(r: ClaudeRunner): void {
  runner = r
}

const MAX_REPAIR_ROUNDS = 2
const REQUIRED_CHAPTERS: Array<{ num: number; title: string }> = [
  { num: 1, title: '愿景与目标' },
  { num: 2, title: '用户与场景' },
  { num: 3, title: '功能需求' },
  { num: 4, title: '非功能需求' },
  { num: 5, title: '与现有系统集成' },
  { num: 6, title: '对现有功能的影响' },
  { num: 7, title: '范围边界' },
  { num: 8, title: '待定事项' },
  { num: 9, title: '决策日志' },
]

export interface PrdReviewRawOutput {
  status: 'pass' | 'blocked' | 'warnings_only'
  summary?: string
  findings: Array<{
    dimension: number
    dimension_name?: string
    severity: 'blocker' | 'warning' | 'info'
    location: string
    issue: string
    suggestion?: string
    canAutoFix?: boolean
    autoFixBlockedReason?: string | null
    ownership?: 'pm' | 'admin' | 'business'
  }>
  recommendation?: {
    action: 'approve' | 'approve_with_edits' | 'reject'
    reason: string
    confidence?: 'high' | 'medium' | 'low'
  }
}

/**
 * 自审/自修复生命周期中的关键节点事件。
 * 由 runPrdReview 在 6 个关键位置通过 opts.onProgress 派发，
 * 供 Web chat SSE 把进度推送到前端（IM 路径不使用）。
 */
export type ReviewProgressEvent =
  | { stage: 'review_started'; prdId: number }
  | { stage: 'structure_failed'; prdId: number; errors: string[] }
  | {
      stage: 'round_done'
      prdId: number
      round: number
      blockerCount: number
      warningCount: number
      infoCount: number
      recommendation?: { action: string; reason: string }
    }
  | { stage: 'repair_started'; prdId: number; round: number; fixableCount: number }
  | { stage: 'repair_done'; prdId: number; round: number; ok: boolean; reason?: string }
  | {
      stage: 'review_finalized'
      prdId: number
      finalStatus: 'draft' | 'review_blocked'
      round: number
      recommendation?: { action: string; reason: string }
    }
  | { stage: 'review_error'; prdId: number; error: string }

export interface RunPrdReviewOptions {
  onProgress?: (ev: ReviewProgressEvent) => void
  /**
   * V1.2+ 扩展点：指定评审使用的 porygon backend（'claude' / 'gemini' / ...）。
   * V1.1 未启用，当前总是走默认 'claude'。保留参数以便未来多模型交叉审查。
   */
  backend?: string
}

/**
 * 程序级结构校验：快速发现明显缺失，不依赖 LLM。
 * 返回空数组即通过；有任何条目返回即视为结构不合格，直接跳过 AI 自审。
 */
export function validatePrdStructure(markdown: string): string[] {
  const errors: string[] = []
  if (!markdown || markdown.trim().length < 200) {
    errors.push('PRD 内容过短（<200 字符），疑似未生成完整文档')
    return errors
  }
  for (const { num, title } of REQUIRED_CHAPTERS) {
    const pattern = new RegExp(`^##\\s+${num}\\.`, 'm')
    if (!pattern.test(markdown)) {
      errors.push(`缺少第 ${num} 章「${title}」`)
    }
  }
  return errors
}

/**
 * 从 Claude 的回复中提取 JSON。
 * 支持：
 * - 纯 JSON
 * - ```json ... ``` 包裹
 * - 前后夹杂自然语言（定位第一个 { 到最后一个 }）
 */
export function parsePrdReviewOutput(text: string): PrdReviewRawOutput | null {
  if (!text) return null

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenceMatch ? fenceMatch[1] : text

  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) return null

  const jsonStr = candidate.slice(firstBrace, lastBrace + 1)
  try {
    const parsed = JSON.parse(jsonStr) as PrdReviewRawOutput
    if (!Array.isArray(parsed.findings)) return null
    if (!['pass', 'blocked', 'warnings_only'].includes(parsed.status)) return null
    return parsed
  } catch {
    return null
  }
}

function mapRawToResult(
  raw: PrdReviewRawOutput,
  round: number
): PrdReviewResult {
  const severityMap: Record<string, 'blocker' | 'major' | 'minor'> = {
    blocker: 'blocker',
    warning: 'major',
    info: 'minor',
  }
  const findings: PrdReviewFinding[] = raw.findings.map((f, i) => ({
    id: `f-${round}-${i + 1}`,
    dimension: f.dimension_name ?? String(f.dimension),
    severity: severityMap[f.severity] ?? 'minor',
    location: f.location,
    description: f.issue,
    suggestion: f.suggestion,
    canAutoFix: f.canAutoFix ?? false,
    autoFixBlockedReason: f.autoFixBlockedReason ?? undefined,
    ownership: f.ownership,
    recommendation: raw.recommendation
      ? {
          action: raw.recommendation.action,
          reason: raw.recommendation.reason,
        }
      : undefined,
  }))

  return {
    status: raw.status === 'blocked' ? 'blocked' : 'passed',
    round,
    findings,
    recommendation: raw.recommendation
      ? {
          action: raw.recommendation.action,
          reason: raw.recommendation.reason,
        }
      : undefined,
    reviewedAt: new Date().toISOString(),
  }
}

function buildReviewPrompt(prd: PrdDocument): string {
  return `请审查以下 PRD 文档。按 9 个维度给出 JSON 格式的 findings。

PRD ID: ${prd.id}
标题: ${prd.title}
版本: v${prd.version}

---

${prd.contentMarkdown}
`
}

function buildRepairPrompt(prd: PrdDocument, findings: PrdReviewFinding[]): string {
  const blockers = findings.filter((f) => f.severity === 'blocker' && f.canAutoFix)
  const findingsJson = blockers.map((f, i) => ({
    idx: i + 1,
    dimension: f.dimension,
    severity: f.severity,
    location: f.location,
    issue: f.description,
    suggestion: f.suggestion,
  }))

  return `请修复 PRD 中被自审标记的问题。只改 findings 指出的地方，其他部分保持原样。

**原始 PRD**:
\`\`\`markdown
${prd.contentMarkdown}
\`\`\`

**审查报告（findings 列表）**:
\`\`\`json
${JSON.stringify(findingsJson, null, 2)}
\`\`\`

请直接输出修复后的完整 Markdown PRD（不要 diff、不要说明、不要 JSON 包装）。
`
}

/**
 * 入口：为指定 PRD 运行自审 + 自修复循环。
 *
 * 流程:
 *   1. 程序级结构校验 → 不通过 → 标 review_blocked 并返回（由 PM 端重新生成）
 *   2. 调用 Claude (REVIEW_PRD_SYSTEM_PROMPT) 做 AI 自审
 *   3. 无 blocker → 标 draft（或 approved 取决于 recommendation）
 *   4. 有 blocker 且全部 canAutoFix → 调用 Claude (REPAIR_PRD_SYSTEM_PROMPT) 修复 → 再自审（最多 2 轮）
 *   5. 仍有 blocker → 标 review_blocked，升级人工
 *
 * opts.onProgress（可选）在 6 个关键节点派发进度事件，供 Web chat SSE 展示。
 * IM 路径不传 onProgress，保持安静运行。
 */
export async function runPrdReview(
  prdId: number,
  opts: RunPrdReviewOptions = {}
): Promise<void> {
  const emit = (ev: ReviewProgressEvent): void => {
    try {
      opts.onProgress?.(ev)
    } catch (err) {
      console.error('[PrdAgent] onProgress callback threw:', err)
    }
  }

  if (!runner) {
    console.error('[PrdAgent] ClaudeRunner 未初始化，跳过自审')
    emit({ stage: 'review_error', prdId, error: 'ClaudeRunner 未初始化' })
    return
  }

  const prd = await getPrdDocumentById(prdId)
  if (!prd) {
    console.error(`[PrdAgent] PRD #${prdId} 不存在，跳过自审`)
    emit({ stage: 'review_error', prdId, error: `PRD #${prdId} 不存在` })
    return
  }

  await updatePrdStatus(prdId, 'reviewing')
  emit({ stage: 'review_started', prdId })

  // Step 1: 程序级结构校验
  const structureErrors = validatePrdStructure(prd.contentMarkdown)
  if (structureErrors.length > 0) {
    const synthResult: PrdReviewResult = {
      status: 'blocked',
      round: 0,
      findings: structureErrors.map((desc, i) => ({
        id: `struct-${i + 1}`,
        dimension: '格式完整性',
        severity: 'blocker',
        location: '全文',
        description: desc,
        canAutoFix: false,
        autoFixBlockedReason: '结构缺失需 PM 重新生成',
        ownership: 'pm',
        recommendation: {
          action: 'reject',
          reason: '程序级结构校验失败，需 PM 重新生成完整 PRD',
        },
      })),
      recommendation: {
        action: 'reject',
        reason: '程序级结构校验失败，需 PM 重新生成完整 PRD',
      },
      reviewedAt: new Date().toISOString(),
    }
    await updatePrdReviewResult(prdId, synthResult, 'review_blocked')
    await appendReviewHistory(prdId, { round: 0, result: synthResult })
    console.log(`[PrdAgent] PRD #${prdId} 结构校验失败: ${structureErrors.join('; ')}`)
    emit({ stage: 'structure_failed', prdId, errors: structureErrors })
    emit({
      stage: 'review_finalized',
      prdId,
      finalStatus: 'review_blocked',
      round: 0,
      recommendation: synthResult.recommendation,
    })
    return
  }

  // Step 2-4: AI 自审 + 自修复循环
  let currentPrd = prd
  let lastResult: PrdReviewResult | null = null

  for (let round = 1; round <= MAX_REPAIR_ROUNDS + 1; round++) {
    const reviewCtx = buildBackgroundContext(currentPrd)
    const reviewText = await runClaudeOnce({
      prompt: buildReviewPrompt(currentPrd),
      systemPrompt: REVIEW_PRD_SYSTEM_PROMPT,
      context: reviewCtx,
      sessionKey: `prd-review-${prdId}-r${round}`,
    })

    const raw = parsePrdReviewOutput(reviewText)
    if (!raw) {
      const synthResult: PrdReviewResult = {
        status: 'blocked',
        round,
        findings: [
          {
            id: `parse-err-${round}`,
            dimension: '自审输出解析',
            severity: 'blocker',
            location: '全文',
            description: '自审返回的内容不是合法 JSON，无法解析 findings',
            canAutoFix: false,
            ownership: 'admin',
            recommendation: {
              action: 'reject',
              reason: '自审输出异常，需要人工检查',
            },
          },
        ],
        recommendation: { action: 'reject', reason: '自审输出异常' },
        reviewedAt: new Date().toISOString(),
      }
      await updatePrdReviewResult(prdId, synthResult, 'review_blocked')
      await appendReviewHistory(prdId, { round, result: synthResult })
      console.error(`[PrdAgent] PRD #${prdId} round ${round} 自审输出解析失败`)
      emit({
        stage: 'review_error',
        prdId,
        error: `Round ${round} 自审输出不是合法 JSON`,
      })
      emit({
        stage: 'review_finalized',
        prdId,
        finalStatus: 'review_blocked',
        round,
        recommendation: synthResult.recommendation,
      })
      return
    }

    const result = mapRawToResult(raw, round)
    lastResult = result
    await appendReviewHistory(prdId, { round, result })

    const blockers = result.findings.filter((f) => f.severity === 'blocker')
    const warnings = result.findings.filter((f) => f.severity === 'major')
    const infos = result.findings.filter((f) => f.severity === 'minor')
    emit({
      stage: 'round_done',
      prdId,
      round,
      blockerCount: blockers.length,
      warningCount: warnings.length,
      infoCount: infos.length,
      recommendation: result.recommendation,
    })

    if (blockers.length === 0) {
      await updatePrdReviewResult(prdId, result, 'draft')
      console.log(`[PrdAgent] PRD #${prdId} round ${round} 通过自审（无 blocker）`)
      emit({
        stage: 'review_finalized',
        prdId,
        finalStatus: 'draft',
        round,
        recommendation: result.recommendation,
      })
      return
    }

    // 最后一轮仍有 blocker → 升级人工
    if (round > MAX_REPAIR_ROUNDS) {
      await updatePrdReviewResult(prdId, result, 'review_blocked')
      console.log(`[PrdAgent] PRD #${prdId} ${MAX_REPAIR_ROUNDS} 轮自修复后仍有 blocker，升级人工`)
      emit({
        stage: 'review_finalized',
        prdId,
        finalStatus: 'review_blocked',
        round,
        recommendation: result.recommendation,
      })
      return
    }

    // blocker 中任一 ownership 非 admin → 无法自修复，直接升级人工
    const fixableBlockers = blockers.filter((f) => f.canAutoFix && f.ownership === 'admin')
    const unfixable = blockers.filter((f) => !f.canAutoFix || f.ownership !== 'admin')
    if (fixableBlockers.length === 0 || unfixable.length > 0) {
      await updatePrdReviewResult(prdId, result, 'review_blocked')
      console.log(
        `[PrdAgent] PRD #${prdId} round ${round} 存在非 admin 可修复的 blocker，升级人工`
      )
      emit({
        stage: 'review_finalized',
        prdId,
        finalStatus: 'review_blocked',
        round,
        recommendation: result.recommendation,
      })
      return
    }

    // 自修复
    console.log(`[PrdAgent] PRD #${prdId} round ${round} 开始自修复（${fixableBlockers.length} 条 blocker）`)
    emit({ stage: 'repair_started', prdId, round, fixableCount: fixableBlockers.length })
    const repairText = await runClaudeOnce({
      prompt: buildRepairPrompt(currentPrd, fixableBlockers),
      systemPrompt: REPAIR_PRD_SYSTEM_PROMPT,
      context: reviewCtx,
      sessionKey: `prd-repair-${prdId}-r${round}`,
    })

    const repairedMarkdown = extractMarkdownFromRepairOutput(repairText)
    if (!repairedMarkdown || validatePrdStructure(repairedMarkdown).length > 0) {
      await updatePrdReviewResult(prdId, result, 'review_blocked')
      console.log(`[PrdAgent] PRD #${prdId} round ${round} 修复输出结构不合格，升级人工`)
      emit({
        stage: 'repair_done',
        prdId,
        round,
        ok: false,
        reason: '修复输出结构不合格',
      })
      emit({
        stage: 'review_finalized',
        prdId,
        finalStatus: 'review_blocked',
        round,
        recommendation: result.recommendation,
      })
      return
    }

    const updated = await updatePrdContent(prdId, {
      contentMarkdown: repairedMarkdown,
    })
    if (!updated) {
      await updatePrdReviewResult(prdId, result, 'review_blocked')
      console.error(`[PrdAgent] PRD #${prdId} 修复后更新 DB 失败`)
      emit({ stage: 'repair_done', prdId, round, ok: false, reason: '修复后写回 DB 失败' })
      emit({
        stage: 'review_finalized',
        prdId,
        finalStatus: 'review_blocked',
        round,
        recommendation: result.recommendation,
      })
      return
    }
    currentPrd = updated
    await appendReviewHistory(prdId, {
      round,
      result,
      repairedAt: new Date().toISOString(),
      repairSummary: `自动修复 ${fixableBlockers.length} 条 blocker`,
    })
    emit({ stage: 'repair_done', prdId, round, ok: true })
  }

  // Fallback (should not reach)
  if (lastResult) {
    await updatePrdReviewResult(prdId, lastResult, 'review_blocked')
    emit({
      stage: 'review_finalized',
      prdId,
      finalStatus: 'review_blocked',
      round: lastResult.round,
      recommendation: lastResult.recommendation,
    })
  }
}

function buildBackgroundContext(prd: PrdDocument): TaskContext {
  return {
    taskId: `prd-review-${prd.id}-${Date.now()}`,
    groupId: prd.groupId ?? 'prd-system',
    platform: prd.platform ?? 'system',
    initiatorId: prd.createdBy,
    initiatorRole: 'admin',
    productLineId: prd.productLineId,
  }
}

async function runClaudeOnce(opts: {
  prompt: string
  systemPrompt: string
  context: TaskContext
  sessionKey: string
}): Promise<string> {
  if (!runner) throw new Error('ClaudeRunner 未初始化')
  const readPrd = getTool('read_prd')
  const tools = readPrd ? [readPrd] : []
  return runner.executeCapabilityDirect({
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    context: opts.context,
    tools,
    sessionKey: opts.sessionKey,
  })
}

/**
 * 修复 Agent 应直接输出完整 Markdown。如果误用 ```markdown ... ``` 包裹，剥掉外层。
 */
function extractMarkdownFromRepairOutput(text: string): string {
  if (!text) return ''
  const fenceMatch = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/)
  if (fenceMatch) return fenceMatch[1].trim()
  return text.trim()
}

/**
 * ClaudeRunner 在每次 executeWithPorygon 结束时调用此钩子：
 * 根据 taskId 找出本次运行中被 save_prd 保存（新建或更新）的 PRD，
 * 异步（fire-and-forget）触发自审。不阻塞 IM 回复链路。
 *
 * 判定标准：agent_session_id = taskId 且（status='drafting' 且 review_result IS NULL）。
 * 'drafting' 过滤确保：
 *   - 更新后再次触发（update 会把 status 重置为 drafting？不会，update 不碰 status）
 *     所以更新模式下需要 save_prd 调用者确保更新即 draft 态流转。
 * 为兼容更新场景：判定改为 updated_at 在本次 run 起始后，且（review_result 为空 OR 版本变化）。
 */
export async function scanPendingReviewsByTaskId(
  taskId: string,
  runStartedAt: Date
): Promise<number[]> {
  const pool = getPool()
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM prd_documents
      WHERE agent_session_id = $1
        AND updated_at >= $2
        AND status IN ('drafting','reviewing','draft','review_blocked')
      ORDER BY id ASC`,
    [taskId, runStartedAt]
  )
  return rows.map((r) => r.id)
}

/**
 * 异步触发指定 PRD 的自审。失败仅打 log，不抛。
 * ClaudeRunner 调用此方法后可立即返回，不阻塞 IM。
 */
export function triggerPrdReviewAsync(prdId: number): void {
  runPrdReview(prdId).catch((err) => {
    console.error(`[PrdAgent] runPrdReview(${prdId}) 失败:`, err)
  })
}
