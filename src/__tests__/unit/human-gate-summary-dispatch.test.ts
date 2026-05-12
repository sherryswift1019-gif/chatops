import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  buildHumanGateSummary,
  resolveHumanGateAdvancedSummary,
} from '../../pipeline/approval-summary/index.js'
import { buildQuickImplGraph } from '../../quick-impl/bootstrap.js'
import type { SpecAuthorOutput } from '../../quick-impl/role-output-schemas.js'

const __filename = fileURLToPath(import.meta.url)
const FIXTURE_DIR = join(dirname(__filename), '..', 'fixtures', 'spec-author')

function loadSpecFixture(name: string): SpecAuthorOutput {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as SpecAuthorOutput
}

const SAMPLE_SPEC_MD = `# Spec\n\n## 1. 背景\n内容\n\n## 2. AC\n- AC-1\n`

describe('buildHumanGateSummary dispatch', () => {
  it('summaryKind=spec → 调 buildSpecApprovalSummary，web 含 5 段标题', () => {
    const skillOutput = loadSpecFixture('v3-full.json')
    const result = buildHumanGateSummary({
      kind: 'spec',
      args: {
        skillOutput,
        specMdContent: SAMPLE_SPEC_MD,
        round: 1,
      },
    })
    expect(result.web).toContain('Spec 评审 · 第 1 轮')
    expect(result.web).toContain('需要你 review 的点')
    expect(result.im).toMatch(/^🤖/)
    expect(result.im!.length).toBeLessThanOrEqual(250)
  })
})

describe('resolveHumanGateAdvancedSummary (from params)', () => {
  it('summaryKind=spec → 从 params 取 skillOutput，读 spec.md，调 dispatch；返回 5 段 web', () => {
    const skillOutput = loadSpecFixture('v3-full.json')
    let readPath = ''
    const result = resolveHumanGateAdvancedSummary({
      params: {
        summaryKind: 'spec',
        skillOutput,
        artifactPath: '/abs/path/to/spec.md',
        round: 1,
      },
      readFile: (p: string) => {
        readPath = p
        return SAMPLE_SPEC_MD
      },
    })
    expect(readPath).toBe('/abs/path/to/spec.md')
    expect(result).not.toBeNull()
    expect(result!.web).toContain('Spec 评审 · 第 1 轮')
    expect(result!.web).toContain('需要你 review 的点')
  })

  it('无 summaryKind → 返回 null（让 caller 走 fallback）', () => {
    const result = resolveHumanGateAdvancedSummary({
      params: { requirementId: 1, mode: 'required' },
      readFile: () => '',
    })
    expect(result).toBeNull()
  })

  it('summaryKind=spec 但 skillOutput 缺失 → 返回 null（降级，caller 走 fallback）', () => {
    const result = resolveHumanGateAdvancedSummary({
      params: { summaryKind: 'spec', artifactPath: '/x.md', round: 1 },
      readFile: () => SAMPLE_SPEC_MD,
    })
    expect(result).toBeNull()
  })

  it('summaryKind=spec + artifactPath 缺失 → readFile 不调用，specMdContent 为空字符串', () => {
    const skillOutput = loadSpecFixture('v3-full.json')
    let readCalled = false
    const result = resolveHumanGateAdvancedSummary({
      params: { summaryKind: 'spec', skillOutput, round: 1 },
      readFile: () => {
        readCalled = true
        return SAMPLE_SPEC_MD
      },
    })
    expect(readCalled).toBe(false)
    expect(result).not.toBeNull()
    expect(result!.web).toContain('Spec 评审 · 第 1 轮')
  })
  it('summaryKind=spec → 输出含完整 spec.md 折叠区（<details><summary>📄 ...）', () => {
    const skillOutput = loadSpecFixture('v3-full.json')
    const specMd = '# 我的 Spec\n\n## 1. 背景\n这是真实 spec 内容\n\n## 2. AC\n- AC-1 验收\n'
    const result = resolveHumanGateAdvancedSummary({
      params: {
        summaryKind: 'spec',
        skillOutput,
        artifactPath: '/abs/path/to/spec.md',
        round: 1,
      },
      readFile: () => specMd,
    })
    expect(result).not.toBeNull()
    // <details ... open> 折叠区（小文件默认展开）
    expect(result!.web).toMatch(/<details\s+open><summary>📄 .*<\/summary>/)
    // 包含 spec.md 原文
    expect(result!.web).toContain('## 1. 背景')
    expect(result!.web).toContain('这是真实 spec 内容')
    expect(result!.web).toContain('AC-1 验收')
  })
  it('summaryKind=spec + skillOutput 是 JSON string（模板插值产物）→ 自动 parse 并 build summary', () => {
    const skillOutput = loadSpecFixture('v3-full.json')
    const skillOutputAsString = JSON.stringify(skillOutput)
    const result = resolveHumanGateAdvancedSummary({
      params: {
        summaryKind: 'spec',
        skillOutput: skillOutputAsString,
        artifactPath: '/abs/path/to/spec.md',
        round: 1,
      },
      readFile: () => '# Spec\n\n## 1. 背景\n内容',
    })
    expect(result).not.toBeNull()
    expect(result!.web).toContain('Spec 评审 · 第 1 轮')
  })

  it('summaryKind=spec + skillOutput 是非法 JSON string → 返回 null', () => {
    const result = resolveHumanGateAdvancedSummary({
      params: {
        summaryKind: 'spec',
        skillOutput: 'not valid json {{{',
        artifactPath: '/x.md',
        round: 1,
      },
      readFile: () => '',
    })
    expect(result).toBeNull()
  })
})

describe('bootstrap.ts spec_human_gate wire-up', () => {
  it('spec_human_gate.params 含 summaryKind/skillOutput/artifactPath（让 buildHumanGateNode 调 buildSpecApprovalSummary）', () => {
    const graph = buildQuickImplGraph()
    const node = graph.nodes.find((n) => n.id === 'spec_human_gate')
    expect(node).toBeDefined()
    const params = (node as { params?: Record<string, unknown> }).params as Record<string, unknown>
    expect(params.summaryKind).toBe('spec')
    expect(params.skillOutput).toBe('{{steps.spec_author.output.skillOutput}}')
    expect(typeof params.artifactPath).toBe('string')
    expect(String(params.artifactPath)).toMatch(/docs\/specs\/qi-/)
    expect(String(params.artifactPath)).toMatch(/\{\{steps\.init_branch\.output\.worktreePath\}\}/)
  })
})

