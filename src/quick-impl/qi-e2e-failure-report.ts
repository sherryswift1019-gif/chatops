/**
 * Quick-Impl E2E 失败报告组装
 *
 * 设计：docs/prds/prd-quick-impl-e2e-phase2.md - "失败报告组装"
 *
 * qi_e2e_runner 节点跑完所有 scenario 后调本模块，把 RunScenarioResult[] 过滤 +
 * 抽要害字段，组成 LLM dev-loop 能消化的结构化报告作为下一轮 inputs.failureReport。
 *
 * 关键约束：
 *   - claudeTrace 截断 8KB（钉钉卡片只放摘要，详情走 web UI）
 *   - acceptanceResults 只列 fail/error 的，pass 的不放
 *   - rawOutput 留末尾 4KB 兜底（manifest 缺失时）
 */
import type { RunScenarioResult } from '../agent/e2e-scenario/runner.js'
import type { Playbook } from '../e2e/pipeline-b/playbook/types.js'

const CLAUDE_TRACE_TAIL_BYTES = 8 * 1024
const RAW_OUTPUT_TAIL_BYTES = 4 * 1024

/** 单个失败 scenario 的摘要（dev-loop 看这个修代码） */
export interface FailedScenarioSummary {
  /** scenario.id（来自 playbook） */
  id: string
  /** scenario.name（人类可读） */
  name: string
  /** 高 level 失败结果 */
  result: 'fail' | 'error' | 'timeout' | 'no-manifest'
  /** 一句话失败原因（manifest.errorMessage / acceptance reason / 自动推断） */
  failureReason: string
  /** 哪些 acceptance 挂了（kind/index/expected/actual/reason） */
  failedAcceptances: Array<{
    kind: string
    index: number
    result: 'fail' | 'error'
    expected: unknown
    actual: unknown
    reason: string
  }>
  /** Claude trace 末尾 N 字节（含工具调用 / 观察） */
  claudeTraceTail: string
  /** 产物目录（host 路径，web UI 详情页可链接） */
  artifactsDir: string | null
}

export interface QiFailureReport {
  /** 总 scenario 数 */
  total: number
  /** pass 数 */
  passed: number
  /** failed 数（含 fail/error/timeout/no-manifest） */
  failed: number
  /** 失败 scenario 详情列表 */
  scenarios: FailedScenarioSummary[]
}

/** RunScenarioResult 实际是 runE2eScenario 返回，再扩 scenarioId/evidenceDir 给上下文 */
export interface ScenarioRunRecord extends RunScenarioResult {
  scenarioId: string
  scenarioName?: string
  evidenceDir: string
}

function truncateTail(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.byteLength <= maxBytes) return s
  // utf8 边界安全截断：保留末 maxBytes，从最近的 newline 切开避免破字符
  const tail = buf.subarray(buf.byteLength - maxBytes).toString('utf8')
  const firstNewline = tail.indexOf('\n')
  return firstNewline > 0 ? tail.slice(firstNewline + 1) : tail
}

function formatTraceStep(step: {
  step: number
  intent: string
  tool?: string | null
  verdict: 'ok' | 'warn' | 'error'
  note?: string | null
}): string {
  const tool = step.tool ? ` [${step.tool}]` : ''
  const note = step.note ? ` — ${step.note}` : ''
  return `  ${step.step}.${tool} ${step.verdict.toUpperCase()}: ${step.intent}${note}`
}

/**
 * 把 manifest.claudeTrace 转成可读多行文本，再截 tail。
 */
function buildTraceTail(record: ScenarioRunRecord): string {
  if (record.manifest?.claudeTrace?.length) {
    const formatted = record.manifest.claudeTrace.map(formatTraceStep).join('\n')
    return truncateTail(formatted, CLAUDE_TRACE_TAIL_BYTES)
  }
  // 没 manifest（runner 中途崩了）→ 用 rawOutput 兜底
  if (record.rawOutput) {
    return truncateTail(record.rawOutput, RAW_OUTPUT_TAIL_BYTES)
  }
  return ''
}

/**
 * 推断单一 failureReason（≤200 字一句话），优先级：
 *   1. errorMessage（runner 层错误）
 *   2. manifest.errorMessage
 *   3. 第一条 fail/error acceptance.reason
 *   4. 最后一个 verdict=error 的 trace step.note
 *   5. fallback "scenario {result} (no detail)"
 */
function deriveFailureReason(record: ScenarioRunRecord): string {
  if (record.errorMessage) return record.errorMessage.slice(0, 300)

  const m = record.manifest
  if (m?.errorMessage) return m.errorMessage.slice(0, 300)

  const failed = m?.acceptanceResults?.find((a) => a.result === 'fail' || a.result === 'error')
  if (failed?.reason) return `acceptance ${failed.kind}#${failed.index}: ${failed.reason.slice(0, 250)}`
  if (failed) return `acceptance ${failed.kind}#${failed.index} ${failed.result}`

  const errStep = m?.claudeTrace?.slice().reverse().find((s) => s.verdict === 'error')
  if (errStep?.note) return `trace step ${errStep.step} error: ${errStep.note.slice(0, 250)}`

  return `scenario ${m?.result ?? 'failed'} (no detail)`
}

function deriveResult(
  record: ScenarioRunRecord,
): FailedScenarioSummary['result'] {
  if (!record.manifest) return 'no-manifest'
  if (record.manifest.result === 'pass') {
    // 上层应该已 filter，但兜底
    return 'no-manifest'
  }
  return record.manifest.result
}

function findScenarioName(playbook: Playbook | null, scenarioId: string): string {
  const s = playbook?.scenarios?.find((x) => x.id === scenarioId)
  return s?.name ?? scenarioId
}

function isFailed(record: ScenarioRunRecord): boolean {
  if (record.errorMessage) return true
  if (!record.manifest) return true
  return record.manifest.result !== 'pass'
}

/**
 * 主入口：把跑完的 scenario 结果列表组装成 dev-loop 能用的 failureReport。
 *
 * 第二参数 playbook 用于查 scenario.name；可选（缺失时用 scenarioId 当 name）。
 */
export function buildQiFailureReport(
  records: ScenarioRunRecord[],
  playbook: Playbook | null = null,
): QiFailureReport {
  const failed: FailedScenarioSummary[] = []
  let passed = 0

  for (const r of records) {
    if (!isFailed(r)) {
      passed += 1
      continue
    }
    const failedAccs =
      r.manifest?.acceptanceResults
        ?.filter((a) => a.result === 'fail' || a.result === 'error')
        .map((a) => ({
          kind: a.kind,
          index: a.index,
          result: a.result as 'fail' | 'error',
          expected: a.expected ?? null,
          actual: a.actual ?? null,
          reason: a.reason ?? '',
        })) ?? []

    failed.push({
      id: r.scenarioId,
      name: r.scenarioName ?? findScenarioName(playbook, r.scenarioId),
      result: deriveResult(r),
      failureReason: deriveFailureReason(r),
      failedAcceptances: failedAccs,
      claudeTraceTail: buildTraceTail(r),
      artifactsDir: r.evidenceDir || null,
    })
  }

  return {
    total: records.length,
    passed,
    failed: failed.length,
    scenarios: failed,
  }
}

/**
 * 给钉钉卡片 / web UI 列表用的极简摘要（≤500 字）。
 *
 * 例：
 *   "3/5 失败 — login-with-valid-credentials: page 未跳转 /dashboard;
 *    create-user-bad-input: API 返回 500 而非 422; ..."
 */
export function summarizeFailureReportForCard(report: QiFailureReport): string {
  if (report.failed === 0) return `${report.total} 个 scenario 全部通过`
  const head = `${report.failed}/${report.total} 失败`
  const lines = report.scenarios.slice(0, 3).map((s) => `${s.id}: ${s.failureReason.slice(0, 120)}`)
  const more = report.scenarios.length > 3 ? `; …还有 ${report.scenarios.length - 3} 个` : ''
  return `${head} — ${lines.join('; ')}${more}`.slice(0, 500)
}
