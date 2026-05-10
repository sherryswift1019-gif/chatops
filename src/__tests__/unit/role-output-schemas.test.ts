import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { SpecAuthorOutputSchema, validateRoleOutput } from '../../quick-impl/role-output-schemas.js'

const __filename = fileURLToPath(import.meta.url)
const FIXTURE_DIR = join(dirname(__filename), '..', 'fixtures', 'spec-author')

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
}

describe('SpecAuthorOutputSchema — v3 兼容性', () => {
  describe('正面 case（应 parse pass）', () => {
    it('v3-minimal: 最小合法 v3 输出（schemaVersion=v2 + 1 self-critique + 1 assumption）', () => {
      const data = loadFixture('v3-minimal.json')
      const result = SpecAuthorOutputSchema.safeParse(data)
      if (!result.success) console.error(result.error.issues)
      expect(result.success).toBe(true)
    })

    it('v3-full: 含全部 v3 字段（reviewHints / noGos / standardsConsulted union 对象 / e2eScenarios）', () => {
      const data = loadFixture('v3-full.json')
      const result = SpecAuthorOutputSchema.safeParse(data)
      if (!result.success) console.error(result.error.issues)
      expect(result.success).toBe(true)
    })

    it('v2-legacy: V2-B 老评测产物（无 schemaVersion → 跳过 v3 superRefine）', () => {
      const data = loadFixture('v2-legacy.json')
      const result = SpecAuthorOutputSchema.safeParse(data)
      if (!result.success) console.error(result.error.issues)
      expect(result.success).toBe(true)
    })

    it('老 standardsConsulted=string[]（v2 in-flight 形态）pass', () => {
      const data = loadFixture('v3-minimal.json') as Record<string, unknown>
      const evidence = data.evidence as { standardsConsulted: unknown[] }
      evidence.standardsConsulted = ['docs/standards/frontend-enum-select.md']
      const result = SpecAuthorOutputSchema.safeParse(data)
      expect(result.success).toBe(true)
    })

    it('老 selfCheck=[{item, passed, reason}] mechanical 形态在 schemaVersion=undefined 时 pass', () => {
      const data = loadFixture('v2-legacy.json')
      // v2-legacy 已经是 mechanical selfCheck，确认不报错
      const result = SpecAuthorOutputSchema.safeParse(data)
      expect(result.success).toBe(true)
    })

    it('混合 selfCheck（mechanical + 主观 union）pass', () => {
      const data = loadFixture('v3-minimal.json') as Record<string, unknown>
      const evidence = data.evidence as { selfCheck: unknown[] }
      evidence.selfCheck = [
        { item: '本 spec 最弱点是什么？', answer: 'X' },
        { item: 'AC 全部 GWT', passed: true },
      ]
      const result = SpecAuthorOutputSchema.safeParse(data)
      expect(result.success).toBe(true)
    })
  })

  describe('反面 case（v3 superRefine 应 fail）', () => {
    it('v3-rejected: schemaVersion=v2 但 selfCheck 缺最弱点关键词 + clarifications 全 fact', () => {
      const data = loadFixture('v3-rejected.json')
      const result = SpecAuthorOutputSchema.safeParse(data)
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' | ')
        expect(messages).toContain('self-critique')
        expect(messages).toContain('assumption')
      }
    })

    it('v3 selfCheck > 3 条触发 superRefine fail', () => {
      const data = loadFixture('v3-minimal.json') as Record<string, unknown>
      const evidence = data.evidence as { selfCheck: unknown[] }
      evidence.selfCheck = [
        { item: '本 spec 最弱点', answer: 'X' },
        { item: 'AC GWT', passed: true },
        { item: 'refs ≥ 1', passed: true },
        { item: '5 维度齐全', passed: true }, // 第 4 条触发
      ]
      const result = SpecAuthorOutputSchema.safeParse(data)
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' | ')
        expect(messages).toContain('≤3 items')
      }
    })

    it('v3 clarifications 全 fact（无 assumption）触发 superRefine fail', () => {
      const data = loadFixture('v3-minimal.json') as Record<string, unknown>
      data.clarifications = [
        { kind: 'fact', q: 'X', a: 'Y' },
      ]
      const result = SpecAuthorOutputSchema.safeParse(data)
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' | ')
        expect(messages).toContain('kind="assumption"')
      }
    })

    it('e2eScenarios 5 条合规仍生效（无 negative scenario）', () => {
      const data = loadFixture('v3-full.json') as Record<string, unknown>
      const scenarios = data.e2eScenarios as Array<{ kind: string }>
      // 把所有 scenario 改成 happy
      scenarios.forEach((s) => (s.kind = 'happy'))
      const result = SpecAuthorOutputSchema.safeParse(data)
      expect(result.success).toBe(false)
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(' | ')
        expect(messages).toContain('negative scenario')
      }
    })
  })

  describe('validateRoleOutput 入口', () => {
    it('spec-author + v3-full → ok=true', () => {
      const data = loadFixture('v3-full.json')
      const result = validateRoleOutput('spec-author', data)
      expect(result.ok).toBe(true)
    })

    it('spec-author + v3-rejected → ok=false 且包含具体 errors', () => {
      const data = loadFixture('v3-rejected.json')
      const result = validateRoleOutput('spec-author', data)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0)
        expect(result.errors.some((e) => e.includes('self-critique'))).toBe(true)
      }
    })
  })
})
