/**
 * PRD Agent V2.0 — 机械校验实现。
 *
 * 对应迭代文档 docs/prds/prd-agent-v2-iteration.md §6。
 *
 * 设计原则：
 *   - 纯函数，无 LLM 调用，毫秒级返回
 *   - 每条校验对应 rules.ts 里的一条规则（ruleId 对齐）
 *   - 错误项聚合后由 save_prd 一次性返回给 Agent；Agent 根据 ruleId 反查
 *     rules.ts 的 generatorInstruction 自行修正再 retry
 *
 * 架构选择：
 *   本文件维护自己的 CHECK_REGISTRY，不去 mutate rules.ts 的 PRD_RULES（避免
 *   模块加载顺序导致的测试不稳定）。PrdRule.mechanicalCheck 字段在 V2.0 MVP
 *   中保持未填充，作为未来按规则挂载自定义 check 的扩展点。
 */

import { PRD_RULES } from './rules.js'
import type {
  MechanicalError,
  PrdImpactCompatibility,
  PrdImpactType,
  StructuredPrd,
} from './structured-types.js'

// =============================================================================
// 常量（与 structured-types.ts 的字面量联合保持同步）
// =============================================================================

const ALLOWED_IMPACT_TYPES: PrdImpactType[] = [
  '行为变更',
  '接口变更',
  '数据结构变更',
  'UI 变更',
  '行为复用',
  '性能影响',
  '无直接影响',
]

const ALLOWED_COMPATIBILITY: PrdImpactCompatibility[] = [
  '完全兼容',
  '向后兼容',
  '破坏性变更',
]

const ALLOWED_SOURCE_TYPES = ['user_said', 'agent_inferred', 'codebase_fact'] as const

/**
 * 软性语言黑名单。命中任一即触发 no_soft_language warning。
 * 只收录高置信度的整块短语，避免"流畅""好用"这类单字词误伤。
 */
const SOFT_LANGUAGE_PATTERNS: RegExp[] = [
  /为了提升用户体验/,
  /打造完美/,
  /业界领先/,
  /用户体验良好/,
  /提升体验/,
  /打造极致/,
  /一流的产品/,
]

// =============================================================================
// 公共工具
// =============================================================================

function isBlank(s: string | undefined | null): boolean {
  return !s || s.trim().length === 0
}

function err(ruleId: string, field: string, message: string): MechanicalError {
  return { ruleId, field, message }
}

// =============================================================================
// 单条规则的校验函数
// =============================================================================

export function validateChapterComplete(prd: StructuredPrd): MechanicalError[] {
  const errors: MechanicalError[] = []
  if (isBlank(prd.meta?.title)) {
    errors.push(err('chapter_complete', 'meta.title', 'PRD 标题不能为空'))
  }
  if (isBlank(prd.goals?.vision)) {
    errors.push(err('chapter_complete', 'goals.vision', '第 1 章愿景不能为空'))
  }
  if (isBlank(prd.goals?.oneLineStatement)) {
    errors.push(
      err('chapter_complete', 'goals.oneLineStatement', '第 1 章一句话定位不能为空')
    )
  }
  if (!prd.goals?.objectives || prd.goals.objectives.length === 0) {
    errors.push(
      err('chapter_complete', 'goals.objectives', '第 1 章项目目标至少需要 1 条')
    )
  }
  if (isBlank(prd.users?.primarySegment)) {
    errors.push(err('chapter_complete', 'users.primarySegment', '第 2 章主要用户群不能为空'))
  }
  if (!prd.functionalRequirements || prd.functionalRequirements.length === 0) {
    errors.push(
      err('chapter_complete', 'functionalRequirements', '第 3 章功能需求至少需要 1 条')
    )
  }
  if (!prd.impacts || prd.impacts.length === 0) {
    errors.push(
      err(
        'chapter_complete',
        'impacts',
        '第 6 章受影响清单不能为空；即便无影响也需至少 1 条"无直接影响"条目'
      )
    )
  }
  if (!prd.scope?.inScope || prd.scope.inScope.length === 0) {
    errors.push(err('chapter_complete', 'scope.inScope', '第 7 章「在范围内」至少需要 1 条'))
  }
  return errors
}

export function validateSourceTraceable(prd: StructuredPrd): MechanicalError[] {
  const errors: MechanicalError[] = []
  for (const req of prd.functionalRequirements ?? []) {
    const base = `functionalRequirements[${req.id}].source`
    if (!req.source) {
      errors.push(err('source_traceable', base, `功能需求 ${req.id} 缺少 source 字段`))
      continue
    }
    if (!Number.isFinite(req.source.phase) || req.source.phase <= 0) {
      errors.push(
        err('source_traceable', `${base}.phase`, `功能需求 ${req.id} 的 source.phase 必须为正整数`)
      )
    }
    if (isBlank(req.source.quote)) {
      errors.push(
        err('source_traceable', `${base}.quote`, `功能需求 ${req.id} 的 source.quote 不能为空`)
      )
    }
    if (!ALLOWED_SOURCE_TYPES.includes(req.source.type)) {
      errors.push(
        err(
          'source_traceable',
          `${base}.type`,
          `功能需求 ${req.id} 的 source.type="${req.source.type}" 不在允许枚举 ${ALLOWED_SOURCE_TYPES.join(' / ')}`
        )
      )
    }
  }
  for (let i = 0; i < (prd.impacts ?? []).length; i++) {
    const imp = prd.impacts[i]
    if (isBlank(imp.source)) {
      errors.push(
        err(
          'source_traceable',
          `impacts[${i}].source`,
          `第 6 章受影响条目「${imp.module}」缺少 source，不允许笼统表述`
        )
      )
    }
  }
  return errors
}

/** 验收标准是否含可测要素：至少一个数字或比较/赋值运算符 */
function hasMeasurableToken(text: string): boolean {
  return /[\d=<>≥≤]/.test(text)
}

export function validateMeasurableAcceptance(prd: StructuredPrd): MechanicalError[] {
  const errors: MechanicalError[] = []
  for (const req of prd.functionalRequirements ?? []) {
    const criteria = req.acceptanceCriteria ?? []
    for (let i = 0; i < criteria.length; i++) {
      const c = criteria[i]
      if (isBlank(c.text)) {
        errors.push(
          err(
            'measurable_acceptance',
            `functionalRequirements[${req.id}].acceptanceCriteria[${i}]`,
            `验收标准不能为空`
          )
        )
        continue
      }
      if (!hasMeasurableToken(c.text)) {
        errors.push(
          err(
            'measurable_acceptance',
            `functionalRequirements[${req.id}].acceptanceCriteria[${i}]`,
            `验收标准必须含数字或可测口径（>/</≥/≤/=），当前："${c.text}"`
          )
        )
      }
    }
  }
  for (let i = 0; i < (prd.goals?.successMetrics ?? []).length; i++) {
    const m = prd.goals.successMetrics[i]
    if (!hasMeasurableToken(m.target)) {
      errors.push(
        err(
          'measurable_acceptance',
          `goals.successMetrics[${i}].target`,
          `成功指标目标值必须含数字或可测口径，当前："${m.target}"`
        )
      )
    }
  }
  return errors
}

export function validateNoSoftLanguage(prd: StructuredPrd): MechanicalError[] {
  const errors: MechanicalError[] = []
  const scan = (field: string, text: string | undefined): void => {
    if (!text) return
    for (const pat of SOFT_LANGUAGE_PATTERNS) {
      const m = text.match(pat)
      if (m) {
        errors.push(
          err('no_soft_language', field, `存在无信息量修饰语 "${m[0]}"`)
        )
      }
    }
  }
  scan('goals.vision', prd.goals?.vision)
  scan('users.narrative', prd.users?.narrative)
  scan('narrative', prd.narrative)
  for (const req of prd.functionalRequirements ?? []) {
    scan(`functionalRequirements[${req.id}].description`, req.description)
  }
  for (let i = 0; i < (prd.decisionLog ?? []).length; i++) {
    scan(`decisionLog[${i}].rationale`, prd.decisionLog![i].rationale)
  }
  return errors
}

export function validateScopeConsistent(prd: StructuredPrd): MechanicalError[] {
  const errors: MechanicalError[] = []
  const funcNames = (prd.functionalRequirements ?? []).map((r) => r.name.trim().toLowerCase())

  for (let i = 0; i < (prd.scope?.outOfScope ?? []).length; i++) {
    const item = prd.scope.outOfScope[i].item.trim().toLowerCase()
    if (!item) continue
    const hit = funcNames.find((n) => n === item || n.includes(item) || item.includes(n))
    if (hit) {
      errors.push(
        err(
          'scope_consistent',
          `scope.outOfScope[${i}]`,
          `"明确排除"条目 "${prd.scope.outOfScope[i].item}" 与功能需求 "${hit}" 冲突`
        )
      )
    }
  }
  for (let i = 0; i < (prd.scope?.tbd ?? []).length; i++) {
    const item = prd.scope.tbd[i].item.trim().toLowerCase()
    if (!item) continue
    const hit = funcNames.find((n) => n === item || n.includes(item) || item.includes(n))
    if (hit) {
      errors.push(
        err(
          'scope_consistent',
          `scope.tbd[${i}]`,
          `"待定事项"条目 "${prd.scope.tbd[i].item}" 被当作已确认需求写入了第 3 章（冲突于 "${hit}"）`
        )
      )
    }
  }
  return errors
}

export function validateImpactEnum(prd: StructuredPrd): MechanicalError[] {
  const errors: MechanicalError[] = []
  for (let i = 0; i < (prd.impacts ?? []).length; i++) {
    const imp = prd.impacts[i]
    if (!ALLOWED_IMPACT_TYPES.includes(imp.type)) {
      errors.push(
        err(
          'impact_enum',
          `impacts[${i}].type`,
          `影响类型 "${imp.type}" 不在允许枚举 ${ALLOWED_IMPACT_TYPES.join(' / ')}`
        )
      )
    }
    if (!ALLOWED_COMPATIBILITY.includes(imp.compatibility)) {
      errors.push(
        err(
          'impact_enum',
          `impacts[${i}].compatibility`,
          `兼容性 "${imp.compatibility}" 不在允许枚举 ${ALLOWED_COMPATIBILITY.join(' / ')}`
        )
      )
    }
  }
  return errors
}

export function validateBreakingChangeDetail(prd: StructuredPrd): MechanicalError[] {
  const errors: MechanicalError[] = []
  const breakingImpacts = (prd.impacts ?? []).filter((i) => i.compatibility === '破坏性变更')
  const breakingChanges = prd.breakingChanges ?? []

  for (let i = 0; i < breakingImpacts.length; i++) {
    const imp = breakingImpacts[i]
    const match = breakingChanges.find((bc) => bc.module === imp.module)
    if (!match) {
      errors.push(
        err(
          'breaking_change_detail',
          `breakingChanges[module="${imp.module}"]`,
          `6.1 破坏性变更模块 "${imp.module}" 在 6.2 缺少对应详述`
        )
      )
    }
  }

  for (let i = 0; i < breakingChanges.length; i++) {
    const bc = breakingChanges[i]
    const base = `breakingChanges[${i}]`
    if (isBlank(bc.current)) errors.push(err('breaking_change_detail', `${base}.current`, '现状不能为空'))
    if (isBlank(bc.after)) errors.push(err('breaking_change_detail', `${base}.after`, '变更后描述不能为空'))
    if (!bc.affectedParties || bc.affectedParties.length === 0 || bc.affectedParties.every(isBlank)) {
      errors.push(err('breaking_change_detail', `${base}.affectedParties`, '影响方至少需要 1 项'))
    }
    if (isBlank(bc.migrationSteps)) {
      errors.push(err('breaking_change_detail', `${base}.migrationSteps`, '迁移步骤不能为空'))
    }
    if (isBlank(bc.rollbackStrategy)) {
      errors.push(err('breaking_change_detail', `${base}.rollbackStrategy`, '回滚策略不能为空'))
    }
  }
  return errors
}

export function validateClosedLoop(prd: StructuredPrd): MechanicalError[] {
  const errors: MechanicalError[] = []
  const FIELDS: Array<'trigger' | 'stateChange' | 'notify' | 'nextActor' | 'terminalState'> = [
    'trigger',
    'stateChange',
    'notify',
    'nextActor',
    'terminalState',
  ]
  for (const req of prd.functionalRequirements ?? []) {
    const actions = req.actions ?? []
    for (let ai = 0; ai < actions.length; ai++) {
      const a = actions[ai]
      if (isBlank(a.verb)) {
        errors.push(
          err(
            'closed_loop',
            `functionalRequirements[${req.id}].actions[${ai}].verb`,
            `动作 verb 不能为空`
          )
        )
      }
      const missing = FIELDS.filter((f) => isBlank(a[f]))
      if (missing.length > 0) {
        errors.push(
          err(
            'closed_loop',
            `functionalRequirements[${req.id}].actions[${ai}](${a.verb || '?'})`,
            `动作 "${a.verb || '(未命名)'}" 缺少 5W 字段: ${missing.join(', ')}`
          )
        )
      }
    }
  }
  return errors
}

// =============================================================================
// 分发器
// =============================================================================

export type CheckFn = (prd: StructuredPrd) => MechanicalError[]

export const CHECK_REGISTRY: Record<string, CheckFn> = {
  chapter_complete: validateChapterComplete,
  source_traceable: validateSourceTraceable,
  measurable_acceptance: validateMeasurableAcceptance,
  no_soft_language: validateNoSoftLanguage,
  scope_consistent: validateScopeConsistent,
  impact_enum: validateImpactEnum,
  breaking_change_detail: validateBreakingChangeDetail,
  closed_loop: validateClosedLoop,
}

/**
 * 运行所有已注册的机械校验，聚合返回错误列表。
 * save_prd 入口调用此函数：errors.length > 0 即拒绝保存并原样返回给 Agent。
 *
 * 返回顺序：按 PRD_RULES 声明顺序，稳定；同一规则的多条错误保持 check 函数内部顺序。
 */
export function mechanicalValidate(prd: StructuredPrd): MechanicalError[] {
  const errors: MechanicalError[] = []
  for (const rule of PRD_RULES) {
    const fn = CHECK_REGISTRY[rule.id]
    if (fn) {
      errors.push(...fn(prd))
    }
  }
  return errors
}

/**
 * 拿到所有当前声明 "应有 mechanicalCheck" 但尚未注册的规则 id。
 * 测试用，保证 rules.ts 和 mechanical-check.ts 的口径一致。
 */
export function listMechanicallyEnforcedRuleIds(): string[] {
  return Object.keys(CHECK_REGISTRY)
}
