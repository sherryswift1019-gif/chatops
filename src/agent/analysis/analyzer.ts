import { registerCapabilityHandler } from '../coordinator.js'
import { acquire, release, makeWorktreeKey } from '../worktree/manager.js'
import {
  createBugAnalysisReport,
  updateReportStatus,
} from '../../db/repositories/bug-analysis-reports.js'
import { createStat } from '../../db/repositories/bug-analysis-stats.js'
import { getByProductLineId as getKnowledgeRepoByProductLineId } from '../../db/repositories/product-knowledge-repos.js'
import { getCapabilityByKey } from '../../db/repositories/capabilities.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { createEvent } from '../../db/repositories/bug-fix-events.js'
import { runFilterStage, runDetailStage, mergeDetailResults } from './claude-runs.js'
import { gitlabCreateIssue, gitlabPostIssueNote } from './gitlab-issue.js'
import type {
  BugLevel,
  BugClassification,
  ConfidenceLevel,
  Solution,
} from '../../db/repositories/bug-analysis-reports.js'
import type { TriggerOptions, TriggerResult } from '../coordinator.js'

/**
 * 保留原有 parseAnalysisOutput 导出签名供老测试和老集成测试使用。
 * 本 Task 的新流程走 claude-runs.ts 内部的解析逻辑，这里仅用于向后兼容。
 */
export interface AnalysisOutput {
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

export function parseAnalysisOutput(text: string): AnalysisOutput | null {
  try {
    // 匹配 `{` 后允许空白再接 `"classification"`（兼容格式化过的 JSON）
    const match = text.match(/\{\s*"classification"/)
    if (!match || match.index === undefined) return null
    const idx = match.index
    let depth = 0
    let end = -1
    for (let i = idx; i < text.length; i++) {
      if (text[i] === '{') depth++
      if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    if (end === -1) return null
    const data = JSON.parse(text.substring(idx, end))
    const required = ['classification', 'level', 'confidence', 'root_cause', 'solutions']
    if (!required.every(k => k in data)) return null
    if (!data.root_cause?.summary || !Array.isArray(data.solutions)) return null
    return data as AnalysisOutput
  } catch {
    return null
  }
}

const LEVEL_LABEL: Record<BugLevel, string> = {
  l1: 'L1 配置类',
  l2: 'L2 简单代码',
  l3: 'L3 业务逻辑',
  l4: 'L4 架构级',
}

/**
 * 从 AnalysisOutput（老的单 project 结构）生成 Markdown 报告。保留导出以兼容现有
 * 集成测试 (`full-analysis-flow`, `full-bug-fix-flow`, `analyze-bug-flow`)。
 */
export function buildMarkdownReport(output: AnalysisOutput): string {
  const pct = Math.round((output.confidence_score ?? 0) * 100)
  const modules = output.affected_modules?.length ? output.affected_modules.join(', ') : '-'
  const solutions = output.solutions
    .map(s => `- **${s.id}** ${s.recommended ? '（推荐）' : ''}：${s.summary} [风险 ${s.risk}, 规模 ${s.effort}]`)
    .join('\n')
  const steps = (output.analysis_steps ?? []).map(s => `- ${s}`).join('\n')
  return `## AI 分析报告

**分类**: ${output.classification}
**等级**: ${LEVEL_LABEL[output.level] ?? output.level}
**置信度**: ${output.confidence} (${pct}%)

### 根因

${output.root_cause.summary}

文件：\`${output.root_cause.file}\`（行 ${output.root_cause.line_range.join('-')}）

### 方案

${solutions}

### 影响模块

${modules}

### 分析步骤

${steps}
`
}

/** 提取主 Issue 标题（取根因摘要前 80 字）。 */
function buildIssueTitle(summary: string): string {
  const s = summary.trim().replace(/\n+/g, ' ')
  return `[AI 分析] ${s.substring(0, 80)}`
}

/** 计算 reuse 模式的 N（基于已有 create_issue 事件数量）—— 简单记录次数的字符串。 */
function buildReuseMarker(): string {
  return `🔄 复用 Issue 的再次分析（${new Date().toISOString()}）`
}

async function handleAnalyzeBug(opts: TriggerOptions): Promise<TriggerResult> {
  const startMs = Date.now()
  const { context, extraParams } = opts
  const productLineId = extraParams?.productLineId as number | undefined
  const userMessage = extraParams?.message as string | undefined
  const reuseIssueId = extraParams?.reuseIssueId as number | undefined

  if (!productLineId || !userMessage) {
    console.error('[AnalysisAgent] 缺少参数:', { productLineId, hasMessage: !!userMessage })
    return { success: false, error: '缺少 productLineId 或 message' }
  }

  const knowledgeRepo = await getKnowledgeRepoByProductLineId(productLineId)
  if (!knowledgeRepo) {
    return { success: false, error: `产品线 ${productLineId} 未配置代码仓库（product_knowledge_repos）` }
  }

  const defaultBranch =
    (extraParams?.version as string | undefined) ?? knowledgeRepo.codeDefaultBranch ?? 'master'

  const capabilityRow = await getCapabilityByKey('analyze_bug')
  if (!capabilityRow?.systemPrompt) {
    return { success: false, error: 'analyze_bug 未配置 systemPrompt，请在管理后台配置' }
  }

  const projects = await listProjects(productLineId)
  if (projects.length === 0) {
    return { success: false, error: `产品线 ${productLineId} 下未配置任何 project` }
  }

  const gitlabUrlBase = process.env.GITLAB_URL ?? ''

  // ========== 阶段 A：clone 主仓库 + 让 Claude 筛选涉及的 project ==========
  let mainWorktree
  try {
    mainWorktree = await acquire({
      userId: context.initiatorId || 'system',
      product: `pl-${productLineId}`,
      version: defaultBranch,
      sessionId: `${context.taskId}-filter`,
      repoUrl: knowledgeRepo.codeRepoUrl,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: `阶段A 主仓库 clone 失败: ${msg}` }
  }

  let filterResult
  try {
    filterResult = await runFilterStage({
      userMessage,
      candidates: projects.map(p => ({
        projectPath: p.gitlabPath,
        name: p.name,
        displayName: p.displayName,
        description: p.description,
      })),
      mainRepoWorktreePath: mainWorktree.path,
      defaultBranch,
      systemPrompt: capabilityRow.systemPrompt,
      signal: opts.signal,
    })
  } catch (err) {
    release(mainWorktree)
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: `阶段A 筛选失败: ${msg}` }
  } finally {
    // 主仓库 worktree 筛选结束即可释放（阶段 B 按 project 独立 clone）
    release(mainWorktree)
  }

  // ========== 阶段 B：并行对每个涉及 project 做详细分析 ==========
  const projectByPath = new Map(projects.map(p => [p.gitlabPath, p]))

  const detailRuns = await Promise.all(
    filterResult.involvedProjects.map(async (p) => {
      const pj = projectByPath.get(p.projectPath)
      if (!pj) throw new Error(`筛选出的 project 未在候选列表中: ${p.projectPath}`)
      // 每个 project 独立 clone（worktree manager 新 key 里带 projectPath）
      const projectRepoUrl = `${gitlabUrlBase.replace(/\/$/, '')}/${p.projectPath}.git`
      const key = makeWorktreeKey({
        productLineId,
        projectPath: p.projectPath,
        branch: p.sourceBranch,
      })
      const wt = await acquire({
        userId: context.initiatorId || 'system',
        product: `pl-${productLineId}`,
        version: p.sourceBranch,
        sessionId: `${context.taskId}-detail-${key}`,
        repoUrl: projectRepoUrl,
        projectPath: p.projectPath,
      })
      try {
        const detail = await runDetailStage({
          userMessage,
          projectPath: p.projectPath,
          worktreePath: wt.path,
          sourceBranch: p.sourceBranch,
          systemPrompt: capabilityRow.systemPrompt!,
          signal: opts.signal,
        })
        return { projectPath: p.projectPath, detail }
      } finally {
        release(wt)
      }
    }),
  )

  const merged = mergeDetailResults(detailRuns)
  const durationMs = Date.now() - startMs

  // ========== 创建 Issue（或复用）========== 仅在 classification=bug 时
  let issueIid = 0
  let issueUrl = ''
  let isReused = false

  if (merged.classification === 'bug') {
    if (reuseIssueId) {
      // 复用模式：向原 Issue 追加 comment
      const body = `${buildReuseMarker()}\n\n${merged.markdownFull}`
      const note = await gitlabPostIssueNote({
        projectPath: filterResult.primaryProjectPath,
        issueIid: reuseIssueId,
        body,
      })
      issueIid = reuseIssueId
      issueUrl = note.issueUrl
      isReused = true
    } else {
      const created = await gitlabCreateIssue({
        projectPath: filterResult.primaryProjectPath,
        title: buildIssueTitle(merged.rootCauseSummary),
        description: merged.markdownFull,
        labels: `ai-analyzed,level-${merged.level},needs-analysis`,
      })
      issueIid = created.iid
      issueUrl = created.url
    }
  }

  // ========== 写 bug_analysis_reports ==========
  const report = await createBugAnalysisReport({
    issueId: issueIid,
    issueUrl: issueUrl,
    productLineId,
    agentSessionId: context.taskId,
    level: merged.level,
    classification: merged.classification,
    confidence: merged.confidence,
    confidenceScore: merged.confidenceScore,
    rootCauseSummary: merged.rootCauseSummary,
    solutionsJson: merged.solutionsJson,
    affectedModules: merged.affectedModules,
    analysisSteps: merged.analysisSteps,
    metadata: merged.metadata,
    primaryProjectPath: filterResult.primaryProjectPath,
  })

  // ========== 写 bug_fix_events: analysis（Bug 级，projectPath=NULL） ==========
  await createEvent({
    reportId: report.id,
    projectPath: null,
    code: 'analysis',
    durationMs,
    data: {
      level: merged.level,
      classification: merged.classification,
      confidence: merged.confidence,
      confidenceScore: merged.confidenceScore,
      rootCauseSummary: merged.rootCauseSummary,
      productLineId,
      projects: filterResult.involvedProjects.map(p => ({
        projectPath: p.projectPath,
        sourceBranch: p.sourceBranch,
        isPrimary: p.isPrimary,
        affectedModules: merged.affectedModulesByProject[p.projectPath] ?? [],
      })),
    },
  })

  // ========== status + 后续事件（仅 bug） ==========
  if (merged.classification !== 'bug') {
    await updateReportStatus(report.id, 'completed')
    await createStat({ reportId: report.id, durationMs, cacheHit: false, tokenCount: null }).catch(() => {})
    return {
      success: true,
      output: `非 bug 类型 (${merged.classification})，分析完成。`,
      data: { reportId: report.id, classification: merged.classification, level: merged.level },
    }
  }

  await updateReportStatus(report.id, 'published')

  for (const p of filterResult.involvedProjects) {
    await createEvent({
      reportId: report.id,
      projectPath: p.projectPath,
      code: 'scope_identified',
      data: {
        sourceBranch: p.sourceBranch,
        affectedModules: merged.affectedModulesByProject[p.projectPath] ?? [],
        isPrimary: p.isPrimary,
      },
    })
  }

  await createEvent({
    reportId: report.id,
    projectPath: filterResult.primaryProjectPath,
    code: 'create_issue',
    data: { issueIid, issueUrl, isPrimary: true, isReused },
  })

  await createStat({ reportId: report.id, durationMs, cacheHit: false, tokenCount: null }).catch(() => {})

  return {
    success: true,
    output: `Bug 分析完成: ${merged.classification} / ${merged.level}，涉及 ${filterResult.involvedProjects.length} 个 project`,
    data: { reportId: report.id, classification: merged.classification, level: merged.level },
  }
}

export { handleAnalyzeBug }

export function registerAnalysisBugHandler(): void {
  registerCapabilityHandler('analyze_bug', handleAnalyzeBug)
  console.log('[AnalysisAgent] analyze_bug handler registered')
}
