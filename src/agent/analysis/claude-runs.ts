/**
 * analyze_bug 两阶段 Claude CLI 调用封装。
 * 分离到独立模块以便单元测试 mock。
 *
 * 阶段 A（runFilterStage）：让 Claude 从候选 project 列表中筛选涉及的 project。
 * 阶段 B（runDetailStage）：对单个 project 做根因详细分析。
 */
import { runClaudeCli } from '../claude-cli.js'
import type { Worktree } from '../worktree/manager.js'
import type { BugClassification, BugLevel, ConfidenceLevel, Solution } from '../../db/repositories/bug-analysis-reports.js'
import { isClaudeMock, popMockResponseValidated } from '../mocks/e2e-store.js'

export interface FilterProjectCandidate {
  projectPath: string
  name: string
  displayName: string
  description: string
}

export interface FilterInvolvedProject {
  projectPath: string
  isPrimary: boolean
  sourceBranch: string
}

export interface FilterStageResult {
  involvedProjects: FilterInvolvedProject[]
  primaryProjectPath: string
}

export interface FilterStageInput {
  userMessage: string
  candidates: FilterProjectCandidate[]
  mainRepoWorktreePath: string
  defaultBranch: string
  systemPrompt: string
  signal?: AbortSignal
}

export interface DetailStageInput {
  userMessage: string
  projectPath: string
  worktreePath: string
  sourceBranch: string
  systemPrompt: string
  signal?: AbortSignal
}

export interface DetailStageResult {
  classification: BugClassification
  level: BugLevel
  confidence: ConfidenceLevel
  confidenceScore: number
  rootCause: {
    type: string
    summary: string
    file: string
    lineRange: number[]
  }
  solutions: Solution[]
  affectedModules: string[]
  analysisSteps: string[]
  markdown: string
}

/** 从 Claude 原始输出里把最后一段 JSON 提取出来。 */
export function extractJsonFromOutput(text: string): string | null {
  // 找最外层 JSON 对象：从第一个 `{` 开始配对（不是 lastIndexOf，避免嵌套时抓到内层对象）。
  const idx = text.indexOf('{')
  if (idx === -1) return null
  let depth = 0
  let end = -1
  let inString = false
  let escape = false
  for (let i = idx; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end === -1) return null
  return text.substring(idx, end)
}

/**
 * 从 Claude 输出里鲁棒地提取 JSON 文本（兼容 ```json 代码块、自然语言前缀、纯 JSON、数组等情况）。
 * 返回清洗后的 JSON 字符串（未 parse），调用方自行 JSON.parse。
 * 如果无法识别任何 JSON 结构，则返回原始 trim 过的文本。
 */
export function extractJson(text: string): string {
  // 1. 优先匹配 ```json ... ``` 或 ``` ... ``` 代码块
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenceMatch) return fenceMatch[1].trim()

  // 2. 找第一个 { 到最后一个 }（对象情况）
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim()
  }

  // 3. 找第一个 [ 到最后一个 ]（数组情况）
  const firstBracket = text.indexOf('[')
  const lastBracket = text.lastIndexOf(']')
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    return text.slice(firstBracket, lastBracket + 1).trim()
  }

  // 4. fallback: 原样返回
  return text.trim()
}

/** 阶段 A：筛选涉及哪些 project。 */
export async function runFilterStage(input: FilterStageInput): Promise<FilterStageResult> {
  if (isClaudeMock()) {
    return popMockResponseValidated<FilterStageResult>('analyze_bug-filter', [
      'involvedProjects',
      'primaryProjectPath',
    ])
  }

  const candidateList = input.candidates
    .map(c => `- ${c.projectPath} (name=${c.name}, display=${c.displayName}): ${c.description || '无描述'}`)
    .join('\n')

  const prompt = `${input.systemPrompt}

你现在只做**问题范围筛选**（阶段 A），不做详细分析。

## 候选 project 列表（同一产品线下所有代码仓库）

${candidateList}

## 代码仓库路径（主仓库）

${input.mainRepoWorktreePath}
默认分支: ${input.defaultBranch}

## 用户问题

${input.userMessage}

## 输出要求

请判断这个问题涉及上述候选 project 列表中的哪几个仓库，并挑出其中一个作为"主仓库"（主 Issue 将创建在主仓库下）。
**只输出 JSON**，不要有任何其他文字。格式：

{
  "involvedProjects": [
    { "projectPath": "PAM/xxx", "isPrimary": true, "sourceBranch": "${input.defaultBranch}" },
    { "projectPath": "PAM/yyy", "isPrimary": false, "sourceBranch": "${input.defaultBranch}" }
  ],
  "primaryProjectPath": "PAM/xxx"
}
`

  const rawOutput = await runClaudeCli({
    prompt,
    allowedTools: 'Read,Glob,Grep',
    timeoutMs: 10 * 60_000,
    onEvent: (e) => console.log(`[AnalysisFilter] ${e.type}: ${e.message}`),
    signal: input.signal,
  })

  const jsonStr = extractJsonFromOutput(rawOutput)
  if (!jsonStr) {
    throw new Error(`阶段 A 筛选失败：Claude 未返回 JSON。输出末尾: ${rawOutput.slice(-200)}`)
  }
  // 对 Markdown 代码块 / 自然语言前缀做一次鲁棒清洗（jsonStr 已经是从 `{` 开始到配对 `}` 的片段，
  // 但若外层有 ``` 包裹或其它干扰字符，extractJson 能再兜一次底）。
  const cleaned = extractJson(jsonStr)
  const parsed = JSON.parse(cleaned) as {
    involvedProjects?: Array<{ projectPath?: string; isPrimary?: boolean; sourceBranch?: string }>
    primaryProjectPath?: string
  }
  if (!parsed.involvedProjects?.length || !parsed.primaryProjectPath) {
    throw new Error(`阶段 A 筛选失败：JSON 字段缺失: ${cleaned}`)
  }
  return {
    involvedProjects: parsed.involvedProjects.map(p => ({
      projectPath: p.projectPath!,
      isPrimary: Boolean(p.isPrimary),
      sourceBranch: p.sourceBranch ?? input.defaultBranch,
    })),
    primaryProjectPath: parsed.primaryProjectPath,
  }
}

/** 阶段 B：单个 project 的详细根因分析。 */
export async function runDetailStage(input: DetailStageInput): Promise<DetailStageResult> {
  if (isClaudeMock()) {
    return popMockResponseValidated<DetailStageResult>('analyze_bug-detail', [
      'classification',
      'markdown',
    ])
  }

  const prompt = `${input.systemPrompt}

代码仓库路径: ${input.worktreePath}
当前 project: ${input.projectPath}
当前分支: ${input.sourceBranch}

用户问题: ${input.userMessage}

请按系统提示中的四阶段方法论进行根因分析，并在分析报告（中文 Markdown）之后，**在输出末尾追加一段严格的 JSON 结果**（见系统提示中的格式）。
`
  const rawOutput = await runClaudeCli({
    prompt,
    allowedTools: 'Read,Glob,Grep',
    timeoutMs: 20 * 60_000,
    onEvent: (e) => console.log(`[AnalysisDetail:${input.projectPath}] ${e.type}: ${e.message}`),
    signal: input.signal,
  })

  // 先找 {"classification" 开头的 JSON（不同格式：紧凑或带空格）
  const patterns = [/\{"classification"/g, /\{\s*"classification"/g]
  let idx = -1
  for (const re of patterns) {
    let lastMatch = -1
    let m: RegExpExecArray | null
    while ((m = re.exec(rawOutput)) !== null) {
      lastMatch = m.index
    }
    if (lastMatch !== -1) { idx = lastMatch; break }
  }
  let jsonStr: string | null = null
  if (idx !== -1) {
    let depth = 0
    let end = -1
    for (let i = idx; i < rawOutput.length; i++) {
      if (rawOutput[i] === '{') depth++
      if (rawOutput[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    if (end !== -1) jsonStr = rawOutput.substring(idx, end)
  }

  // 若仍未定位到 classification 段，兜底用 extractJson（处理 Markdown 代码块 / 自然语言前缀等）
  if (!jsonStr) {
    const cleaned = extractJson(rawOutput)
    if (cleaned && cleaned.includes('"classification"')) {
      jsonStr = cleaned
      idx = rawOutput.indexOf(cleaned)
      if (idx < 0) idx = 0
    }
  }

  if (!jsonStr) {
    throw new Error(`阶段 B 分析失败(${input.projectPath})：未解析到 JSON。输出末尾: ${rawOutput.slice(-200)}`)
  }

  const data = JSON.parse(jsonStr) as {
    classification: BugClassification
    level: BugLevel
    confidence: ConfidenceLevel
    confidence_score: number
    root_cause: { type: string; summary: string; file: string; line_range: number[] }
    solutions: Solution[]
    affected_modules?: string[]
    analysis_steps?: string[]
  }

  const markdown = rawOutput.substring(0, idx).trim()

  return {
    classification: data.classification,
    level: data.level,
    confidence: data.confidence,
    confidenceScore: data.confidence_score,
    rootCause: {
      type: data.root_cause.type,
      summary: data.root_cause.summary,
      file: data.root_cause.file,
      lineRange: data.root_cause.line_range ?? [],
    },
    solutions: data.solutions ?? [],
    affectedModules: data.affected_modules ?? [],
    analysisSteps: data.analysis_steps ?? [],
    markdown,
  }
}

/** Reduce 多 project 详细分析为一份统一结果（取最高级别、合并模块、拼接 Markdown）。 */
export interface MergedAnalysis {
  classification: BugClassification
  level: BugLevel
  confidence: ConfidenceLevel
  confidenceScore: number
  rootCauseSummary: string
  solutionsJson: Solution[]
  affectedModules: string[]
  affectedModulesByProject: Record<string, string[]>
  analysisSteps: string[]
  markdownFull: string
  metadata: Record<string, unknown>
}

export function mergeDetailResults(
  perProject: Array<{ projectPath: string; detail: DetailStageResult }>,
): MergedAnalysis {
  // 级别取最高（l4 > l3 > l2 > l1）
  const levelRank: Record<BugLevel, number> = { l1: 1, l2: 2, l3: 3, l4: 4 }
  let topLevel: BugLevel = 'l1'
  // classification: 如果任一是 bug 则 bug，否则按多数（简化取第一个）
  let classification: BugClassification = perProject[0]?.detail.classification ?? 'usage_issue'
  let confidence: ConfidenceLevel = 'low'
  let confidenceScore = 0
  const affectedModulesByProject: Record<string, string[]> = {}
  const affectedModulesAll = new Set<string>()
  const analysisStepsAll: string[] = []
  const markdownParts: string[] = []
  const rootCauseParts: string[] = []

  for (const { projectPath, detail } of perProject) {
    if (levelRank[detail.level] > levelRank[topLevel]) topLevel = detail.level
    if (detail.classification === 'bug') classification = 'bug'
    if (detail.confidenceScore > confidenceScore) {
      confidenceScore = detail.confidenceScore
      confidence = detail.confidence
    }
    affectedModulesByProject[projectPath] = detail.affectedModules
    for (const m of detail.affectedModules) affectedModulesAll.add(m)
    for (const step of detail.analysisSteps) analysisStepsAll.push(`[${projectPath}] ${step}`)
    markdownParts.push(`## Project: ${projectPath}\n\n${detail.markdown}`)
    rootCauseParts.push(`[${projectPath}] ${detail.rootCause.summary}`)
  }

  const markdownFull = markdownParts.join('\n\n---\n\n')

  return {
    classification,
    level: topLevel,
    confidence,
    confidenceScore,
    rootCauseSummary: rootCauseParts.join('；'),
    solutionsJson: perProject.flatMap(p => p.detail.solutions),
    affectedModules: [...affectedModulesAll],
    affectedModulesByProject,
    analysisSteps: analysisStepsAll,
    markdownFull,
    metadata: {
      perProject: perProject.map(p => ({
        projectPath: p.projectPath,
        level: p.detail.level,
        classification: p.detail.classification,
        confidence: p.detail.confidence,
        rootCause: p.detail.rootCause,
      })),
    },
  }
}

// 避免 Worktree 类型未使用告警（供外部 import 参考）
export type { Worktree }
