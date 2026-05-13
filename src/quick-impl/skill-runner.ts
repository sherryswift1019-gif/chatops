/**
 * Quick-Impl Skill Runner
 *
 * 设计：docs/prds/prd-quick-impl.md §6.1 / §7 / §8.4
 *
 * 职责：
 *   1. 找 skill 文件（仓库 .claude/skills/<skill>/SKILL.md，host fallback ~/.claude/skills/）
 *   2. 找 role manifest 文件（.claude/skills/<skill>/roles/<role>.md）
 *   3. 在 worktree 写 .qi-context/{role.md, inputs.json, standards/}
 *   4. 启 ClaudeRunner 子 agent，传 mcpServerPath = quick-impl 专用 mcp-server
 *   5. 解析子 agent 输出末尾的 JSON block（fenced 优先 → 平衡括号 fallback → 失败兜底）
 *   6. zod 校验 JSON schema → 返回 SkillRunResult
 *
 * 依赖注入：execute 函数可被替换（测试用 fake，生产用 ClaudeRunner.executeCapabilityDirect 包装）
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve as pathResolve } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import { acquireLock, releaseLock } from './worktree.js'
import { linkBrainstormArtifacts } from '../pipeline/qi-context-helpers.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// =============================================================================
// Skill 文件加载
// =============================================================================

/**
 * 项目根目录：src/quick-impl/skill-runner.ts → 上溯 2 级
 */
function repoRoot(): string {
  if (_repoRootOverride !== null) return _repoRootOverride
  return pathResolve(__dirname, '..', '..')
}

// 测试钩子：让单测把 skill / role 文件放到 temp dir，避免污染真实 .claude/skills。
// 生产代码不应调用。
let _repoRootOverride: string | null = null
export function __setRepoRootForTesting(path: string | null): void {
  _repoRootOverride = path
}

export class SkillNotFoundError extends Error {
  constructor(skill: string, role?: string) {
    super(
      role
        ? `Skill role not found: ${skill}/${role}.md（搜索路径见 PRD §7）`
        : `Skill not found: ${skill}/SKILL.md（搜索路径见 PRD §7）`,
    )
    this.name = 'SkillNotFoundError'
  }
}

/**
 * 解析 skill 文件路径（PRD §7：仓库优先、host fallback）：
 *   1. <repo>/.claude/skills/<skill>/SKILL.md
 *   2. ~/.claude/skills/<skill>/SKILL.md
 */
export function resolveSkillPath(skill: string): string {
  const repoPath = join(repoRoot(), '.claude', 'skills', skill, 'SKILL.md')
  if (existsSync(repoPath)) return repoPath
  const hostPath = join(homedir(), '.claude', 'skills', skill, 'SKILL.md')
  if (existsSync(hostPath)) return hostPath
  throw new SkillNotFoundError(skill)
}

export function resolveRolePath(skill: string, role: string): string {
  const repoPath = join(
    repoRoot(),
    '.claude',
    'skills',
    skill,
    'roles',
    `${role}.md`,
  )
  if (existsSync(repoPath)) return repoPath
  const hostPath = join(
    homedir(),
    '.claude',
    'skills',
    skill,
    'roles',
    `${role}.md`,
  )
  if (existsSync(hostPath)) return hostPath
  throw new SkillNotFoundError(skill, role)
}

export function loadSkill(skill: string): string {
  return readFileSync(resolveSkillPath(skill), 'utf8')
}

export function loadRole(skill: string, role: string): string {
  return readFileSync(resolveRolePath(skill, role), 'utf8')
}

// =============================================================================
// Role manifest 加载（v2 §3.1.5：精准注入 standards 子集 + inputs 字段）
// =============================================================================

const RoleManifestEntrySchema = z.object({
  /** standards 文件名列表（相对 docs/standards/）；["*"] 表示全部 */
  standards: z.array(z.string()).default([]),
  /** inputs.json 的 inputs 字段子集；[] 表示全部 */
  inputs: z.array(z.string()).default([]),
})

const RoleManifestSchema = z
  .record(z.string(), z.union([RoleManifestEntrySchema, z.unknown()]))
  .transform((obj) => {
    const out: Record<string, z.infer<typeof RoleManifestEntrySchema>> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_') || k.startsWith('$')) continue // 跳过 _comment / $schema
      const parsed = RoleManifestEntrySchema.safeParse(v)
      if (parsed.success) out[k] = parsed.data
    }
    return out
  })

export type RoleManifestEntry = z.infer<typeof RoleManifestEntrySchema>
export type RoleManifest = Record<string, RoleManifestEntry>

/**
 * 加载 .claude/skills/<skill>/role-manifest.json 并校验。
 * 文件不存在 / 解析失败 → 返回 null（fallback 到一股脑模式）。
 *
 * env QI_NO_MANIFEST=1 强制返回 null（用于 A/B 对照评测，详见 docs/prds/quick-impl-roles-v2/04-prompt-strategy.md §5）。
 */
export function loadRoleManifest(skill: string): RoleManifest | null {
  if (process.env.QI_NO_MANIFEST === '1') {
    console.log('[skill-runner] QI_NO_MANIFEST=1 → manifest disabled (fallback mode)')
    return null
  }
  const manifestPath = join(
    repoRoot(),
    '.claude',
    'skills',
    skill,
    'role-manifest.json',
  )
  if (!existsSync(manifestPath)) {
    console.warn(`[skill-runner] manifest load failed: file not found at ${manifestPath} (fallback to all standards)`)
    return null
  }
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const parsed = RoleManifestSchema.safeParse(raw)
    if (!parsed.success) {
      console.warn(`[skill-runner] manifest schema invalid: ${parsed.error.message}`)
      return null
    }
    // 进一步校验：standards 字段引用的文件必须存在
    const standardsRoot = join(repoRoot(), 'docs', 'standards')
    const realFiles = existsSync(standardsRoot)
      ? new Set(readdirSync(standardsRoot).filter((f) => f.endsWith('.md')))
      : new Set<string>()
    for (const [role, entry] of Object.entries(parsed.data)) {
      for (const std of entry.standards) {
        if (std === '*') continue
        if (!realFiles.has(std)) {
          console.warn(
            `[skill-runner] manifest role=${role} references missing standard: ${std} (not found in docs/standards/)`,
          )
          return null
        }
      }
    }
    return parsed.data
  } catch (err) {
    console.warn(`[skill-runner] manifest load failed: ${err}`)
    return null
  }
}

/**
 * 按 role manifest 解析需要 symlink 的 standards 文件绝对路径列表。
 * - 如 manifest = ["*"]，返回 docs/standards/ 下所有 *.md
 * - 如 manifest = ["foo.md", "bar.md"]，返回这两个文件绝对路径
 * - 如 manifest 为 null（未加载），返回 [] —— 调用方应自行处理 fallback
 */
export function resolveStandardsByManifest(
  manifest: RoleManifest | null,
  role: string,
): string[] {
  if (!manifest) return []
  const entry = manifest[role]
  if (!entry) return []
  const standardsRoot = join(repoRoot(), 'docs', 'standards')
  if (!existsSync(standardsRoot)) return []

  const allFiles = readdirSync(standardsRoot).filter((f) => f.endsWith('.md'))
  if (entry.standards.includes('*')) {
    return allFiles.map((f) => join(standardsRoot, f))
  }
  return entry.standards
    .filter((s) => allFiles.includes(s))
    .map((s) => join(standardsRoot, s))
}

// =============================================================================
// previousRound 反馈（v2 §3.1.3, §3.1.4）
// =============================================================================

export interface AcceptanceCriterion {
  id: string
  format?: string
  text: string
}

export interface AcDiff {
  added: AcceptanceCriterion[]
  removed: string[] // AC id 列表
  changed: Array<{ id: string; oldText: string; newText: string }>
}

export interface PreviousRoundData {
  round: number
  decision: 'rejected' | 'fail'
  rejectReason?: string
  reviewerNotes?: Array<{ severity: 'warn' | 'error'; msg: string; file?: string }>
  previousArtifactPath?: string
  previousCommits?: string[]
  acDiff?: AcDiff
  /** 触发 round 的人/系统（人审 reject 时填用户名）*/
  decidedBy?: string
  /** 时间戳（ISO）*/
  decidedAt?: string
  /** v3：上轮 LLM 主动标记的 review 点；让 round N+1 LLM 看到自己上轮提示了什么 */
  prevReviewHints?: Array<{ severity: 'high' | 'medium' | 'low'; point: string; reason: string }>
  /** v3：上轮已被用户默认接受的 assumption；本轮无需重复列出（除非定义改变） */
  prevAssumptions?: Array<{ q: string; a: string; userMayDisagreeIf?: string }>
  /**
   * PRD §7 step 6：人审 rejected_plan 时定位的 task id（'T1'/'T2'/null=全局）。
   * 非空 → 修订仅集中在该 task；其它 task 保持稳定。
   */
  targetTaskId?: string
  /**
   * PRD §7 step 6：人审从 AI reviewer notes 中勾选的"已确认是真问题"子集。
   * 非空 → 这些 notes 必须逐条解决；未引用的 AI notes 视为 nitpick 可降级为 warn。
   */
  citedAiNotes?: string[]
}

/**
 * 把 previousRound 写成 .qi-context/feedback.md 的自然语言版（更适合 Claude 阅读）。
 * 详见 docs/prds/quick-impl-roles-v2/02-data-flow.md §3。
 */
export function renderFeedbackMarkdown(prev: PreviousRoundData): string {
  const lines: string[] = []
  lines.push(`# 上一轮反馈（Round ${prev.round} → Round ${prev.round + 1}）`)
  lines.push('')
  lines.push('## 决策')
  const by = prev.decidedBy ?? '系统'
  const at = prev.decidedAt ?? ''
  lines.push(`${prev.decision} by ${by}${at ? ' at ' + at : ''}`)
  lines.push('')
  if (prev.rejectReason) {
    lines.push('## 拒绝原因')
    lines.push('> ' + prev.rejectReason.replace(/\n/g, '\n> '))
    lines.push('')
  }
  if (prev.reviewerNotes && prev.reviewerNotes.length > 0) {
    lines.push('## Reviewer 标记')
    for (const n of prev.reviewerNotes) {
      const fileTag = n.file ? ` (${n.file})` : ''
      lines.push(`- ${n.severity}: ${n.msg}${fileTag}`)
    }
    lines.push('')
  }
  if (prev.acDiff) {
    lines.push('## AC 变化')
    if (prev.acDiff.added.length > 0) {
      lines.push('### 新增 AC')
      for (const ac of prev.acDiff.added) lines.push(`- ${ac.id}: ${ac.text}`)
    }
    if (prev.acDiff.removed.length > 0) {
      lines.push('### 删除 AC')
      for (const id of prev.acDiff.removed) lines.push(`- ${id}`)
    }
    if (prev.acDiff.changed.length > 0) {
      lines.push('### 改动 AC')
      for (const c of prev.acDiff.changed) {
        lines.push(`- ${c.id}:`)
        lines.push(`  - 旧: ${c.oldText}`)
        lines.push(`  - 新: ${c.newText}`)
      }
    }
    lines.push('')
  }
  if (prev.previousArtifactPath) {
    lines.push('## 上一轮产出')
    lines.push(`路径：${prev.previousArtifactPath}`)
    lines.push('')
  }
  if (prev.previousCommits && prev.previousCommits.length > 0) {
    lines.push('## 上一轮已 commit 的内容')
    for (const sha of prev.previousCommits) lines.push(`- ${sha}`)
    lines.push('')
  }
  // v3：让 round N+1 LLM 看到自己上轮已主动提示的 review 点（避免重复 flag 同样的事）
  if (prev.prevReviewHints && prev.prevReviewHints.length > 0) {
    lines.push('## 上轮你主动提示的 review 点')
    for (const h of prev.prevReviewHints) {
      lines.push(`- [${h.severity}] ${h.point} —— ${h.reason}`)
    }
    lines.push('')
  }
  // v3：上轮 assumption 已被用户接受（未触发 reject），本轮无需重复列出，除非定义改变
  if (prev.prevAssumptions && prev.prevAssumptions.length > 0) {
    lines.push('## 上轮已经做出的假设（用户已默认接受，本轮无需重复，除非定义改变）')
    for (const a of prev.prevAssumptions) {
      const userMay = a.userMayDisagreeIf ? `（除非：${a.userMayDisagreeIf}）` : ''
      lines.push(`- ${a.q} → ${a.a}${userMay}`)
    }
    lines.push('')
  }
  // PRD §7 step 6：plan_escalation rejected_plan 的字段级反馈（让 plan-decomposer 精准定位修订）
  if (prev.targetTaskId) {
    lines.push('## 人审定位（仅修订指定任务）')
    lines.push(`本轮人审反馈定位到 task **${prev.targetTaskId}** —— 修订仅集中在该 task 的字段（title / files / coverAC / doneWhen / hints），其它 task 保持完全一致（即使 reviewer 也提了别的 warn）。`)
    lines.push('')
  }
  if (prev.citedAiNotes && prev.citedAiNotes.length > 0) {
    lines.push('## 人审已确认是真问题的 AI notes（必须逐条解决）')
    for (const note of prev.citedAiNotes) lines.push(`- ${note}`)
    lines.push('')
    lines.push('未在此列出的 AI notes 视为 nitpick，可降级为 warn 不强制修订。')
    lines.push('')
  }
  lines.push('## 本轮要求')
  lines.push('针对以上反馈修订，**不要重写整个文档/代码**。保留已被认可的部分。')
  lines.push('在输出 JSON 的 evidence 中说明你针对反馈做了什么调整。')
  lines.push('')
  return lines.join('\n')
}

/**
 * 比对前后两轮的 acceptanceCriteria，返回 diff（v2 §3.1.7）。
 * 用于 spec round > 1 完成后判断是否级联失效 plan 节点。
 */
export function diffAcceptanceCriteria(
  prev: AcceptanceCriterion[] | undefined,
  curr: AcceptanceCriterion[] | undefined,
): AcDiff {
  const prevMap = new Map((prev ?? []).map((ac) => [ac.id, ac]))
  const currMap = new Map((curr ?? []).map((ac) => [ac.id, ac]))
  const added: AcceptanceCriterion[] = []
  const removed: string[] = []
  const changed: AcDiff['changed'] = []
  for (const [id, ac] of currMap) {
    if (!prevMap.has(id)) added.push(ac)
    else if (prevMap.get(id)!.text !== ac.text) {
      changed.push({ id, oldText: prevMap.get(id)!.text, newText: ac.text })
    }
  }
  for (const id of prevMap.keys()) {
    if (!currMap.has(id)) removed.push(id)
  }
  return { added, removed, changed }
}

/**
 * 确保 worktree 内 .gitignore 含 .qi-context/ 条目（v2 §3.1.5 / B1）。
 * 防 dev-loop `git add -A` 误带 .qi-context/ 内文件进 commit。
 */
export function ensureWorktreeGitignore(worktreePath: string): void {
  const gitignorePath = join(worktreePath, '.gitignore')
  let existing = ''
  try {
    existing = readFileSync(gitignorePath, 'utf8')
  } catch {
    // 不存在就当空
  }
  const lines = existing.split('\n').map((l) => l.trim())
  if (lines.includes('.qi-context/') || lines.includes('.qi-context')) return
  // 不修改既有 .gitignore 顺序，append
  const append = (existing.endsWith('\n') || existing === '' ? '' : '\n') + '.qi-context/\n'
  appendFileSync(gitignorePath, append, 'utf8')
}

// =============================================================================
// Skill 输出 JSON 解析
// =============================================================================

const SkillOutputSchema = z.object({
  summary: z.string().min(1).max(500),
  decision: z.enum(['pass', 'fail']).optional(),
  notes: z
    .array(
      z.object({
        severity: z.enum(['warn', 'error']),
        msg: z.string(),
        file: z.string().optional(),
        line: z.number().optional(),
      }),
    )
    .optional(),
  tasksDone: z.array(z.number().int().nonnegative()).optional(),
})

export type SkillOutput = z.infer<typeof SkillOutputSchema>

export class SkillOutputParseError extends Error {
  readonly stage: 'no_match' | 'json_parse' | 'schema'
  constructor(stage: 'no_match' | 'json_parse' | 'schema', message: string) {
    super(message)
    this.name = 'SkillOutputParseError'
    this.stage = stage
  }
}

/**
 * §7.1 第 4 条：从最后一条消息抽 JSON。
 * 优先级：
 *   (a) 最后一个 ```json``` fenced block
 *   (b) 最后一个平衡 `{...}` 段
 *   (c) 都失败 → SkillOutputParseError stage='no_match'
 * 之后做 JSON.parse + zod schema 校验。
 */
export function parseSkillOutput(text: string): SkillOutput {
  const candidate = extractLastJsonCandidate(text)
  if (!candidate) {
    throw new SkillOutputParseError(
      'no_match',
      'no fenced json block or balanced { ... } found in last message',
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new SkillOutputParseError('json_parse', `JSON.parse failed: ${msg}`)
  }

  const result = SkillOutputSchema.safeParse(parsed)
  if (!result.success) {
    throw new SkillOutputParseError(
      'schema',
      `schema validation failed: ${result.error.message}`,
    )
  }
  return result.data
}

function extractLastJsonCandidate(text: string): string | null {
  // (a) ```json ... ``` fenced
  const fencedRe = /```\s*json\s*([\s\S]*?)```/gi
  let lastFenced: string | null = null
  for (let m = fencedRe.exec(text); m; m = fencedRe.exec(text)) {
    lastFenced = m[1]!.trim()
  }
  if (lastFenced) return lastFenced

  // (b) balanced { ... } —— 从尾部往前找最后一个 '}'，然后向前匹配开头 '{'
  const lastClose = text.lastIndexOf('}')
  if (lastClose < 0) return null

  let depth = 0
  for (let i = lastClose; i >= 0; i--) {
    const ch = text[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      depth--
      if (depth === 0) {
        return text.slice(i, lastClose + 1).trim()
      }
    }
  }
  return null
}

// =============================================================================
// .qi-context 准备
// =============================================================================

export interface SkillContextInputs {
  /** 业务输入（spec / plan / reviewNotes 等），merge 进 inputs.json */
  [key: string]: unknown
}

export interface PrepareContextOptions {
  worktreePath: string
  requirementId: number
  branch: string
  baseBranch: string
  artifactPath: string
  /** roles/<role>.md 内容（已加载） */
  roleContent: string
  /** 业务输入对象，序列化后写入 .qi-context/inputs.json 的 inputs 段 */
  inputs: SkillContextInputs
  /** retry_counters，从 requirements 表读出来传入 */
  retryCounters?: Record<string, unknown>
  /** spec_sources 文件绝对路径数组（manual override），会软链到 .qi-context/standards/ */
  specSources?: string[]
  /** v2: skill 名（用于 manifest lookup），与 manifest 联动 */
  skill?: string
  /** v2: role 名（用于 manifest 查询子集） */
  role?: string
  /** v2: 上一轮反馈（多轮场景），写入 .qi-context/feedback.md 同时序列化进 inputs.previousRound */
  previousRound?: PreviousRoundData
  /** v2: 已加载的 manifest（避免重复加载）；undefined = 自动加载，null = 显式禁用（fallback） */
  manifest?: RoleManifest | null
  /** v2: 是否在 worktree 写 .gitignore（默认 true） */
  ensureGitignore?: boolean
}

/**
 * 在 worktree 下构造 .qi-context/：
 *   role.md         — role 提示词
 *   inputs.json     — { requirement_id, worktree_path, branch, base_branch,
 *                       artifact_path, retry_counters, inputs: {...业务输入}, previousRound? }
 *   standards/      — manifest 决定的子集 + specSources 手动追加（去重）
 *   feedback.md     — 多轮反馈自然语言版（仅当 previousRound 非空）
 *
 * 同时确保 worktree 内 .gitignore 含 .qi-context/（v2 §3.1.5）。
 *
 * 每次调用前会先清除旧 .qi-context/（不同节点不复用）。
 */
export function prepareSkillContext(opts: PrepareContextOptions): {
  contextDir: string
  inputsJsonPath: string
} {
  const ctxDir = join(opts.worktreePath, '.qi-context')
  if (existsSync(ctxDir)) {
    rmSync(ctxDir, { recursive: true, force: true })
  }
  mkdirSync(ctxDir, { recursive: true })

  // role.md
  writeFileSync(join(ctxDir, 'role.md'), opts.roleContent, 'utf8')

  // v2: 加载 manifest（如未传入），按 role 过滤 inputs 字段
  const manifest =
    opts.manifest === undefined && opts.skill
      ? loadRoleManifest(opts.skill)
      : (opts.manifest ?? null)
  const manifestEntry = manifest && opts.role ? manifest[opts.role] : undefined

  // 按 manifest 过滤 inputs 字段（manifestEntry.inputs 非空时只保留声明的字段）
  let filteredInputs: SkillContextInputs = opts.inputs
  if (manifestEntry && manifestEntry.inputs.length > 0) {
    const allowed = new Set(manifestEntry.inputs)
    filteredInputs = {}
    for (const [k, v] of Object.entries(opts.inputs)) {
      if (allowed.has(k)) filteredInputs[k] = v
    }
  }

  // inputs.json
  const inputsJson: Record<string, unknown> = {
    requirement_id: opts.requirementId,
    worktree_path: opts.worktreePath,
    branch: opts.branch,
    base_branch: opts.baseBranch,
    artifact_path: opts.artifactPath,
    retry_counters: opts.retryCounters ?? {},
    inputs: filteredInputs,
  }
  if (opts.previousRound) {
    inputsJson.previousRound = opts.previousRound
  }
  const inputsPath = join(ctxDir, 'inputs.json')
  writeFileSync(inputsPath, JSON.stringify(inputsJson, null, 2), 'utf8')

  // feedback.md（仅多轮）
  if (opts.previousRound) {
    writeFileSync(
      join(ctxDir, 'feedback.md'),
      renderFeedbackMarkdown(opts.previousRound),
      'utf8',
    )
  }

  // standards/ 软链：manifest 子集 + specSources 手动追加（去重）
  // manifest=null（加载失败 / QI_NO_MANIFEST=1）按 PRD §7 R12 fallback 到一股脑：
  // 全部 docs/standards/*.md 一并 symlink。
  const sources = new Set<string>()
  if (manifest && opts.role) {
    for (const p of resolveStandardsByManifest(manifest, opts.role)) sources.add(p)
  } else if (opts.role) {
    const standardsRoot = join(repoRoot(), 'docs', 'standards')
    if (existsSync(standardsRoot)) {
      for (const f of readdirSync(standardsRoot).filter((x) => x.endsWith('.md'))) {
        sources.add(join(standardsRoot, f))
      }
    }
  }
  if (opts.specSources) {
    for (const p of opts.specSources) sources.add(p)
  }
  if (sources.size > 0) {
    const standardsDir = join(ctxDir, 'standards')
    mkdirSync(standardsDir, { recursive: true })
    for (const src of sources) {
      if (!isAbsolute(src)) {
        throw new Error(
          `[skill-runner] standards entry must be absolute path: ${src}`,
        )
      }
      // 路径穿越保护：禁止指向系统敏感路径
      // macOS 的 /var/folders/... 是合法 tmp 目录（mktemp 默认），不能拒
      if (
        src.startsWith('/etc/') ||
        src.startsWith('/sys/') ||
        src.startsWith('/proc/') ||
        src === '/etc/passwd' ||
        src === '/etc/shadow'
      ) {
        throw new Error(
          `[skill-runner] standards entry rejected for safety: ${src}`,
        )
      }
      if (!existsSync(src)) {
        // 找不到规范文件不是致命错——可能是首次部署还没建
        continue
      }
      const linkName = src.split('/').pop()!
      const linkPath = join(standardsDir, linkName)
      try {
        symlinkSync(src, linkPath)
      } catch (err) {
        // 已存在 / 跨设备 etc. 写入失败时退化为 fs read+write
        const content = readFileSync(src, 'utf8')
        writeFileSync(linkPath, content, 'utf8')
      }
    }
  }

  // worktree gitignore：确保 .qi-context/ 不被 git add -A 误带
  if (opts.ensureGitignore !== false) {
    try {
      ensureWorktreeGitignore(opts.worktreePath)
    } catch (err) {
      console.warn(`[skill-runner] ensureWorktreeGitignore failed: ${err}`)
    }
  }

  return { contextDir: ctxDir, inputsJsonPath: inputsPath }
}

// =============================================================================
// 主 runSkill 入口（DI 友好）
// =============================================================================

/**
 * Skill 子 agent 执行器抽象。
 * 生产实现包装 ClaudeRunner.executeCapabilityDirect；测试用 fake 直接返回脚本化响应。
 */
export interface SkillExecutor {
  execute(opts: {
    prompt: string
    systemPrompt: string
    cwd: string
    env: Record<string, string>
    /** 启 mcp-server-quick-impl 子进程的脚本路径 */
    mcpServerPath: string
    maxTurns?: number
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<SkillExecutorResult>
}

export interface SkillExecutorResult {
  /** 整段 stdout / assistant 文本，最后一条消息含 JSON block */
  rawOutput: string
  /** 从 porygon AgentResultMessage 拿到的 token 计数（Day 0 验证 #2） */
  inputTokens?: number
  outputTokens?: number
  durationMs?: number
  /** 任何错误信息（超时 / kill 等） */
  errorMessage?: string | null
}

export interface RunSkillOptions {
  requirementId: number
  nodeId: string
  /** Skill ID, e.g. 'quick-impl-artifact-author' */
  skill: string
  /** Role ID, e.g. 'spec-author' */
  role: string
  worktreePath: string
  branch: string
  baseBranch: string
  artifactPath: string
  inputs: SkillContextInputs
  retryCounters?: Record<string, unknown>
  specSources?: string[]
  /** v2: 上一轮反馈，写入 inputs.previousRound + .qi-context/feedback.md */
  previousRound?: PreviousRoundData
  maxTurns?: number
  timeoutMs?: number
  signal?: AbortSignal
  /** 子 agent 跑时注入的额外 env（除了 QI_REQUIREMENT_ID） */
  extraEnv?: Record<string, string>
  /**
   * 跳过 SkillOutputSchema 校验。某些 role（如 brainstorm-host）输出 schema
   * 与通用 SkillOutputSchema 不兼容（decision 字段语义不同），需要 caller
   * 自己解析 rawOutput。这种情况下 RunSkillResult.output 是空对象占位。
   */
  skipOutputParse?: boolean
}

export interface RunSkillResult {
  output: SkillOutput
  rawOutput: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  /** parse 失败时附带原始消息（供日志落盘） */
  parseError?: SkillOutputParseError
}

/**
 * 执行一次 skill。可能抛出：
 *   - SkillNotFoundError    skill / role 找不到
 *   - SkillOutputParseError 子 agent 输出末尾 JSON 解析失败 / schema 不通过
 *   - 普通 Error            ClaudeRunner 启动 / 超时 / kill 等
 */
export async function runSkill(
  opts: RunSkillOptions,
  executor: SkillExecutor,
  mcpServerPath: string = defaultMcpServerPath(),
): Promise<RunSkillResult> {
  // 1. 加载 skill + role
  const skillContent = loadSkill(opts.skill)
  const roleContent = loadRole(opts.skill, opts.role)

  // 2. 准备 .qi-context（v2: 自动按 manifest symlink standards 子集 + 写 feedback.md + gitignore）
  prepareSkillContext({
    worktreePath: opts.worktreePath,
    requirementId: opts.requirementId,
    branch: opts.branch,
    baseBranch: opts.baseBranch,
    artifactPath: opts.artifactPath,
    roleContent,
    inputs: opts.inputs,
    retryCounters: opts.retryCounters,
    specSources: opts.specSources,
    skill: opts.skill,
    role: opts.role,
    previousRound: opts.previousRound,
  })

  // brainstorm artifacts（forward-compatible：brainstorm 节点未产出时静默跳过）
  await linkBrainstormArtifacts({ worktreePath: opts.worktreePath, requirementId: opts.requirementId })

  // 3. 系统提示词 = SKILL 底座契约 + role 引用
  const systemPrompt = [
    skillContent,
    '',
    '---',
    '',
    `# 当前 Role: ${opts.role}`,
    '',
    '完整 role 提示词见 `.qi-context/role.md`。请先读取该文件，理解 role 职责，然后按照底座契约执行。',
    '',
    '输入参数见 `.qi-context/inputs.json`。',
  ].join('\n')

  const prompt =
    `执行 quick-impl 节点：${opts.nodeId}（role=${opts.role}，requirement=#${opts.requirementId}）。\n` +
    `读 .qi-context/role.md 和 .qi-context/inputs.json，按底座契约执行任务。完成后用 ` +
    '```json``` block 返回结构化输出。'

  // 4. 启 ClaudeRunner（注入 QI_REQUIREMENT_ID env，commit_artifact handler 用它做沙盒校验）
  // extraEnv 在前，QI_ 变量在后——防止调用方通过 extraEnv 覆盖 sandbox 变量
  const env: Record<string, string> = {
    ...(opts.extraEnv ?? {}),
    QI_REQUIREMENT_ID: String(opts.requirementId),
    QI_NODE_ID: opts.nodeId,
  }

  // 写 lockfile：cleanup hook 通过 pid + nodeId 判断是否可清 worktree
  acquireLock(opts.worktreePath, process.pid, opts.nodeId)
  const startedAt = Date.now()
  let execResult: Awaited<ReturnType<SkillExecutor['execute']>>
  try {
    execResult = await executor.execute({
      prompt,
      systemPrompt,
      cwd: opts.worktreePath,
      env,
      mcpServerPath,
      maxTurns: opts.maxTurns,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    })
  } finally {
    releaseLock(opts.worktreePath)
  }
  const durationMs = execResult.durationMs ?? Date.now() - startedAt

  if (execResult.errorMessage) {
    throw new Error(`[skill-runner] executor error: ${execResult.errorMessage}`)
  }

  // 5. 解析 JSON（可跳过：见 RunSkillOptions.skipOutputParse）
  let output: SkillOutput
  if (opts.skipOutputParse) {
    output = {} as SkillOutput  // 占位，caller 用 rawOutput 自己解析
  } else {
    try {
      output = parseSkillOutput(execResult.rawOutput)
    } catch (err) {
      if (err instanceof SkillOutputParseError) {
        err.message =
          `[skill-runner] ${err.message}\n` +
          `--- raw output (last 500 chars) ---\n` +
          execResult.rawOutput.slice(-500)
      }
      throw err
    }
  }

  return {
    output,
    rawOutput: execResult.rawOutput,
    durationMs,
    inputTokens: execResult.inputTokens ?? 0,
    outputTokens: execResult.outputTokens ?? 0,
  }
}

/**
 * 默认 MCP server 路径：src/quick-impl/mcp-server.ts（编译后 dist/quick-impl/mcp-server.js）。
 * 实际 register 的是专用 commit_artifact server（PRD §8.4.1）。
 */
export function defaultMcpServerPath(): string {
  return join(__dirname, 'mcp-server.js')
}
