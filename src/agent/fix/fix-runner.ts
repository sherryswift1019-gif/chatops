import { registerCapabilityHandler } from '../coordinator.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import {
  createEvent,
  findByReportCode,
} from '../../db/repositories/bug-fix-events.js'
import { runFixForProject, isFixSuccessful } from './fix-logic.js'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import type { BugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'

/** 从 git URL 提取 GitLab 项目路径（保留导出以兼容旧集成测试） */
export function extractProjectPath(codeRepoUrl: string): string {
  const url = codeRepoUrl.replace(/\.git$/, '')
  const httpMatch = url.match(/https?:\/\/[^/]+\/(.+)/)
  if (httpMatch) return httpMatch[1]
  const sshMatch = url.match(/[^:]+:(.+)/)
  if (sshMatch) return sshMatch[1]
  return url
}

// 兼容旧测试：重新导出 isFixSuccessful
export { isFixSuccessful }

/**
 * fix_bug_l1/l2/l3 capability handler：按 scope_identified 事件循环多 project 串行修复。
 *
 * 行为要点：
 * - 串行修复各 project（避免 Claude CLI 资源冲突）
 *   C4：fix-runner 有意保持串行（peak concurrency=1），因为 Fix 比 Analyze 更重
 *   （需要改代码 + 跑测试），多 project 同时起 Claude CLI 会爆机器/API；如果将来
 *   需要并发，参考 analyzer.ts 的 p-limit 方案（ANALYSIS_CONCURRENCY=3）。
 * - 幂等：跳过已有 fix_attempt=success 的 project
 * - 每个 project 写一条 bug_fix_events(code='fix_attempt', status=..., data={branch, targetBranch, testResult, attempt, error?})
 * - 不再内嵌 createMr / 通知 / retryWithDowngrade（这些由独立 capability / Pipeline retryCount 负责）
 */
export async function handleFixBug(opts: TriggerOptions, level: string): Promise<TriggerResult> {
  try {
    const reportId = Number(opts.extraParams?.reportId)
    if (!reportId) {
      return { success: false, error: 'missing_reportId', output: '参数错误: 缺少 reportId' }
    }

    const report: BugAnalysisReport | null = await getBugAnalysisReportById(reportId)
    if (!report) {
      return { success: false, error: 'report_not_found', output: `报告 ${reportId} 不存在` }
    }

    const scopes = await findByReportCode(reportId, 'scope_identified')
    if (scopes.length === 0) {
      return { success: false, error: 'no_scope', output: '缺少 scope_identified 事件' }
    }

    const successes: string[] = []
    const failures: string[] = []

    for (const scope of scopes) {
      const projectPath = scope.projectPath
      if (!projectPath) {
        // 理论上不会发生，scope_identified 必须带 project_path
        failures.push('(unknown): scope 缺少 project_path')
        continue
      }

      // 幂等：查该 project 已有的 fix_attempt
      const existingAttempts = await findByReportCode(reportId, 'fix_attempt')
      const projectAttempts = existingAttempts.filter(e => e.projectPath === projectPath)
      const alreadySucceeded = projectAttempts.some(e => e.status === 'success')
      if (alreadySucceeded) {
        console.log(`[FixAgent] report=${reportId} project=${projectPath}: 已存在 success fix_attempt，跳过`)
        successes.push(projectPath)
        continue
      }

      const data = (scope.data ?? {}) as Record<string, unknown>
      const sourceBranch = (data.sourceBranch as string | undefined) ?? 'master'
      const affectedModules = Array.isArray(data.affectedModules)
        ? (data.affectedModules as string[])
        : []

      const attempt = projectAttempts.length + 1
      const startedAt = Date.now()

      try {
        const fixResult = await runFixForProject({
          reportId,
          productLineId: report.productLineId,
          projectPath,
          sourceBranch,
          affectedModules,
          rootCauseSummary: report.rootCauseSummary,
          solutionsJson: report.solutionsJson,
          issueId: report.issueId,
          confidence: report.confidence,
          level,
          attempt,
          signal: opts.signal,
        })

        await createEvent({
          reportId,
          projectPath,
          code: 'fix_attempt',
          status: fixResult.testPassed ? 'success' : 'failed',
          durationMs: Date.now() - startedAt,
          data: {
            branch: fixResult.branch,
            targetBranch: sourceBranch,
            testResult: fixResult.testPassed,
            attempt,
            ...(fixResult.testPassed ? {} : { error: fixResult.error ?? '修复未成功' }),
          },
        })

        if (fixResult.testPassed) {
          successes.push(projectPath)
        } else {
          failures.push(`${projectPath}: ${fixResult.error ?? '测试未通过'}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[FixAgent] report=${reportId} project=${projectPath}: 修复异常`, msg)
        await createEvent({
          reportId,
          projectPath,
          code: 'fix_attempt',
          status: 'failed',
          durationMs: Date.now() - startedAt,
          data: { attempt, error: msg },
        })
        failures.push(`${projectPath}: ${msg}`)
      }
    }

    if (failures.length > 0) {
      return {
        success: false,
        error: 'fix_failed',
        output: `修复失败 (${failures.length}/${scopes.length}): ${failures.join('; ')}`,
      }
    }
    return {
      success: true,
      output: `修复完成 ${successes.length} 个 project: ${successes.join(', ')}`,
      data: { reportId, successes },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[FixAgent] handler error:', msg)
    return { success: false, error: 'handler_error', output: `handler 异常: ${msg}` }
  }
}

export function registerFixHandlers(): void {
  registerCapabilityHandler('fix_bug_l1', opts => handleFixBug(opts, 'l1'))
  registerCapabilityHandler('fix_bug_l2', opts => handleFixBug(opts, 'l2'))
  registerCapabilityHandler('fix_bug_l3', opts => handleFixBug(opts, 'l3'))
  console.log('[FixAgent] fix_bug_l1/l2/l3 handlers registered')
}
