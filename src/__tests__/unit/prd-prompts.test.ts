import { describe, it, expect } from 'vitest'
import {
  CREATE_PRD_SYSTEM_PROMPT,
  REVIEW_PRD_SYSTEM_PROMPT,
  REPAIR_PRD_SYSTEM_PROMPT,
  createPrdSystemPrompt,
  reviewPrdSystemPrompt,
  repairPrdSystemPrompt,
} from '../../agent/prd/prompts.js'
import { PRD_RULES } from '../../agent/prd/rules.js'

// =============================================================================
// CREATE prompt：规则单一来源、结构化签名指引
// =============================================================================

describe('CREATE_PRD_SYSTEM_PROMPT', () => {
  it('Phase 4 段落包含所有 rules.ts ruleId（generatorInstruction 注入）', () => {
    for (const r of PRD_RULES) {
      expect(CREATE_PRD_SYSTEM_PROMPT, `missing [${r.id}]`).toContain(`[${r.id}]`)
    }
  })

  it('每条注入的规则都含 severity 标记 (blocker/warning/info)', () => {
    for (const r of PRD_RULES) {
      expect(CREATE_PRD_SYSTEM_PROMPT).toContain(`[${r.id}] (${r.severity})`)
    }
  })

  it('blocker 规则排在 warning/info 之前（让 Agent 优先关注）', () => {
    const firstBlocker = CREATE_PRD_SYSTEM_PROMPT.indexOf('(blocker)')
    const firstWarning = CREATE_PRD_SYSTEM_PROMPT.indexOf('(warning)')
    if (firstWarning > -1 && firstBlocker > -1) {
      expect(firstBlocker).toBeLessThan(firstWarning)
    }
  })

  it('save_prd 工具说明首选 structured，V1 仅作 fallback', () => {
    expect(CREATE_PRD_SYSTEM_PROMPT).toContain('structured')
    expect(CREATE_PRD_SYSTEM_PROMPT).toContain('首选')
    expect(CREATE_PRD_SYSTEM_PROMPT).toMatch(/StructuredPrd/)
  })

  it('机械校验失败提示中提到 ruleId / field / message 三字段', () => {
    expect(CREATE_PRD_SYSTEM_PROMPT).toMatch(/ruleId/)
    expect(CREATE_PRD_SYSTEM_PROMPT).toMatch(/field/)
    expect(CREATE_PRD_SYSTEM_PROMPT).toMatch(/message/)
  })

  it('不再出现 V1 老模板约束：手写"9 章节模板"的章节标题不在 prompt 主体内', () => {
    // V2 的 Markdown 由 renderer 产出，Agent 不应再自己拼章节
    expect(CREATE_PRD_SYSTEM_PROMPT).not.toContain(
      '包含全部 9 章节的完整 Markdown'
    )
  })

  it('模块加载时预渲染的常量 == 即时渲染函数结果', () => {
    expect(CREATE_PRD_SYSTEM_PROMPT).toBe(createPrdSystemPrompt())
  })
})

// =============================================================================
// REVIEW prompt：检查项从 rules.ts 注入、ruleId 作为主键、移除硬编码 9 维
// =============================================================================

describe('REVIEW_PRD_SYSTEM_PROMPT', () => {
  it('checks 段落包含全部 rules.ts 的 ruleId', () => {
    for (const r of PRD_RULES) {
      expect(REVIEW_PRD_SYSTEM_PROMPT, `missing [${r.id}]`).toContain(`[${r.id}]`)
    }
  })

  it('每条 check 含 severity + dimension 标记（从 renderReviewerChecks）', () => {
    for (const r of PRD_RULES) {
      expect(REVIEW_PRD_SYSTEM_PROMPT).toContain(
        `[${r.id}] (severity=${r.severity}, dimension=${r.dimension})`
      )
    }
  })

  it('finding 输出格式含 ruleId 字段定义', () => {
    expect(REVIEW_PRD_SYSTEM_PROMPT).toContain('"ruleId"')
  })

  it('强制要求调用 submit_review 工具（V2.0 唯一出口）', () => {
    expect(REVIEW_PRD_SYSTEM_PROMPT).toContain('submit_review')
    expect(REVIEW_PRD_SYSTEM_PROMPT).toMatch(/必须.*调用|调用.*submit_review/)
  })

  it('不再要求输出 ```json``` 代码块 / 自由 JSON', () => {
    // V2.0 契约切到 tool-call，prompt 不应再引导输出 JSON 代码块
    expect(REVIEW_PRD_SYSTEM_PROMPT).not.toMatch(/必须用\s*```json/)
    expect(REVIEW_PRD_SYSTEM_PROMPT).not.toContain('严格输出以下 JSON 结构')
  })

  it('明确禁止输出自由文本 JSON', () => {
    expect(REVIEW_PRD_SYSTEM_PROMPT).toMatch(/禁止.*JSON|自由.*JSON|自由文本/)
  })

  it('不再硬编码 "1-9 的整数" 维度定义（已被 ruleId 主键化）', () => {
    expect(REVIEW_PRD_SYSTEM_PROMPT).not.toMatch(/dimension:\s*1-9\s*的整数/)
    expect(REVIEW_PRD_SYSTEM_PROMPT).not.toContain('1-9 的整数')
  })

  it('不再硬编码"维度 1: 格式完整性"这类 9 维枚举章节', () => {
    // V1 prompt 里的 "### 维度 N:" 块已被 rules.ts 渲染取代
    expect(REVIEW_PRD_SYSTEM_PROMPT).not.toMatch(/###\s*维度\s*\d+:/)
  })

  it('示例 submit_review 调用用合法 ruleId（非数字 dimension）', () => {
    const exampleMatch = REVIEW_PRD_SYSTEM_PROMPT.match(
      /"ruleId":\s*"([a-z_]+)"/
    )
    expect(exampleMatch).not.toBeNull()
    const idInExample = exampleMatch?.[1]
    const allIds = new Set(PRD_RULES.map((r) => r.id))
    expect(allIds.has(idInExample!)).toBe(true)
  })

  it('模块加载时预渲染的常量 == 即时渲染函数结果', () => {
    expect(REVIEW_PRD_SYSTEM_PROMPT).toBe(reviewPrdSystemPrompt())
  })
})

// =============================================================================
// REPAIR prompt：ruleId 反查 + 约束对齐
// =============================================================================

describe('REPAIR_PRD_SYSTEM_PROMPT', () => {
  it('说明 finding 主键是 ruleId', () => {
    expect(REPAIR_PRD_SYSTEM_PROMPT).toContain('ruleId')
  })

  it('反查指南至少覆盖几个关键 blocker ruleId', () => {
    // 给 Agent 的 cheat sheet，保证 blocker 规则都有反查提示
    const mustHave = [
      'source_traceable',
      'measurable_acceptance',
      'impact_enum',
      'breaking_change_detail',
      'closed_loop',
    ]
    for (const id of mustHave) {
      expect(REPAIR_PRD_SYSTEM_PROMPT, `missing ruleId cheat: ${id}`).toContain(
        `\`${id}\``
      )
    }
  })

  it('cheat sheet 覆盖全部 10 条 rules.ts 规则（渲染由 rules.ts 驱动）', () => {
    for (const r of PRD_RULES) {
      expect(REPAIR_PRD_SYSTEM_PROMPT, `missing \`${r.id}\``).toContain(`\`${r.id}\``)
    }
  })

  it('提示 agent-internal finding（如 submit_review_missing）走字面修复', () => {
    expect(REPAIR_PRD_SYSTEM_PROMPT).toContain('submit_review_missing')
  })

  it('模块加载时预渲染的常量 == 即时渲染函数结果', () => {
    expect(REPAIR_PRD_SYSTEM_PROMPT).toBe(repairPrdSystemPrompt())
  })
})

// =============================================================================
// 单一事实源不变式：CREATE / REVIEW 的 ruleId 集合一致
// =============================================================================

describe('rules.ts 单一事实源不变式', () => {
  it('CREATE 生成约束与 REVIEW 检查项的 ruleId 集合完全一致', () => {
    const extractIds = (s: string): string[] => {
      const ids = new Set<string>()
      const re = /\[([a-z_]+)\]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(s)) !== null) {
        if (PRD_RULES.some((r) => r.id === m![1])) ids.add(m[1])
      }
      return [...ids].sort()
    }
    const createIds = extractIds(CREATE_PRD_SYSTEM_PROMPT)
    const reviewIds = extractIds(REVIEW_PRD_SYSTEM_PROMPT)
    const ruleIds = PRD_RULES.map((r) => r.id).sort()
    expect(createIds).toEqual(ruleIds)
    expect(reviewIds).toEqual(ruleIds)
  })
})
