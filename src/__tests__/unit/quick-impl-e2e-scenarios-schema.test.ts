/**
 * E2E Scenario 合规校验测试 — schema 硬规则 + superRefine
 *
 * 详见：docs/prds/prd-quick-impl-e2e-phase2.md "E2E Scenario 合规标准 / A. 硬规则"
 */
import { describe, expect, it } from 'vitest'
import { SpecAuthorOutputSchema } from '../../quick-impl/role-output-schemas.js'

const baseEvidence = {
  standardsConsulted: ['docs/standards/foo.md'],
  selfCheck: [{ item: 'check 1', passed: true }],
}

const baseSpec = {
  summary: 'spec',
  decision: 'pass' as const,
  notes: [],
  evidence: baseEvidence,
  acceptanceCriteria: [
    { id: 'AC-1', format: 'given-when-then' as const, text: 'Given X, When Y, Then Z' },
    { id: 'AC-2', format: 'given-when-then' as const, text: 'Given A, When B, Then C' },
  ],
  openQuestions: [],
  risks: [{ desc: 'risk', severity: 'medium' as const }],
  references: [{ file: 'src/x.ts', line: 1, purpose: 'p' }],
  clarifications: [],
}

const happyScenario = {
  id: 'login-with-valid-credentials',
  name: '正常登录',
  kind: 'happy' as const,
  coversAC: ['AC-1'],
  tags: [],
  steps: ['POST /api/login body {username:"admin", password:"x"}，期望返回 200'],
  acceptance: ['页面跳转 /dashboard'],
}

const negativeScenario = {
  id: 'login-with-wrong-password',
  name: '密码错',
  kind: 'negative' as const,
  coversAC: ['AC-2'],
  tags: [],
  steps: ['POST /api/login body {username:"admin", password:"wrong"}'],
  acceptance: ['返回 status=401'],
}

describe('E2E Scenario schema 合规校验', () => {
  describe('v8 兼容（e2eScenarios 缺失）', () => {
    it('e2eScenarios 不传时仍 pass（v8 in-flight QI run 不炸）', () => {
      const r = SpecAuthorOutputSchema.safeParse(baseSpec)
      expect(r.success).toBe(true)
    })
  })

  describe('硬规则 A.数量', () => {
    it('1 个 happy + 1 个 negative 全 covered → pass', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [happyScenario, negativeScenario],
      })
      expect(r.success).toBe(true)
    })

    it('e2eScenarios 空数组直接拒（无法 pass，需要至少 negative + happy）', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [],
      })
      expect(r.success).toBe(false)
    })

    it('数量 > 5 拒批', () => {
      const tooMany = Array.from({ length: 6 }, (_, i) => ({
        ...happyScenario,
        id: `scenario-${i}`,
        coversAC: ['AC-1'] as string[],
        kind: 'happy' as 'happy' | 'negative',
      }))
      tooMany[0].kind = 'negative'
      tooMany[0].coversAC = ['AC-2']
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: tooMany,
      })
      expect(r.success).toBe(false)
      if (!r.success) {
        const messages = r.error.issues.map((i) => i.message).join(' | ')
        expect(messages).toMatch(/max 5/)
      }
    })
  })

  describe('硬规则 B.步骤 / 断言', () => {
    it('steps 空数组拒', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [{ ...happyScenario, steps: [] }, negativeScenario],
      })
      expect(r.success).toBe(false)
    })

    it('acceptance 空数组拒', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [{ ...happyScenario, acceptance: [] }, negativeScenario],
      })
      expect(r.success).toBe(false)
    })
  })

  describe('硬规则 C.AC 关联 / 全覆盖', () => {
    it('coversAC 引用未知 AC → 拒批', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [
          { ...happyScenario, coversAC: ['AC-99'] },
          negativeScenario,
        ],
      })
      expect(r.success).toBe(false)
      if (!r.success) {
        expect(r.error.issues.some((i) => i.message.includes('unknown AC'))).toBe(true)
      }
    })

    it('coversAC 格式不对（不是 AC-N）→ 拒批', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [
          { ...happyScenario, coversAC: ['ac-1'] },
          negativeScenario,
        ],
      })
      expect(r.success).toBe(false)
    })

    it('coversAC 空数组 → 拒批', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [{ ...happyScenario, coversAC: [] }, negativeScenario],
      })
      expect(r.success).toBe(false)
    })

    it('AC 全覆盖：AC-1 + AC-2 必须都被覆盖；漏 AC-2 → 拒', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [
          { ...happyScenario, coversAC: ['AC-1'] },
          { ...negativeScenario, coversAC: ['AC-1'] }, // 都只覆盖 AC-1
        ],
      })
      expect(r.success).toBe(false)
      if (!r.success) {
        expect(r.error.issues.some((i) => i.message.includes('AC-2 not covered'))).toBe(true)
      }
    })
  })

  describe('硬规则 D.反向场景', () => {
    it('全 happy 无 negative → 拒批', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [
          happyScenario,
          { ...happyScenario, id: 'happy-2', coversAC: ['AC-2'] },
        ],
      })
      expect(r.success).toBe(false)
      if (!r.success) {
        expect(r.error.issues.some((i) => i.message.includes('negative'))).toBe(true)
      }
    })

    it('1 happy + 1 negative → pass', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [happyScenario, negativeScenario],
      })
      expect(r.success).toBe(true)
    })
  })

  describe('硬规则 E.id 唯一性 / 命名', () => {
    it('重复 id 拒批', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [
          happyScenario,
          { ...negativeScenario, id: happyScenario.id },
        ],
      })
      expect(r.success).toBe(false)
      if (!r.success) {
        expect(r.error.issues.some((i) => i.message.includes('duplicate scenario id'))).toBe(true)
      }
    })

    it('id 用 PascalCase / snake_case → 拒批（要 kebab-case）', () => {
      const cases = ['LoginHappy', 'login_happy', '1-bad-start', 'has space']
      for (const id of cases) {
        const r = SpecAuthorOutputSchema.safeParse({
          ...baseSpec,
          e2eScenarios: [{ ...happyScenario, id }, negativeScenario],
        })
        expect(r.success, `id="${id}" 应被拒`).toBe(false)
      }
    })

    it('合法 kebab-case id → pass', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [
          { ...happyScenario, id: 'login-with-valid-credentials' },
          negativeScenario,
        ],
      })
      expect(r.success).toBe(true)
    })
  })

  describe('硬规则 F.kind 枚举', () => {
    it('kind 不是 happy/negative → 拒', () => {
      const r = SpecAuthorOutputSchema.safeParse({
        ...baseSpec,
        e2eScenarios: [
          { ...happyScenario, kind: 'edge' as never },
          negativeScenario,
        ],
      })
      expect(r.success).toBe(false)
    })
  })
})
