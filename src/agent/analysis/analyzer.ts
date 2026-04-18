import { registerCapabilityHandler, handleAnalysisComplete } from '../coordinator.js'
import { acquire, release } from '../worktree/manager.js'
import { createBugAnalysisReport, updateReportStatus } from '../../db/repositories/bug-analysis-reports.js'
import { createStat } from '../../db/repositories/bug-analysis-stats.js'
import { getByProductLineId } from '../../db/repositories/product-knowledge-repos.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { runClaudeCli } from '../claude-cli.js'
import { mask } from '../masking/sensitive-info.js'
import axios from 'axios'
import type { BugLevel, BugClassification, ConfidenceLevel, Solution } from '../../db/repositories/bug-analysis-reports.js'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'

interface AnalysisOutput {
  classification: BugClassification
  level: BugLevel
  confidence: ConfidenceLevel
  confidence_score: number
  root_cause: {
    type: string
    summary: string
    file: string
    line_range: number[]
  }
  solutions: Solution[]
  affected_modules: string[]
  analysis_steps: string[]
}

function parseAnalysisOutput(text: string): AnalysisOutput | null {
  try {
    // 从后往前找 JSON——Claude 输出中报告在前、JSON 在最后
    const idx = text.lastIndexOf('{"classification"')
    if (idx === -1) return null

    // 找到 JSON 结尾的 }
    let depth = 0
    let end = -1
    for (let i = idx; i < text.length; i++) {
      if (text[i] === '{') depth++
      if (text[i] === '}') depth--
      if (depth === 0) { end = i + 1; break }
    }
    if (end === -1) return null

    const jsonStr = text.substring(idx, end)
    const data = JSON.parse(jsonStr)
    const required = ['classification', 'level', 'confidence', 'root_cause', 'solutions']
    if (!required.every(k => k in data)) return null
    if (!data.root_cause?.summary || !Array.isArray(data.solutions)) return null
    return data as AnalysisOutput
  } catch {
    return null
  }
}

function extractProjectPath(codeRepoUrl: string): string {
  const url = codeRepoUrl.replace(/\.git$/, '')
  const httpMatch = url.match(/https?:\/\/[^/]+\/(.+)/)
  if (httpMatch) return httpMatch[1]
  const sshMatch = url.match(/[^:]+:(.+)/)
  if (sshMatch) return sshMatch[1]
  return url
}

async function createGitLabIssue(opts: {
  projectPath: string
  title: string
  description: string
  labels: string
}): Promise<{ iid: number; url: string } | null> {
  const gitlabUrl = process.env.GITLAB_URL
  const gitlabToken = process.env.GITLAB_TOKEN
  if (!gitlabUrl || !gitlabToken) return null

  try {
    const response = await axios.post(
      `${gitlabUrl}/api/v4/projects/${encodeURIComponent(opts.projectPath)}/issues`,
      { title: opts.title, description: opts.description, labels: opts.labels },
      { headers: { 'PRIVATE-TOKEN': gitlabToken }, timeout: 15_000 }
    )
    const issue = response.data
    console.log(`[AnalysisAgent] Issue #${issue.iid} 已创建: ${issue.web_url}`)
    return { iid: issue.iid, url: issue.web_url }
  } catch (err) {
    console.error('[AnalysisAgent] 创建 Issue 失败:', err instanceof Error ? err.message : String(err))
    return null
  }
}

async function handleAnalyzeBug(opts: TriggerOptions): Promise<TriggerResult> {
  const { context, extraParams } = opts
  const productLineId = extraParams?.productLineId as number | undefined
  const userMessage = extraParams?.message as string | undefined

  if (!productLineId || !userMessage) {
    console.error('[AnalysisAgent] 缺少参数:', { productLineId, hasMessage: !!userMessage })
    return { success: false, error: '缺少 productLineId 或 message' }
  }

  const knowledgeRepo = await getByProductLineId(productLineId)
  if (!knowledgeRepo) {
    return { success: false, error: `产品线 ${productLineId} 未配置代码仓库` }
  }

  const version = extraParams?.version as string | undefined
  if (!version) {
    return { success: false, error: '请指定分支，例如：pas test 堡垒机访问报错' }
  }

  const capabilityRow = await getCapabilityByKey('analyze_bug')
  if (!capabilityRow?.systemPrompt) {
    return { success: false, error: 'analyze_bug 未配置 systemPrompt，请在管理后台配置' }
  }

  let worktree
  try {
    worktree = await acquire({
      userId: context.initiatorId,
      product: `pl-${productLineId}`,
      version,
      sessionId: context.taskId,
      repoUrl: knowledgeRepo.codeRepoUrl,
    })
  } catch (err) {
    console.error('[AnalysisAgent] 创建 worktree 失败:', err instanceof Error ? err.message : String(err))
    return { success: false, error: `创建 worktree 失败: ${err instanceof Error ? err.message : String(err)}` }
  }

  try {
    const startMs = Date.now()

    const prompt = `${capabilityRow.systemPrompt}\n\n代码仓库路径: ${worktree.path}\n\n用户问题: ${userMessage}`

    // 直接调 claude CLI（和 pam-smart 同方式）
    const rawOutput = await runClaudeCli({
      prompt,
      allowedTools: 'Read,Glob,Grep',
      timeoutMs: 20 * 60_000,
      onEvent: (e) => console.log(`[AnalysisAgent] ${e.type}: ${e.message}`),
      signal: opts.signal,
    })

    const durationMs = Date.now() - startMs
    const maskedOutput = mask(rawOutput)

    // 解析 JSON
    const analysisOutput = parseAnalysisOutput(maskedOutput)

    if (!analysisOutput) {
      console.warn('[AnalysisAgent] 未解析到 JSON，返回纯文本。输出最后200字:', maskedOutput.substring(maskedOutput.length - 200))
      return { success: true, output: maskedOutput }
    }

    console.log(`[AnalysisAgent] JSON 解析成功: classification=${analysisOutput.classification}, level=${analysisOutput.level}, confidence=${analysisOutput.confidence}`)

    // 去掉回复中的 JSON 部分，只保留中文报告
    const reportText = maskedOutput.replace(/\{[\s\S]*"classification"[\s\S]*\}/, '').trim()

    // Bug 类型：存 DB + 创建 Issue + 触发修复
    if (analysisOutput.classification === 'bug') {
      console.log(`[AnalysisAgent] Bug 类型，开始创建 Issue 和触发修复`)
      const projectPath = extractProjectPath(knowledgeRepo.codeRepoUrl)

      // 创建 GitLab Issue
      const issue = await createGitLabIssue({
        projectPath,
        title: `[AI 分析] ${analysisOutput.root_cause.summary.substring(0, 80)}`,
        description: `## AI 分析报告\n\n${reportText}\n\n---\n\n等级: ${analysisOutput.level}\n置信度: ${analysisOutput.confidence} (${analysisOutput.confidence_score})\n影响模块: ${analysisOutput.affected_modules.join(', ')}`,
        labels: `ai-analyzed,level-${analysisOutput.level},needs-analysis`,
      })

      // 存分析报告到 DB
      const report = await createBugAnalysisReport({
        issueId: issue?.iid ?? 0,
        issueUrl: issue?.url ?? '',
        productLineId,
        agentSessionId: context.taskId,
        level: analysisOutput.level,
        classification: analysisOutput.classification,
        confidence: analysisOutput.confidence,
        confidenceScore: analysisOutput.confidence_score,
        rootCauseSummary: analysisOutput.root_cause.summary,
        solutionsJson: analysisOutput.solutions,
        affectedModules: analysisOutput.affected_modules,
        analysisSteps: analysisOutput.analysis_steps,
        metadata: analysisOutput as any,
      })

      await updateReportStatus(report.id, 'published')
      await createStat({ reportId: report.id, durationMs, cacheHit: false, tokenCount: null }).catch(() => {})

      // 触发后续修复流程
      await handleAnalysisComplete(report.id, analysisOutput.level, issue?.iid ?? 0, context.initiatorId)

      // 返回带 Issue URL 的报告
      const issueInfo = issue ? `\n\n---\nGitLab Issue: ${issue.url}` : ''
      return { success: true, output: `${reportText}${issueInfo}` }
    }

    // 非 Bug（config_issue / usage_issue）直接返回
    console.log(`[AnalysisAgent] 非 Bug 类型 (${analysisOutput.classification})，不创建 Issue`)
    return { success: true, output: reportText || maskedOutput }
  } finally {
    release(worktree)
  }
}

export function registerAnalysisBugHandler(): void {
  registerCapabilityHandler('analyze_bug', handleAnalyzeBug)
  console.log('[AnalysisAgent] analyze_bug handler registered')
}

export { parseAnalysisOutput }
