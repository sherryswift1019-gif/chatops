/**
 * Quick-Impl Role 输出 zod schema（v2 §3.1.1 SKILL.md 共性 + §3.2 各 role 扩展）。
 *
 * 用途：evaluation harness（scripts/qi-eval.ts）+ Phase 5 regression CI 调用做强校验。
 * 现有 graph-builder / skill-runner 仍用宽松的 SkillOutputSchema 解析（v1 兼容），
 * 这里的 strict schema 仅在评测时跑，不影响生产路径。
 */
import { z } from 'zod'

// =============================================================================
// 共性字段（SKILL.md 强制）
// =============================================================================

const NoteSchema = z.object({
  severity: z.enum(['warn', 'error']),
  msg: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
})

const SelfCheckItemSchema = z.object({
  item: z.string(),
  passed: z.boolean(),
  reason: z.string().optional(),
})

const EvidenceSchema = z.object({
  standardsConsulted: z.array(z.string()).default([]),
  selfCheck: z.array(SelfCheckItemSchema).default([]),
})

const BaseOutputSchema = z.object({
  summary: z.string().min(1).max(500),
  decision: z.enum(['pass', 'fail']),
  notes: z.array(NoteSchema).default([]),
  evidence: EvidenceSchema,
})

// =============================================================================
// spec-author
// =============================================================================

export const AcceptanceCriterionSchema = z.object({
  id: z.string().regex(/^AC-\d+$/, 'AC id must match /^AC-\\d+$/'),
  format: z.enum(['given-when-then', 'free-text']).optional().default('given-when-then'),
  text: z.string().min(1),
})

export const RiskSchema = z.object({
  desc: z.string().min(1),
  severity: z.enum(['high', 'medium', 'low']),
})

export const ReferenceSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
  purpose: z.string().min(1),
})

export const ClarificationSchema = z.object({
  q: z.string().min(1),
  a: z.string().min(1), // 可以是 "OPEN_QUESTION" 字面量
  // v3: kind 区分"事实查询"(LLM 从 codebase 读到的) 与"假设"(LLM 替用户做的默认决定)
  kind: z.enum(['fact', 'assumption']).optional(),
  // v3: 仅 kind='assumption' 时填，描述用户在何种情况下会否决该假设
  userMayDisagreeIf: z.string().optional(),
})

// v3: reviewHints — LLM 主动标记的"审批人最该 review 的点"
// 不限数量；写不出来就空数组（**不要凑数**）
export const ReviewHintSchema = z.object({
  severity: z.enum(['high', 'medium', 'low']),
  point: z.string().min(1),
  reason: z.string().min(1),
})

export type ReviewHint = z.infer<typeof ReviewHintSchema>

// v3: noGos — 明确不实现的边界（plan-decomposer 用 specNoGos 消费）
export const NoGoSchema = z.object({
  desc: z.string().min(1),
  reason: z.string().optional(),
})

export type NoGo = z.infer<typeof NoGoSchema>

// v3: selfCheck 兼容 union（旧 mechanical {item, passed, reason?} / 新主观 {item, answer}）
const SpecSelfCheckItemSchema = z.union([
  z.object({ item: z.string().min(1), passed: z.boolean(), reason: z.string().optional() }),
  z.object({ item: z.string().min(1), answer: z.string().min(1) }),
])

// v3: standardsConsulted 兼容 union（旧 string / 新 {file, usedFor}）
const SpecStandardsConsultedItemSchema = z.union([
  z.string().min(1),
  z.object({ file: z.string().min(1), usedFor: z.string().min(1) }),
])

const SpecEvidenceSchemaV3 = z.object({
  standardsConsulted: z.array(SpecStandardsConsultedItemSchema).default([]),
  selfCheck: z.array(SpecSelfCheckItemSchema).default([]),
})

// QI 自有 E2E scenario 内联到 spec_author 输出。dev-loop 序列化成 docs/test-playbooks/qi-{id}.yaml
// 给 qi_e2e_runner 节点跑。schema 强制硬规则；软规则（步骤具体性 / acceptance 可观测）走
// reviewer + 自检兜底。详见 docs/prds/prd-quick-impl-e2e-phase2.md "E2E Scenario 合规标准"。
export const E2eScenarioInlineSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]+$/, 'scenario id must be kebab-case (lowercase letters, digits, hyphens; starts with letter)'),
  name: z.string().min(1),
  kind: z.enum(['happy', 'negative']),
  coversAC: z
    .array(z.string().regex(/^AC-\d+$/, 'coversAC entries must match /^AC-\\d+$/'))
    .min(1, 'scenario must reference ≥1 AC'),
  tags: z.array(z.string()).default([]),
  steps: z.array(z.string().min(1)).min(1, 'scenario has no steps'),
  acceptance: z.array(z.string().min(1)).min(1, 'scenario has no acceptance assertion'),
})

export type E2eScenarioInline = z.infer<typeof E2eScenarioInlineSchema>

export const SpecAuthorOutputSchema = BaseOutputSchema.extend({
  // v3: schemaVersion 标记本输出走 v3 strict superRefine（缺省视为 v2 兼容模式）
  schemaVersion: z.literal('v2').optional(),
  // v3: LLM 自评本次撰写的置信度
  confidenceLevel: z.enum(['high', 'medium', 'low']).optional(),
  // v3: 给审批人的"需要 review 的点"，不限数量；不强制 ≥1（避免 LLM 凑数）
  reviewHints: z.array(ReviewHintSchema).default([]),
  // v3: 明确不实现的边界（plan-decomposer 透传到 specNoGos 消费）
  noGos: z.array(NoGoSchema).default([]),
  // v3: evidence 升级为 union 类型（兼容老 string[] / 老 {item, passed, reason?}）
  evidence: SpecEvidenceSchemaV3,
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1, 'spec must have ≥1 acceptanceCriteria'),
  openQuestions: z.array(z.string()).default([]),
  risks: z.array(RiskSchema).min(1, 'risks section must be non-empty (at least 1 risk or OPEN_QUESTION)'),
  references: z.array(ReferenceSchema).min(1, 'must reference codebase ≥1 time (file:line)'),
  clarifications: z.array(ClarificationSchema).default([]),
  // optional 而非 .min(1) — 让 v8 in-flight QI run（spec_author prompt 还没升级）不炸
  // v9 graph 的 qi_e2e_runner 节点入口处运行时再校验非空 + 完整合规
  e2eScenarios: z.array(E2eScenarioInlineSchema).optional(),
}).superRefine((val, ctx) => {
  // ===== e2eScenarios 合规校验（v2/v3 共用，存在时跑）=====
  if (val.e2eScenarios) {
    // 1. 数量上限
    if (val.e2eScenarios.length > 5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `max 5 e2e scenarios per requirement (防 LLM 凑数), got ${val.e2eScenarios.length}`,
        path: ['e2eScenarios'],
      })
    }

    // 2. scenario.id 全数组唯一
    const ids = new Set<string>()
    for (let i = 0; i < val.e2eScenarios.length; i++) {
      const s = val.e2eScenarios[i]
      if (ids.has(s.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate scenario id: ${s.id}`,
          path: ['e2eScenarios', i, 'id'],
        })
      }
      ids.add(s.id)
    }

    // 3. coversAC 所有引用必须在 acceptanceCriteria 中存在
    const acIds = new Set(val.acceptanceCriteria.map((c) => c.id))
    for (let i = 0; i < val.e2eScenarios.length; i++) {
      const s = val.e2eScenarios[i]
      for (const ac of s.coversAC) {
        if (!acIds.has(ac)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `scenario ${s.id} references unknown AC ${ac}`,
            path: ['e2eScenarios', i, 'coversAC'],
          })
        }
      }
    }

    // 4. 每个 AC 都被至少 1 个 scenario.coversAC 覆盖
    const coveredAcs = new Set(val.e2eScenarios.flatMap((s) => s.coversAC))
    for (const ac of val.acceptanceCriteria) {
      if (!coveredAcs.has(ac.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${ac.id} not covered by any scenario`,
          path: ['e2eScenarios'],
        })
      }
    }

    // 5. 至少 1 个 negative scenario
    const hasNegative = val.e2eScenarios.some((s) => s.kind === 'negative')
    if (!hasNegative) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must include ≥1 negative scenario (error/permission/boundary)',
        path: ['e2eScenarios'],
      })
    }
  }

  // ===== v3 严格约束（仅 schemaVersion='v2' 触发；v2 in-flight 数据缺字段时跳过）=====
  if (val.schemaVersion === 'v2') {
    // V3-1: selfCheck 瘦身 ≤ 3 条（mechanical 项移到 qi-spec-lint.ts）
    if (val.evidence.selfCheck.length > 3) {
      ctx.addIssue({
        code: 'custom',
        message: `v3: selfCheck must have ≤3 items (got ${val.evidence.selfCheck.length}); move mechanical checks to qi-spec-lint.ts`,
        path: ['evidence', 'selfCheck'],
      })
    }

    // V3-2: 强制 self-critique — selfCheck.item 中必有 1 条命中"最弱/最不确定/weakest/uncertain"
    const hasCritique = val.evidence.selfCheck.some((sc) => {
      const text = typeof sc === 'object' && sc !== null && 'item' in sc ? String((sc as { item: unknown }).item) : ''
      return /最弱|最不确定|weakest|uncertain/i.test(text)
    })
    if (!hasCritique) {
      ctx.addIssue({
        code: 'custom',
        message: 'v3: selfCheck must include a self-critique item (e.g. "本 spec 最弱点?" / "最不确定的是?")',
        path: ['evidence', 'selfCheck'],
      })
    }

    // V3-3: clarifications 至少 1 条 kind='assumption'（防 LLM 全标 fact 凑数）
    if (!val.clarifications.some((c) => c.kind === 'assumption')) {
      ctx.addIssue({
        code: 'custom',
        message: 'v3: clarifications must include ≥1 entry with kind="assumption" (LLM 替用户做的默认决定)',
        path: ['clarifications'],
      })
    }
  }
})

export type SpecAuthorOutput = z.infer<typeof SpecAuthorOutputSchema>

// =============================================================================
// plan-decomposer
// =============================================================================

export const PlanTaskSchema = z.object({
  id: z.string().regex(/^T\d+$/, 'task id must match /^T\\d+$/'),
  type: z.enum(['feature', 'test', 'migration', 'doc']),
  title: z.string().min(1),
  files: z.array(z.string()).min(1),
  coverAC: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  estimatedLoc: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
})

export const MigrationSchema = z.object({
  file: z.string().regex(/schema-v\d+\.sql$/, 'migration file must end with schema-vN.sql'),
  table: z.string().optional(),
  addColumns: z.array(z.string()).optional(),
  rollbackPlan: z.string().min(1),
})

export const PlanDecomposerOutputSchema = BaseOutputSchema.extend({
  tasks: z.array(PlanTaskSchema).min(1),
  migrations: z.array(MigrationSchema).default([]),
}).superRefine((val, ctx) => {
  // 校验：每个 feature 任务必须有 ≥1 个 test 任务依赖它
  const featureIds = val.tasks.filter((t) => t.type === 'feature').map((t) => t.id)
  const testTasks = val.tasks.filter((t) => t.type === 'test')
  for (const fid of featureIds) {
    const hasTest = testTasks.some((t) => t.dependsOn.includes(fid))
    if (!hasTest) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `feature task ${fid} has no corresponding test task in dependsOn`,
        path: ['tasks'],
      })
    }
  }
  // 校验：dependsOn DAG 无环（topo sort）
  const idSet = new Set(val.tasks.map((t) => t.id))
  for (const t of val.tasks) {
    for (const dep of t.dependsOn) {
      if (!idSet.has(dep)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `task ${t.id} depends on unknown task ${dep}`,
          path: ['tasks'],
        })
      }
    }
  }
  // 简单环检测（DFS）
  const adj = new Map<string, string[]>(val.tasks.map((t) => [t.id, t.dependsOn]))
  const visited = new Set<string>()
  const stack = new Set<string>()
  const dfs = (id: string): boolean => {
    if (stack.has(id)) return true
    if (visited.has(id)) return false
    visited.add(id)
    stack.add(id)
    for (const d of adj.get(id) ?? []) if (dfs(d)) return true
    stack.delete(id)
    return false
  }
  for (const t of val.tasks) {
    if (dfs(t.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cycle detected involving ${t.id}`, path: ['tasks'] })
      break
    }
  }
})

export type PlanDecomposerOutput = z.infer<typeof PlanDecomposerOutputSchema>

// =============================================================================
// plan-decomposer v3（qi-eval strict schema — production path unaffected）
// Adds: schemaVersion, rejectReasons, confidenceLevel, decisions[],
//       tasks[].doneWhen / implementationHints / testHints / exposesContract
//       task.type enum += refactor | chore
// =============================================================================

const PlanSelfCheckItemSchema = z.union([
  z.object({ item: z.string().min(1), answer: z.string().min(1) }),
  z.object({ item: z.string().min(1), passed: z.boolean(), reason: z.string().optional() }),
])

const PlanStandardsItemSchema = z.union([
  z.object({ file: z.string().min(1), usedFor: z.string().min(1) }),
  z.string().min(1),
])

const PlanEvidenceSchemaV3 = z.object({
  standardsConsulted: z.array(PlanStandardsItemSchema).default([]),
  selfCheck: z.array(PlanSelfCheckItemSchema).default([]),
})

const PlanDecisionSchema = z.object({
  choice: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
  rejectedReason: z.string().min(1),
})

export const PlanTaskSchemaV3 = z.object({
  id: z.string().regex(/^T\d+$/, 'task id must match /^T\\d+$/'),
  type: z.enum(['feature', 'test', 'migration', 'refactor', 'chore']),
  title: z.string().min(1),
  files: z.array(z.string()).min(1),
  coverAC: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  estimatedLoc: z.number().int().nonnegative().optional(),
  doneWhen: z.array(z.string().min(1)).optional(),
  implementationHints: z.object({
    reuseFrom: z.array(z.object({
      file: z.string().min(1),
      line: z.number().int().nonnegative().optional(),
      why: z.string().min(1),
    })).optional(),
    insertAt: z.object({ file: z.string().min(1), afterLine: z.number().int().nonnegative() }).optional(),
    watchOut: z.array(z.string().min(1)).optional(),
  }).nullable().optional(),
  testHints: z.object({
    framework: z.string().optional(),
    casesTitles: z.array(z.string().min(1)).optional(),
  }).nullable().optional(),
  exposesContract: z.unknown().nullable().optional(),
})

export type PlanTaskV3 = z.infer<typeof PlanTaskSchemaV3>

export const PlanDecomposerOutputSchemaV3 = BaseOutputSchema.extend({
  decision: z.enum(['pass', 'fail', 'reject_input']),
  evidence: PlanEvidenceSchemaV3,
  schemaVersion: z.string().optional(),
  confidenceLevel: z.enum(['high', 'medium', 'low']).optional(),
  rejectReasons: z.array(z.string()).default([]),
  decisions: z.array(PlanDecisionSchema).default([]),
  tasks: z.array(PlanTaskSchemaV3).default([]),
  migrations: z.array(MigrationSchema).default([]),
}).superRefine((val, ctx) => {
  if (val.decision === 'reject_input') {
    if (val.tasks.length > 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reject_input: tasks[] must be empty', path: ['tasks'] })
    if (val.rejectReasons.length === 0)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reject_input must have ≥1 rejectReason', path: ['rejectReasons'] })
    return
  }

  if (val.tasks.length === 0)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'pass/fail must have ≥1 task', path: ['tasks'] })

  // selfCheck must include a self-critique item ("本 plan 最弱点" / "最不确定")
  const hasCritique = val.evidence.selfCheck.some((sc) => {
    const text = typeof sc === 'object' && sc !== null && 'item' in sc ? String((sc as { item: unknown }).item) : ''
    return /最弱|最不确定|weakest|uncertain/i.test(text)
  })
  if (!hasCritique)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'selfCheck must include a self-critique item (e.g. "本 plan 最弱点?")', path: ['evidence', 'selfCheck'] })

  // feature → test pairing (except <10 LOC glue)
  const testTasks = val.tasks.filter((t) => t.type === 'test')
  for (const ft of val.tasks.filter((t) => t.type === 'feature')) {
    if (!testTasks.some((t) => t.dependsOn.includes(ft.id)) && (ft.estimatedLoc ?? Infinity) >= 10)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `feature task ${ft.id} (estimatedLoc=${ft.estimatedLoc}) has no test task in dependsOn`, path: ['tasks'] })
  }

  // dependsOn references valid task IDs
  const idSet = new Set(val.tasks.map((t) => t.id))
  for (const t of val.tasks)
    for (const dep of t.dependsOn)
      if (!idSet.has(dep))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `task ${t.id} depends on unknown task ${dep}`, path: ['tasks'] })

  // DAG cycle detection (DFS)
  const adj = new Map<string, string[]>(val.tasks.map((t) => [t.id, t.dependsOn]))
  const visited = new Set<string>()
  const stack = new Set<string>()
  const dfs = (id: string): boolean => {
    if (stack.has(id)) return true
    if (visited.has(id)) return false
    visited.add(id); stack.add(id)
    for (const d of adj.get(id) ?? []) if (dfs(d)) return true
    stack.delete(id); return false
  }
  for (const t of val.tasks)
    if (dfs(t.id)) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `cycle detected involving ${t.id}`, path: ['tasks'] }); break }
})

export type PlanDecomposerOutputV3 = z.infer<typeof PlanDecomposerOutputSchemaV3>

// =============================================================================
// dev-loop
// =============================================================================

export const VitestResultSchema = z.object({
  command: z.string().min(1),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
})

export const CommitEntrySchema = z.object({
  taskId: z.string().regex(/^T\d+$/),
  sha: z.string().regex(/^[0-9a-f]{4,40}$/, 'sha must be hex'),
  message: z.string().regex(/^(feat|fix)\(qi-\d+\): T\d+/, 'commit message must match feat/fix(qi-X): T{n}'),
  filesChanged: z.array(z.string()).min(1),
  tsc: z.enum(['pass', 'fail']),
  vitest: VitestResultSchema.optional(),
  round: z.number().int().positive().optional(),
  isFix: z.boolean().optional(),
})

export const SkippedTaskSchema = z.object({
  taskId: z.string().regex(/^T\d+$/),
  reason: z.string().min(1),
})

export const FailedTaskSchema = z.object({
  taskId: z.string().regex(/^T\d+$/),
  reason: z.string().min(1),
  step: z.enum(['edit', 'tsc', 'vitest', 'commit']).optional(),
})

export const DevLoopOutputSchema = BaseOutputSchema.extend({
  commits: z.array(CommitEntrySchema).default([]),
  skippedTasks: z.array(SkippedTaskSchema).default([]),
  failedTasks: z.array(FailedTaskSchema).default([]),
})

export type DevLoopOutput = z.infer<typeof DevLoopOutputSchema>

// =============================================================================
// code-quality-reviewer
// =============================================================================

export const SpecCoverageEntrySchema = z.discriminatedUnion('covered', [
  z.object({
    ac: z.string().regex(/^AC-\d+$/),
    covered: z.literal(true),
    evidence: z.array(z.object({
      file: z.string(),
      line: z.number().int().nonnegative().optional(),
    })).min(1, 'covered AC must have ≥1 evidence file:line'),
  }),
  z.object({
    ac: z.string().regex(/^AC-\d+$/),
    covered: z.literal(false),
    missingReason: z.string().min(1),
  }),
])

export const ScopeViolationSchema = z.object({
  file: z.string().min(1),
  reason: z.string().min(1),
})

export const FileRiskSchema = z.object({
  file: z.string().min(1),
  role: z.string().min(1),
  impact: z.string().min(1),
  risk: z.enum(['low', 'medium', 'high']),
  focusOn: z.string().min(1),
})

export const ReviewerOutputSchema = BaseOutputSchema.extend({
  specCoverage: z.array(SpecCoverageEntrySchema).default([]),
  scopeViolations: z.array(ScopeViolationSchema).default([]),
  fileRisks: z.array(FileRiskSchema).default([]),
}).superRefine((val, ctx) => {
  // high/medium 风险必须有非泛泛的 focusOn
  for (const r of val.fileRisks) {
    if ((r.risk === 'high' || r.risk === 'medium') && r.focusOn.length < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${r.risk} risk on ${r.file} has too-vague focusOn ("${r.focusOn}")`,
        path: ['fileRisks'],
      })
    }
  }
})

export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>

// =============================================================================
// plan-reviewer
// =============================================================================

export const PlanQualityIssueSchema = z.object({
  checkId: z.enum(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']),
  severity: z.enum(['error', 'warn']),
  message: z.string().min(1),
  taskId: z.string().regex(/^T\d+$/).optional(),
})

export const PlanReviewerOutputSchema = BaseOutputSchema.extend({
  planQualityIssues: z.array(PlanQualityIssueSchema).default([]),
  specCoverage: z.array(SpecCoverageEntrySchema).default([]),
}).superRefine((val, ctx) => {
  const errCount = val.planQualityIssues.filter((i) => i.severity === 'error').length
  if (errCount >= 2 && val.decision !== 'fail') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${errCount} error issues but decision is not fail`,
      path: ['decision'],
    })
  }
})

export type PlanReviewerOutput = z.infer<typeof PlanReviewerOutputSchema>

// =============================================================================
// 通用入口
// =============================================================================

export type RoleName =
  | 'spec-author'
  | 'plan-decomposer'
  | 'dev-loop'
  | 'code-quality-reviewer'
  | 'plan-reviewer'

const SCHEMAS = {
  'spec-author': SpecAuthorOutputSchema,
  'plan-decomposer': PlanDecomposerOutputSchemaV3,
  'dev-loop': DevLoopOutputSchema,
  'code-quality-reviewer': ReviewerOutputSchema,
  'plan-reviewer': PlanReviewerOutputSchema,
} as const

/**
 * 校验某 role 的输出 JSON 是否符合 v2 schema。
 * 失败时返回 { ok: false, errors: [...] }，不抛异常（evaluation harness 友好）。
 */
export function validateRoleOutput(
  role: RoleName,
  output: unknown,
): { ok: true; data: unknown } | { ok: false; errors: string[] } {
  const schema = SCHEMAS[role]
  if (!schema) return { ok: false, errors: [`unknown role: ${role}`] }
  const result = schema.safeParse(output)
  if (result.success) return { ok: true, data: result.data }
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  }
}
