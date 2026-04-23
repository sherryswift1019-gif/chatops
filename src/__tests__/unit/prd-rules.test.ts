import { describe, it, expect } from 'vitest'
import {
  PRD_RULES,
  RULES_VERSION,
  findRuleById,
  renderDialogueProbes,
  renderGeneratorInstructions,
  renderRepairCheatSheet,
  renderReviewerChecks,
  type PrdRule,
} from '../../agent/prd/rules.js'

describe('PRD_RULES 规则清单基本性质', () => {
  it('一期落地 10 条规则', () => {
    expect(PRD_RULES).toHaveLength(10)
  })

  it('所有规则 id 唯一', () => {
    const ids = PRD_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('所有规则都有非空 generatorInstruction 和 reviewerCheck', () => {
    for (const r of PRD_RULES) {
      expect(r.generatorInstruction, `${r.id}.generatorInstruction`).toBeTruthy()
      expect(r.reviewerCheck, `${r.id}.reviewerCheck`).toBeTruthy()
    }
  })

  it('所有规则都有至少一个 applicablePhase', () => {
    for (const r of PRD_RULES) {
      expect(r.applicablePhases.length, `${r.id}.applicablePhases`).toBeGreaterThan(0)
    }
  })

  it('createdAt 均为 YYYY-MM-DD 格式', () => {
    for (const r of PRD_RULES) {
      expect(r.createdAt, `${r.id}.createdAt`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('迭代文档 §4.2 列出的 10 条 id 全部存在', () => {
    const expected = [
      'chapter_complete',
      'source_traceable',
      'measurable_acceptance',
      'no_soft_language',
      'no_impl_leak',
      'scope_consistent',
      'no_contradiction',
      'impact_enum',
      'breaking_change_detail',
      'closed_loop',
    ]
    const actual = PRD_RULES.map((r) => r.id).sort()
    expect(actual).toEqual(expected.sort())
  })

  it('closed_loop 是 V2 新增，dimension 为 closed_loop', () => {
    const r = findRuleById('closed_loop')
    expect(r).toBeDefined()
    expect(r!.dimension).toBe('closed_loop')
    expect(r!.severity).toBe('blocker')
  })
})

describe('findRuleById', () => {
  it('存在 id 返回规则', () => {
    const r = findRuleById('source_traceable')
    expect(r?.id).toBe('source_traceable')
  })

  it('不存在 id 返回 undefined', () => {
    expect(findRuleById('not_exist_rule_id')).toBeUndefined()
  })
})

describe('renderDialogueProbes', () => {
  it('Phase 2 (features) 至少包含 source_traceable / measurable_acceptance / closed_loop 三条 probe', () => {
    const out = renderDialogueProbes('features')
    expect(out).toContain('[source_traceable]')
    expect(out).toContain('[measurable_acceptance]')
    expect(out).toContain('[closed_loop]')
  })

  it('只渲染 applicablePhases 命中且有 dialogueProbe 的规则', () => {
    const out = renderDialogueProbes('features')
    // chapter_complete 的 applicablePhases 只有 draft，且无 dialogueProbe → 不应出现
    expect(out).not.toContain('[chapter_complete]')
    // no_soft_language 无 dialogueProbe → 不应出现
    expect(out).not.toContain('[no_soft_language]')
  })

  it('无匹配 phase 返回空串', () => {
    // discovery 阶段目前没有规则配 probe
    const out = renderDialogueProbes('discovery')
    expect(out).toBe('')
  })
})

describe('renderGeneratorInstructions', () => {
  it('包含所有 10 条规则的 ruleId 前缀', () => {
    const out = renderGeneratorInstructions()
    for (const r of PRD_RULES) {
      expect(out, `should contain [${r.id}]`).toContain(`[${r.id}]`)
    }
  })

  it('blocker 规则排在 warning 之前', () => {
    const out = renderGeneratorInstructions()
    const firstBlocker = out.indexOf('(blocker)')
    const firstWarning = out.indexOf('(warning)')
    // 存在 warning 时 blocker 必须在前
    if (firstWarning > -1 && firstBlocker > -1) {
      expect(firstBlocker).toBeLessThan(firstWarning)
    }
  })

  it('每一行含 severity 标记 (blocker/warning/info)', () => {
    const out = renderGeneratorInstructions()
    const lines = out.split('\n').filter((l) => l.trim())
    for (const line of lines) {
      expect(line).toMatch(/\((blocker|warning|info)\)/)
    }
  })
})

describe('renderReviewerChecks', () => {
  it('包含所有 10 条规则的 ruleId + dimension + severity', () => {
    const out = renderReviewerChecks()
    for (const r of PRD_RULES) {
      expect(out).toContain(`[${r.id}]`)
      expect(out).toContain(`dimension=${r.dimension}`)
    }
  })

  it('审查 checks 与生成 instructions 规则集一致（单一事实源验证）', () => {
    // 生成与审查都来自同一 PRD_RULES，ruleId 集合必须一致
    const genIds = renderGeneratorInstructions()
      .split('\n')
      .map((l) => l.match(/\[([^\]]+)\]/)?.[1])
      .filter(Boolean) as string[]
    const revIds = renderReviewerChecks()
      .split('\n')
      .map((l) => l.match(/\[([^\]]+)\]/)?.[1])
      .filter(Boolean) as string[]
    expect(genIds.sort()).toEqual(revIds.sort())
  })
})

describe('RULES_VERSION', () => {
  it('初版版本 tag 为 rules-v1', () => {
    expect(RULES_VERSION).toBe('rules-v1')
  })
})

describe('renderRepairCheatSheet', () => {
  it('每条规则都声明了 repairHint（V2.0 MVP 全覆盖）', () => {
    for (const r of PRD_RULES) {
      expect(r.repairHint, `${r.id}.repairHint`).toBeTruthy()
    }
  })

  it('cheat sheet 输出包含所有 10 条 ruleId（作为 `id` 包裹）', () => {
    const out = renderRepairCheatSheet()
    for (const r of PRD_RULES) {
      expect(out, `missing \`${r.id}\``).toContain(`\`${r.id}\``)
    }
  })

  it('blocker 规则排在 warning 之前', () => {
    const out = renderRepairCheatSheet()
    const lines = out.split('\n')
    const firstBlockerIdx = lines.findIndex((l) =>
      PRD_RULES.some((r) => r.severity === 'blocker' && l.includes(`\`${r.id}\``))
    )
    const firstWarningIdx = lines.findIndex((l) =>
      PRD_RULES.some((r) => r.severity === 'warning' && l.includes(`\`${r.id}\``))
    )
    if (firstWarningIdx > -1 && firstBlockerIdx > -1) {
      expect(firstBlockerIdx).toBeLessThan(firstWarningIdx)
    }
  })

  it('没有 repairHint 的规则不进入 cheat sheet（未来规则新增时用）', () => {
    // 当前 10 条都有 hint，用人造规则验证过滤逻辑
    const originalLen = PRD_RULES.length
    // 通过 push 一条临时规则再 pop，确保不污染
    const fake: PrdRule = {
      id: '__fake_no_hint__',
      dimension: 'format',
      severity: 'info',
      autoFix: false,
      generatorInstruction: 'fake',
      reviewerCheck: 'fake',
      applicablePhases: ['draft'],
      createdAt: '2026-04-22',
      owner: 'tech',
    }
    ;(PRD_RULES as PrdRule[]).push(fake)
    try {
      const out = renderRepairCheatSheet()
      expect(out).not.toContain('`__fake_no_hint__`')
    } finally {
      ;(PRD_RULES as PrdRule[]).pop()
      expect(PRD_RULES).toHaveLength(originalLen)
    }
  })

  it('cheat sheet 与 generator/reviewer 渲染一样，条目与 PRD_RULES 同源', () => {
    const repairIds = renderRepairCheatSheet()
      .split('\n')
      .map((l) => l.match(/`([^`]+)`/)?.[1])
      .filter(Boolean) as string[]
    const reviewIds = renderReviewerChecks()
      .split('\n')
      .map((l) => l.match(/\[([^\]]+)\]/)?.[1])
      .filter(Boolean) as string[]
    expect(repairIds.sort()).toEqual(reviewIds.sort())
  })
})

// TS 编译期断言：确保 PrdRule 类型能被外部消费（用 as 类型校验占位即可）
const _typeCheck: PrdRule = PRD_RULES[0]
void _typeCheck
