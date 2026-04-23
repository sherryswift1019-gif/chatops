import { describe, it, expect } from 'vitest'
import {
  CHECK_REGISTRY,
  listMechanicallyEnforcedRuleIds,
  mechanicalValidate,
  validateBreakingChangeDetail,
  validateChapterComplete,
  validateClosedLoop,
  validateImpactEnum,
  validateMeasurableAcceptance,
  validateNoSoftLanguage,
  validateScopeConsistent,
  validateSourceTraceable,
} from '../../agent/prd/mechanical-check.js'
import type {
  PrdAction,
  PrdBreakingChange,
  PrdFunctionalRequirement,
  PrdImpactItem,
  StructuredPrd,
} from '../../agent/prd/structured-types.js'

// =============================================================================
// 测试工厂：构造一份 "骨架合法" 的 PRD，单测再针对字段改坏验证拦截
// =============================================================================

function validAction(overrides: Partial<PrdAction> = {}): PrdAction {
  return {
    verb: '提交审批',
    trigger: '用户点击提交按钮',
    stateChange: 'status 从 draft 变为 pending_review',
    notify: '通知审批人（钉钉消息）',
    nextActor: '审批人在审批页查看',
    terminalState: 'status = approved 或 rejected',
    ...overrides,
  }
}

function validFunctionalRequirement(
  overrides: Partial<PrdFunctionalRequirement> = {}
): PrdFunctionalRequirement {
  return {
    id: '3.1',
    name: '创建订单',
    priority: 'P0',
    description: '用户下单后创建订单记录。',
    source: {
      phase: 2,
      quote: 'Phase 2 用户说：需要下单',
      type: 'user_said',
    },
    acceptanceCriteria: [{ text: '订单创建耗时 P99 < 500ms' }],
    ...overrides,
  }
}

function validImpact(overrides: Partial<PrdImpactItem> = {}): PrdImpactItem {
  return {
    module: 'auth',
    type: '行为复用',
    compatibility: '完全兼容',
    description: '复用现有 auth 模块鉴权',
    source: 'Phase 2 对话 - 确认复用 auth',
    ...overrides,
  }
}

function validBreakingChange(
  overrides: Partial<PrdBreakingChange> = {}
): PrdBreakingChange {
  return {
    module: 'order-api',
    current: 'GET /api/order 返回 {id,status}',
    after: 'GET /api/order 返回 {id,status,priority}',
    affectedParties: ['前端订单页', '运营后台'],
    migrationSteps: '前端同步升级；后端先灰度再全量',
    rollbackStrategy: '环境变量切回旧字段集',
    ...overrides,
  }
}

function validPrd(): StructuredPrd {
  return {
    meta: { title: '订单模块 PRD', productLineId: 1 },
    goals: {
      vision: '让用户下单更快',
      oneLineStatement: '订单极简下单',
      objectives: ['提高转化率', '降低客诉'],
      successMetrics: [
        { metric: '下单转化', target: '≥ 85%', measurement: '周度看板' },
      ],
    },
    users: {
      primarySegment: '零售 C 端用户',
    },
    functionalRequirements: [validFunctionalRequirement()],
    impacts: [validImpact()],
    breakingChanges: [],
    scope: {
      inScope: ['极简下单'],
      outOfScope: [],
      tbd: [],
    },
  }
}

// =============================================================================
// validateChapterComplete
// =============================================================================

describe('validateChapterComplete', () => {
  it('骨架合法的 PRD 通过', () => {
    expect(validateChapterComplete(validPrd())).toEqual([])
  })

  it('空 title 被拦截', () => {
    const prd = validPrd()
    prd.meta.title = ''
    const errs = validateChapterComplete(prd)
    expect(errs).toHaveLength(1)
    expect(errs[0].field).toBe('meta.title')
  })

  it('空 vision 被拦截', () => {
    const prd = validPrd()
    prd.goals.vision = ''
    expect(validateChapterComplete(prd).some((e) => e.field === 'goals.vision')).toBe(true)
  })

  it('空 functionalRequirements 被拦截', () => {
    const prd = validPrd()
    prd.functionalRequirements = []
    expect(
      validateChapterComplete(prd).some((e) => e.field === 'functionalRequirements')
    ).toBe(true)
  })

  it('空 impacts 被拦截（即便无影响也需至少 1 条无直接影响）', () => {
    const prd = validPrd()
    prd.impacts = []
    expect(validateChapterComplete(prd).some((e) => e.field === 'impacts')).toBe(true)
  })
})

// =============================================================================
// validateSourceTraceable
// =============================================================================

describe('validateSourceTraceable', () => {
  it('合法 source 通过', () => {
    expect(validateSourceTraceable(validPrd())).toEqual([])
  })

  it('缺 source 字段被拦截', () => {
    const prd = validPrd()
    delete (prd.functionalRequirements[0] as { source?: unknown }).source
    const errs = validateSourceTraceable(prd)
    expect(errs.some((e) => e.ruleId === 'source_traceable')).toBe(true)
  })

  it('source.phase 为 0 被拦截', () => {
    const prd = validPrd()
    prd.functionalRequirements[0].source.phase = 0
    expect(
      validateSourceTraceable(prd).some((e) => e.field.endsWith('.phase'))
    ).toBe(true)
  })

  it('source.type 非枚举值被拦截', () => {
    const prd = validPrd()
    ;(prd.functionalRequirements[0].source as { type: string }).type = 'random'
    expect(
      validateSourceTraceable(prd).some((e) => e.field.endsWith('.type'))
    ).toBe(true)
  })

  it('impacts 缺 source 被拦截', () => {
    const prd = validPrd()
    prd.impacts[0].source = ''
    expect(
      validateSourceTraceable(prd).some((e) => e.field === 'impacts[0].source')
    ).toBe(true)
  })
})

// =============================================================================
// validateMeasurableAcceptance
// =============================================================================

describe('validateMeasurableAcceptance', () => {
  it('含数字的验收标准通过', () => {
    expect(validateMeasurableAcceptance(validPrd())).toEqual([])
  })

  it('"快速" 这类无数字的验收标准被拦截', () => {
    const prd = validPrd()
    prd.functionalRequirements[0].acceptanceCriteria = [{ text: '用户体验流畅快速' }]
    const errs = validateMeasurableAcceptance(prd)
    expect(errs.some((e) => e.ruleId === 'measurable_acceptance')).toBe(true)
  })

  it('含比较符号的验收标准通过', () => {
    const prd = validPrd()
    prd.functionalRequirements[0].acceptanceCriteria = [{ text: 'status 字段 = approved' }]
    expect(validateMeasurableAcceptance(prd)).toEqual([])
  })

  it('成功指标 target 无数字被拦截', () => {
    const prd = validPrd()
    prd.goals.successMetrics[0].target = '很高'
    expect(
      validateMeasurableAcceptance(prd).some((e) =>
        e.field.includes('goals.successMetrics')
      )
    ).toBe(true)
  })
})

// =============================================================================
// validateNoSoftLanguage
// =============================================================================

describe('validateNoSoftLanguage', () => {
  it('正常文本通过', () => {
    expect(validateNoSoftLanguage(validPrd())).toEqual([])
  })

  it('"为了提升用户体验" 触发 warning', () => {
    const prd = validPrd()
    prd.goals.vision = '为了提升用户体验，我们要做下单极简'
    const errs = validateNoSoftLanguage(prd)
    expect(errs.some((e) => e.ruleId === 'no_soft_language')).toBe(true)
  })

  it('"打造完美" 触发 warning', () => {
    const prd = validPrd()
    prd.functionalRequirements[0].description = '打造完美的下单体验'
    const errs = validateNoSoftLanguage(prd)
    expect(errs.length).toBeGreaterThan(0)
  })
})

// =============================================================================
// validateScopeConsistent
// =============================================================================

describe('validateScopeConsistent', () => {
  it('无冲突通过', () => {
    expect(validateScopeConsistent(validPrd())).toEqual([])
  })

  it('outOfScope 条目与功能需求同名被拦截', () => {
    const prd = validPrd()
    prd.scope.outOfScope = [{ item: '创建订单', reason: '一期不做' }]
    const errs = validateScopeConsistent(prd)
    expect(errs.some((e) => e.ruleId === 'scope_consistent')).toBe(true)
  })

  it('tbd 条目与功能需求同名被拦截', () => {
    const prd = validPrd()
    prd.scope.tbd = [{ item: '创建订单', needsInput: '待 PM 确认' }]
    const errs = validateScopeConsistent(prd)
    expect(errs.some((e) => e.ruleId === 'scope_consistent')).toBe(true)
  })
})

// =============================================================================
// validateImpactEnum
// =============================================================================

describe('validateImpactEnum', () => {
  it('合法枚举通过', () => {
    expect(validateImpactEnum(validPrd())).toEqual([])
  })

  it('非枚举 type 被拦截', () => {
    const prd = validPrd()
    ;(prd.impacts[0] as { type: string }).type = '可能变化'
    const errs = validateImpactEnum(prd)
    expect(errs.some((e) => e.field === 'impacts[0].type')).toBe(true)
  })

  it('非枚举 compatibility 被拦截', () => {
    const prd = validPrd()
    ;(prd.impacts[0] as { compatibility: string }).compatibility = '看情况'
    const errs = validateImpactEnum(prd)
    expect(errs.some((e) => e.field === 'impacts[0].compatibility')).toBe(true)
  })
})

// =============================================================================
// validateBreakingChangeDetail
// =============================================================================

describe('validateBreakingChangeDetail', () => {
  it('无破坏性变更时通过', () => {
    expect(validateBreakingChangeDetail(validPrd())).toEqual([])
  })

  it('有破坏性变更但 breakingChanges 缺对应详述被拦截', () => {
    const prd = validPrd()
    prd.impacts = [validImpact({ module: 'order-api', compatibility: '破坏性变更' })]
    prd.breakingChanges = []
    const errs = validateBreakingChangeDetail(prd)
    expect(errs.some((e) => e.ruleId === 'breaking_change_detail')).toBe(true)
  })

  it('破坏性变更有详述且 5 字段齐全通过', () => {
    const prd = validPrd()
    prd.impacts = [validImpact({ module: 'order-api', compatibility: '破坏性变更' })]
    prd.breakingChanges = [validBreakingChange()]
    expect(validateBreakingChangeDetail(prd)).toEqual([])
  })

  it('破坏性详述缺 migrationSteps 被拦截', () => {
    const prd = validPrd()
    prd.impacts = [validImpact({ module: 'order-api', compatibility: '破坏性变更' })]
    prd.breakingChanges = [validBreakingChange({ migrationSteps: '' })]
    const errs = validateBreakingChangeDetail(prd)
    expect(errs.some((e) => e.field.endsWith('.migrationSteps'))).toBe(true)
  })

  it('破坏性详述 affectedParties 空数组被拦截', () => {
    const prd = validPrd()
    prd.impacts = [validImpact({ module: 'order-api', compatibility: '破坏性变更' })]
    prd.breakingChanges = [validBreakingChange({ affectedParties: [] })]
    const errs = validateBreakingChangeDetail(prd)
    expect(errs.some((e) => e.field.endsWith('.affectedParties'))).toBe(true)
  })
})

// =============================================================================
// validateClosedLoop
// =============================================================================

describe('validateClosedLoop', () => {
  it('无 actions 时通过', () => {
    expect(validateClosedLoop(validPrd())).toEqual([])
  })

  it('完整 5W 的 action 通过', () => {
    const prd = validPrd()
    prd.functionalRequirements[0].actions = [validAction()]
    expect(validateClosedLoop(prd)).toEqual([])
  })

  it('缺 terminalState 被拦截', () => {
    const prd = validPrd()
    prd.functionalRequirements[0].actions = [validAction({ terminalState: '' })]
    const errs = validateClosedLoop(prd)
    expect(errs.some((e) => e.message.includes('terminalState'))).toBe(true)
  })

  it('多个字段缺失一次性报出', () => {
    const prd = validPrd()
    prd.functionalRequirements[0].actions = [
      validAction({ notify: '', nextActor: '', terminalState: '' }),
    ]
    const errs = validateClosedLoop(prd)
    // 一个 action 缺 3 个 5W 字段，应至少有 1 条包含全部缺失字段的消息
    expect(errs.length).toBeGreaterThan(0)
    const msg = errs.map((e) => e.message).join(' ')
    expect(msg).toContain('notify')
    expect(msg).toContain('nextActor')
    expect(msg).toContain('terminalState')
  })

  it('空 verb 被拦截', () => {
    const prd = validPrd()
    prd.functionalRequirements[0].actions = [validAction({ verb: '' })]
    const errs = validateClosedLoop(prd)
    expect(errs.some((e) => e.field.endsWith('.verb'))).toBe(true)
  })
})

// =============================================================================
// mechanicalValidate 分发器 + 注册完整性
// =============================================================================

describe('mechanicalValidate', () => {
  it('骨架合法 PRD 返回空数组', () => {
    expect(mechanicalValidate(validPrd())).toEqual([])
  })

  it('同时存在多种违规时聚合返回', () => {
    const prd = validPrd()
    prd.goals.vision = ''
    prd.impacts[0].source = ''
    prd.functionalRequirements[0].acceptanceCriteria = [{ text: '流畅好用' }]
    const errs = mechanicalValidate(prd)
    const ruleIds = new Set(errs.map((e) => e.ruleId))
    expect(ruleIds.has('chapter_complete')).toBe(true)
    expect(ruleIds.has('source_traceable')).toBe(true)
    expect(ruleIds.has('measurable_acceptance')).toBe(true)
  })

  it('CHECK_REGISTRY 覆盖迭代文档 §4.2 标 ✓ 的 8 条规则', () => {
    const expected = [
      'chapter_complete',
      'source_traceable',
      'measurable_acceptance',
      'no_soft_language',
      'scope_consistent',
      'impact_enum',
      'breaking_change_detail',
      'closed_loop',
    ]
    expect(listMechanicallyEnforcedRuleIds().sort()).toEqual(expected.sort())
  })

  it('未机械化的规则（no_impl_leak / no_contradiction）不在 CHECK_REGISTRY', () => {
    expect(CHECK_REGISTRY.no_impl_leak).toBeUndefined()
    expect(CHECK_REGISTRY.no_contradiction).toBeUndefined()
  })
})
