import { registerCapabilityHandler, handleAnalysisComplete } from '../coordinator.js'
import { acquire, release } from '../worktree/manager.js'
import { createBugAnalysisReport, updateReportStatus } from '../../db/repositories/bug-analysis-reports.js'
import { createStat } from '../../db/repositories/bug-analysis-stats.js'
import { getByProductLineId } from '../../db/repositories/product-knowledge-repos.js'
import { getTool } from '../tools/index.js'
import { ANALYZE_BUG_SYSTEM_PROMPT } from './prompts.js'
import { mask } from '../masking/sensitive-info.js'
import type { BugLevel, BugClassification, ConfidenceLevel, Solution } from '../../db/repositories/bug-analysis-reports.js'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import type { ClaudeRunner } from '../claude-runner.js'

// ClaudeRunner 实例由 server.ts 注入
let runner: ClaudeRunner | null = null
export function setClaudeRunner(r: ClaudeRunner): void { runner = r }

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
    const jsonMatch = text.match(/\{[\s\S]*"classification"[\s\S]*\}/)
    if (!jsonMatch) return null
    const data = JSON.parse(jsonMatch[0])
    // 验证必需字段
    const required = ['classification', 'level', 'confidence', 'root_cause', 'solutions']
    if (!required.every(k => k in data)) {
      console.warn('[AnalysisAgent] parsed JSON missing required fields:', required.filter(k => !(k in data)))
      return null
    }
    if (!data.root_cause?.summary || !Array.isArray(data.solutions)) {
      console.warn('[AnalysisAgent] invalid root_cause or solutions structure')
      return null
    }
    return data as AnalysisOutput
  } catch (err) {
    console.warn('[AnalysisAgent] JSON parse failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

function buildMarkdownReport(output: AnalysisOutput): string {
  const levelLabels: Record<string, string> = { l1: 'L1 配置类', l2: 'L2 简单代码', l3: 'L3 业务逻辑', l4: 'L4 架构级' }
  const confLabels: Record<string, string> = { high: '高', medium: '中', low: '低' }

  let md = `## AI 分析报告\n\n`
  md += `**级别**: ${levelLabels[output.level] ?? output.level}\n`
  md += `**置信度**: ${confLabels[output.confidence] ?? output.confidence}（${(output.confidence_score * 100).toFixed(0)}%）\n`
  md += `**分类**: ${output.classification}\n\n`
  md += `### 根因\n\n${output.root_cause.summary}\n\n`
  md += `**文件**: \`${output.root_cause.file}\` (L${output.root_cause.line_range[0]}-L${output.root_cause.line_range[1]})\n\n`

  if (output.solutions.length > 0) {
    md += `### 修复方案\n\n`
    for (const s of output.solutions) {
      const rec = s.recommended ? ' ⭐ **推荐**' : ''
      md += `- **${s.id}**: ${s.summary}（风险: ${s.risk}，工作量: ${s.effort}）${rec}\n`
    }
    md += '\n'
  }

  if (output.affected_modules.length > 0) {
    md += `### 影响模块\n\n${output.affected_modules.join(', ')}\n\n`
  }

  md += `### 分析过程\n\n`
  for (const step of output.analysis_steps) {
    md += `1. ${step}\n`
  }

  return md
}

async function handleAnalyzeBug(opts: TriggerOptions): Promise<TriggerResult> {
  const { context, extraParams } = opts
  const productLineId = extraParams?.productLineId as number | undefined
  const userMessage = extraParams?.message as string | undefined
  const version = (extraParams?.version as string) ?? 'develop'

  if (!productLineId || !userMessage) {
    return { success: false, error: '缺少 productLineId 或 message' }
  }

  const knowledgeRepo = await getByProductLineId(productLineId)
  if (!knowledgeRepo) {
    return { success: false, error: `产品线 ${productLineId} 未配置代码仓库` }
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
    return { success: false, error: `创建 worktree 失败: ${err instanceof Error ? err.message : String(err)}` }
  }

  try {
    const startMs = Date.now()

    if (!runner) {
      return { success: false, error: 'ClaudeRunner 未初始化' }
    }

    // 获取 analyze_bug 允许的工具
    const toolNames = ['read_code', 'search_knowledge', 'download_image', 'switch_version', 'create_issue']
    const tools = toolNames.map(n => getTool(n)).filter(Boolean) as any[]

    // 调用 Claude 执行分析
    const rawOutput = await runner.executeCapabilityDirect({
      prompt: `用户反馈的问题：\n${userMessage}`,
      systemPrompt: ANALYZE_BUG_SYSTEM_PROMPT,
      context: { ...opts.context, cwd: worktree.path, productLineId },
      tools,
      cwd: worktree.path,
      sessionKey: `analysis-${opts.context.taskId}`,
    })

    const durationMs = Date.now() - startMs
    const maskedOutput = mask(rawOutput)

    // 解析 Claude 输出为结构化报告
    const analysisOutput = parseAnalysisOutput(maskedOutput)

    if (!analysisOutput) {
      console.warn('[AnalysisAgent] failed to parse structured output, returning raw text')
      return { success: true, output: maskedOutput }
    }

    // 只有 Bug 类型才存入 DB 和创建 Issue
    if (analysisOutput.classification === 'bug') {
      const report = await createBugAnalysisReport({
        issueId: 0, // Issue 由 Claude 通过 create_issue 工具创建，后续更新
        issueUrl: '',
        productLineId,
        agentSessionId: opts.context.taskId,
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

      // 记录统计
      await createStat({ reportId: report.id, durationMs, cacheHit: false, tokenCount: null }).catch(() => {})

      // 通知 Coordinator 分析完成（触发后续修复流程）
      await handleAnalysisComplete(report.id, analysisOutput.level, report.issueId)

      const markdown = buildMarkdownReport(analysisOutput)
      return { success: true, output: markdown }
    }

    // 非 Bug（config_issue / usage_issue）直接返回分析结果
    return { success: true, output: maskedOutput }
  } finally {
    release(worktree)
  }
}

export function registerAnalysisBugHandler(): void {
  registerCapabilityHandler('analyze_bug', handleAnalyzeBug)
  console.log('[AnalysisAgent] analyze_bug handler registered')
}

export { parseAnalysisOutput, buildMarkdownReport }
