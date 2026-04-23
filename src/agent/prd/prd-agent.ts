import { getPool } from '../../db/client.js'
import { config } from '../../config.js'
import {
  getPrdDocumentById,
  updatePrdContent,
  updatePrdStatus,
  updatePrdReviewResult,
  appendReviewHistory,
  mergePrdMetrics,
  type PrdDocument,
  type PrdReviewFinding,
  type PrdReviewResult,
} from '../../db/repositories/prd-documents.js'
import { REVIEW_PRD_SYSTEM_PROMPT, REPAIR_PRD_SYSTEM_PROMPT } from './prompts.js'
import {
  submitReviewTool,
  takeSubmittedReview,
  clearSubmittedReview,
  type SubmitReviewPayload,
} from '../tools/submit-review.js'
import { RULES_VERSION } from './rules.js'
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
 * V2.0 submit_review 工具调用 → PrdReviewResult 映射。
 *
 * V1 兼容：DB 字段 `dimension` 原本存数字或维度名，V2.0 改存 ruleId 字符串
 * （PRD 审批列表页直接显示 ruleId，等列表页同步切换 V2 字段时可完全脱钩）。
 */
function mapSubmittedToResult(
  payload: SubmitReviewPayload,
  round: number
): PrdReviewResult {
  const severityMap: Record<string, 'blocker' | 'major' | 'minor'> = {
    blocker: 'blocker',
    warning: 'major',
    info: 'minor',
  }
  const findings: PrdReviewFinding[] = payload.findings.map((f, i) => ({
    id: `f-${round}-${i + 1}`,
    dimension: f.ruleId, // V2: dimension 字段承接 ruleId 字符串
    severity: severityMap[f.severity] ?? 'minor',
    location: f.location,
    description: f.issue,
    suggestion: f.suggestion,
    canAutoFix: f.canAutoFix ?? false,
    autoFixBlockedReason: f.autoFixBlockedReason ?? undefined,
    ownership: f.ownership,
    recommendation: payload.recommendation
      ? {
          action: payload.recommendation.action,
          reason: payload.recommendation.reason,
        }
      : undefined,
  }))

  return {
    status: payload.status === 'blocked' ? 'blocked' : 'passed',
    round,
    findings,
    recommendation: payload.recommendation
      ? {
          action: payload.recommendation.action,
          reason: payload.recommendation.reason,
        }
      : undefined,
    reviewedAt: new Date().toISOString(),
  }
}

function buildReviewPrompt(prd: PrdDocument): string {
  return `请审查以下 PRD 文档。审查完成后**必须调用 submit_review 工具**提交结构化结果（这是唯一合法出口；不要输出 JSON 代码块或自由文本）。

PRD ID: ${prd.id}
标题: ${prd.title}
版本: v${prd.version}

---

${prd.contentMarkdown}
`
}

function buildReviewReminderPrompt(prd: PrdDocument): string {
  return `你上一轮没有调用 submit_review 工具（或调用被 schema 拒绝）。这是审查的唯一合法出口，请立刻调用 submit_review({ status, findings, recommendation })。

禁止输出任何 JSON 代码块或自由文本；直接进行 tool-call。

PRD ID: ${prd.id}
标题: ${prd.title}
版本: v${prd.version}

---

${prd.contentMarkdown}
`
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
 *
 * V2.0 自审主路径已改为 submit_review 工具调用，不再用此函数；保留导出给测试/
 * 诊断/V1 外部消费方使用（例如管理员在 Web 上手动粘 JSON 的旧诊断流）。
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

  const v2Mode = config.PRD_AGENT_V2_MODE

  // Feature flag: off → 紧急 kill-switch，PRD 直接 draft，不跑 AI 自审
  if (v2Mode === 'off') {
    const skipResult: PrdReviewResult = {
      status: 'passed',
      round: 0,
      findings: [],
      reviewedAt: new Date().toISOString(),
    }
    await updatePrdReviewResult(prdId, skipResult, 'draft')
    console.log(`[PrdAgent] PRD #${prdId} PRD_AGENT_V2_MODE=off，跳过 AI 自审`)
    emit({ stage: 'review_started', prdId })
    emit({
      stage: 'review_finalized',
      prdId,
      finalStatus: 'draft',
      round: 0,
    })
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

  // V2.0 baseline 埋点：review / repair 调用次数 + 自审总耗时。
  // 在下方 try 的 finally 中写回 prd_documents.metrics，失败只打 log 不阻塞主流程。
  let reviewCalls = 0
  let repairCalls = 0
  const reviewStartedAt = Date.now()

  try {
  for (let round = 1; round <= MAX_REPAIR_ROUNDS + 1; round++) {
    const reviewCtx = buildBackgroundContext(currentPrd)

    // V2.0：submit_review 工具调用契约。先清 buffer，跑 review，
    // 未收到 submit_review → 一次重试（reminder prompt），仍无 → 升级人工。
    clearSubmittedReview(reviewCtx.taskId)
    reviewCalls++
    await runClaudeOnce({
      prompt: buildReviewPrompt(currentPrd),
      systemPrompt: REVIEW_PRD_SYSTEM_PROMPT,
      context: reviewCtx,
      tools: [submitReviewTool],
      sessionKey: `prd-review-${prdId}-r${round}-a1`,
    })
    let submitted = takeSubmittedReview(reviewCtx.taskId)
    if (!submitted) {
      // Attempt 2: 以 reminder prompt 重试一次
      clearSubmittedReview(reviewCtx.taskId)
      reviewCalls++
      await runClaudeOnce({
        prompt: buildReviewReminderPrompt(currentPrd),
        systemPrompt: REVIEW_PRD_SYSTEM_PROMPT,
        context: reviewCtx,
        tools: [submitReviewTool],
        sessionKey: `prd-review-${prdId}-r${round}-a2`,
      })
      submitted = takeSubmittedReview(reviewCtx.taskId)
    }

    if (!submitted) {
      const synthResult: PrdReviewResult = {
        status: 'blocked',
        round,
        findings: [
          {
            id: `contract-err-${round}`,
            dimension: 'submit_review_missing',
            severity: 'blocker',
            location: '全文',
            description:
              '自审契约失败：2 次尝试后 Agent 仍未调用合法的 submit_review 工具',
            canAutoFix: false,
            autoFixBlockedReason: '契约失败，需要人工检查审查结果',
            ownership: 'admin',
            recommendation: {
              action: 'reject',
              reason: '自审契约失败，需要人工检查',
            },
          },
        ],
        recommendation: { action: 'reject', reason: '自审契约失败' },
        reviewedAt: new Date().toISOString(),
      }
      await updatePrdReviewResult(prdId, synthResult, 'review_blocked')
      await appendReviewHistory(prdId, { round, result: synthResult })
      console.error(
        `[PrdAgent] PRD #${prdId} round ${round} submit_review 契约失败（2 次重试后仍未调用）`
      )
      emit({
        stage: 'review_error',
        prdId,
        error: `Round ${round} 自审契约失败（未调用 submit_review）`,
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

    const result = mapSubmittedToResult(submitted, round)
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

    // Feature flag: shadow → 只做一轮观测，blocker 不触发自修复也不阻塞
    if (v2Mode === 'shadow') {
      await updatePrdReviewResult(prdId, result, 'draft')
      console.log(
        `[PrdAgent] PRD #${prdId} shadow 模式：round ${round} findings=${result.findings.length} blocker=${blockers.length}（不阻塞，强制 draft）`
      )
      emit({
        stage: 'review_finalized',
        prdId,
        finalStatus: 'draft',
        round,
        recommendation: result.recommendation,
      })
      return
    }

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

    // 存在非 canAutoFix 的 blocker → 无法自修复，直接升级人工
    // （canAutoFix 由 REVIEW agent 自评，true 表示不依赖新对话事实即可改文本）
    const fixableBlockers = blockers.filter((f) => f.canAutoFix)
    const unfixable = blockers.filter((f) => !f.canAutoFix)
    if (fixableBlockers.length === 0 || unfixable.length > 0) {
      await updatePrdReviewResult(prdId, result, 'review_blocked')
      console.log(
        `[PrdAgent] PRD #${prdId} round ${round} 存在非 canAutoFix 的 blocker，升级人工`
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
    repairCalls++
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
      contentJson: stripStructuredOnRepair(currentPrd.contentJson),
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
  } catch (err) {
    // Porygon/Claude 超时或其他运行时异常 → 不能让 PRD 永远挂在 reviewing
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[PrdAgent] PRD #${prdId} 自审异常，升级人工:`, errMsg)
    const fallbackRound = lastResult?.round ?? 0
    const synthResult: PrdReviewResult = {
      status: 'blocked',
      round: fallbackRound,
      findings: [],
      recommendation: {
        action: 'reject',
        reason: `自审异常: ${errMsg}`,
      },
      reviewedAt: new Date().toISOString(),
    }
    await updatePrdReviewResult(prdId, synthResult, 'review_blocked')
    await appendReviewHistory(prdId, { round: fallbackRound, result: synthResult })
    emit({ stage: 'review_error', prdId, error: errMsg })
    emit({
      stage: 'review_finalized',
      prdId,
      finalStatus: 'review_blocked',
      round: fallbackRound,
      recommendation: synthResult.recommendation,
    })
    return
  } finally {
    // 无论走哪条 terminal 路径，都把本次自审的埋点增量写回。
    // 失败只打 log：埋点不是核心流程，不能阻塞 PRD 审查结果的落地。
    await mergePrdMetrics(prdId, {
      llmCallsDelta: { review: reviewCalls, repair: repairCalls },
      reviewDurationMs: Date.now() - reviewStartedAt,
      rulesVersion: RULES_VERSION,
    })
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
  tools?: Array<import('../tools/types.js').AgentTool>
}): Promise<string> {
  if (!runner) throw new Error('ClaudeRunner 未初始化')
  // review/repair 流程：prompt 已内联完整 PRD 全文，不需要 read_prd 工具；
  // 每次都是一次性评审，走冷启动 + 3 turn 硬上限。不设超时——AI 审查耗时不稳定，
  // 180s 也可能不够，硬截断会把合法慢调用判死。maxTurns=3 是最终兜底。
  return runner.executeCapabilityDirect({
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    context: opts.context,
    tools: opts.tools ?? [],
    sessionKey: opts.sessionKey,
    freshSession: true,
    maxTurns: 3,
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
 * V2 PRD 自修复后 Markdown 与入库的 `structuredPrd` 语义漂移：
 * repair Agent 只输出 markdown，不重跑 save_prd 的机械校验 / 模板渲染，所以
 * `contentJson.structuredPrd` 对应的已是旧版本，留着会误导 read-prd 的 V1/V2 路由。
 *
 * 策略：剥离 `structuredPrd` + `rulesVersion`；其余键（phase/dialogueRounds/...）保留。
 * 剥离后 read-prd 会把它判定为 V1 PRD，与实际 markdown-only 存储一致。
 * V1 PRD（原本就没 structuredPrd）返回 undefined，让 updatePrdContent 不改 content_json 字段。
 */
export function stripStructuredOnRepair(
  existing: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!existing || typeof existing !== 'object') return undefined
  if (!('structuredPrd' in existing) && !('rulesVersion' in existing)) {
    return undefined
  }
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(existing)) {
    if (k === 'structuredPrd' || k === 'rulesVersion') continue
    next[k] = v
  }
  return next
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
