/**
 * final 节点的审批摘要拼装。
 *
 * 从 [graph-builder.ts:1354-1418] 抽出（保留原有 5 段结构 + git log fallback）：
 *   1. 代码审查结论（review.decision / fixRounds）
 *   2. 注意事项（review.notes）
 *   3. 实现内容（tasksDone）
 *   4. 测试状态（e2eOutput.result / skipped / scenariosRun）
 *   5. 变更影响分析（review.fileRisks，缺失则 fallback 到 git log）
 *
 * IM 摘要：精简版（一句话结论 + fileRisks 高风险 / e2e 状态）。
 */
import { execSync } from 'child_process'
import { riskIcon, truncateImSummary } from './shared.js'

interface ReviewOutput {
  summary?: string
  decision?: string
  notes?: Array<{ msg: string }>
  fileRisks?: Array<{ file: string; role: string; impact: string; risk: 'high' | 'medium' | 'low'; focusOn: string }>
}

/**
 * qi_e2e_runner 节点输出的字段子集（详见 src/pipeline/node-types/qi-e2e-runner.ts）。
 * result 取值：'pass' | 'skipped' | 'fail' | 'sandbox_failed' | 'no-manifest' | 'stub'
 * skipped=true：dev-loop 没生成 scenarios（非功能性变更），result 标 'skipped'
 */
export interface E2eOutput {
  result?: string
  scenariosRun?: number
  passed?: number
  failed?: number
  skipped?: boolean
  skipReason?: string
}

export interface BuildFinalApprovalSummaryArgs {
  devOutput: {
    review?: ReviewOutput
    tasksDone?: string[]
    fixRounds?: number
  } | null
  e2eOutput: E2eOutput | null
  worktreePath: string
}

/**
 * 把 e2eOutput 转成展示标签（web 长版 / im 简版同源）。
 * unknown 仅当 e2eOutput 完全为 null 时出现。
 */
function formatE2eLabel(e2e: E2eOutput | null): string {
  if (!e2e) return '⚪ E2E 未执行'
  const { result, scenariosRun = 0, passed = 0, failed = 0, skipped, skipReason } = e2e
  if (skipped) {
    return `⚪ E2E 跳过${skipReason ? `：${skipReason}` : ''}（需人工验证功能正确性）`
  }
  if (result === 'pass') return `✅ E2E 通过（${passed}/${scenariosRun}）`
  if (result === 'fail') return `❌ E2E 失败（${failed} 失败 / ${scenariosRun}）`
  if (result === 'sandbox_failed') return '⚠️ E2E sandbox 启动失败'
  if (result === 'no-manifest') return '⚠️ E2E manifest 缺失（dev-loop 未产生 playbook）'
  if (result === 'stub') return '⚪ 自动化 E2E 未覆盖（Phase 1 占位），需人工验证'
  return `⚪ E2E 状态未知：${result ?? '(unset)'}`
}

export function buildFinalApprovalSummary(args: BuildFinalApprovalSummaryArgs): {
  web: string
  im: string
} {
  const { devOutput, e2eOutput, worktreePath } = args
  const review = devOutput?.review
  const tasksDone = devOutput?.tasksDone
  const fixRounds = typeof devOutput?.fixRounds === 'number' ? devOutput.fixRounds : 0

  const lines: string[] = []

  // 1. 审查结论（最重要，放第一）
  const reviewPassed = review?.decision !== 'fail'
  const qualityLabel = reviewPassed
    ? fixRounds === 0
      ? '✅ 通过（一次通过）'
      : `✅ 通过（经 ${fixRounds} 轮修复）`
    : '❌ 未通过'
  lines.push(`## 代码审查：${qualityLabel}`)
  if (review?.summary) lines.push(`\n${review.summary}`)

  // 2. 注意事项（有问题才显示）
  const notes = review?.notes?.filter((n) => n.msg?.trim())
  if (notes && notes.length > 0) {
    lines.push(`\n## ⚠️ 需关注\n${notes.map((n) => `- ${n.msg}`).join('\n')}`)
  }

  // 3. 实现内容
  if (Array.isArray(tasksDone) && tasksDone.length > 0) {
    lines.push(`\n## 实现内容\n${tasksDone.map((t) => `- ${t}`).join('\n')}`)
  }

  // 4. 测试状态
  const e2eLabel = formatE2eLabel(e2eOutput)
  lines.push(`\n## 测试状态\n- ${e2eLabel}`)

  // 5. 变更影响分析（来自 reviewer 的 fileRisks）
  const fileRisks = review?.fileRisks
  if (Array.isArray(fileRisks) && fileRisks.length > 0) {
    const riskLines = fileRisks
      .map(
        (f) =>
          `**${f.file}** ${riskIcon(f.risk)} ${f.risk}\n` +
          `　职责：${f.role}\n` +
          `　改动影响：${f.impact}\n` +
          `　重点 Review：${f.focusOn}`,
      )
      .join('\n\n')
    lines.push(`\n## 变更影响分析\n${riskLines}`)
  } else {
    // fallback: 至少给出 commit log
    try {
      const commitLog = execSync(`git log origin/main..HEAD --oneline`, {
        cwd: worktreePath,
        timeout: 5000,
        encoding: 'utf8',
      }).trim()
      if (commitLog) lines.push(`\n## 提交记录\n\`\`\`\n${commitLog}\n\`\`\``)
    } catch {
      /* non-fatal */
    }
  }

  const web = lines.join('\n')

  // IM 摘要（精简版）
  const imLines: string[] = []
  imLines.push(`🤖 最终审批：${qualityLabel}`)
  const highRiskFiles = fileRisks?.filter((f) => f.risk === 'high') ?? []
  if (highRiskFiles.length > 0) imLines.push(`🔴 ${highRiskFiles.length} 个文件 high risk`)
  // E2E 简化：通过 / 跳过 / 失败 三态分流（复用同一 label）；通过且不 skipped 不重复显示
  const isPlainPass = e2eOutput?.result === 'pass' && !e2eOutput?.skipped
  if (!isPlainPass) imLines.push(formatE2eLabel(e2eOutput))
  if (tasksDone && tasksDone.length > 0) imLines.push(`📦 ${tasksDone.length} 个任务完成`)
  const im = truncateImSummary(imLines.join('\n'))

  return { web, im }
}
