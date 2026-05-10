import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

vi.setConfig({ testTimeout: 30000 })

const __filename = fileURLToPath(import.meta.url)
const PROJECT_ROOT = join(dirname(__filename), '..', '..', '..')
const LINT_SCRIPT = join(PROJECT_ROOT, 'scripts', 'qi-spec-lint.ts')
const FIXTURE_DIR = join(dirname(__filename), '..', 'fixtures', 'spec-author')

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'qi-spec-lint-test-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/** 跑 lint 返回 {exitCode, json} */
function runLint(specObj: unknown, extraFlags: string[] = []): { exitCode: number; json: any } {
  const specPath = join(tmpDir, `spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(specPath, JSON.stringify(specObj))
  let stdout = ''
  let exitCode = 0
  try {
    stdout = execSync(`pnpm exec tsx ${LINT_SCRIPT} --spec ${specPath} --json ${extraFlags.join(' ')}`, {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    exitCode = err.status ?? 1
    stdout = err.stdout?.toString() ?? ''
  }
  const json = stdout.trim() ? JSON.parse(stdout) : null
  return { exitCode, json }
}

/** 最小合法 v3 base，测试时 override 单字段 */
function baseSpec(): Record<string, unknown> {
  return {
    schemaVersion: 'v2',
    summary: 'test',
    decision: 'pass',
    notes: [],
    confidenceLevel: 'high',
    reviewHints: [],
    noGos: [],
    evidence: {
      standardsConsulted: [],
      selfCheck: [{ item: '本 spec 最弱点', answer: 'X' }],
    },
    acceptanceCriteria: [
      { id: 'AC-1', format: 'given-when-then', text: 'Given 用户访问，When 加载，Then 显示 banner' },
    ],
    openQuestions: [],
    risks: [{ desc: '可能影响 SEO', severity: 'low' }],
    references: [{ file: 'web/src/components/Banner.tsx', line: 1, purpose: '主组件' }],
    clarifications: [
      { kind: 'assumption', q: '是否 i18n？', a: '默认中文', userMayDisagreeIf: '需要英文' },
    ],
    e2eScenarios: [
      {
        id: 'happy-1', name: 'happy', kind: 'happy', coversAC: ['AC-1'], tags: [],
        steps: ['打开 / 首页', '等待 [data-testid=banner] 元素出现'],
        acceptance: ['[data-testid=banner] 文本等于 Welcome'],
      },
      {
        id: 'negative-1', name: 'neg', kind: 'negative', coversAC: ['AC-1'], tags: [],
        steps: ['拦截资源返回 503', '打开 / 首页'],
        acceptance: ['页面不抛 React error', '[data-testid=banner] 元素存在'],
      },
    ],
  }
}

describe('qi-spec-lint', () => {
  it('baseline 合法 v3 spec → exit 0 + ok=true', () => {
    const { exitCode, json } = runLint(baseSpec())
    expect(exitCode).toBe(0)
    expect(json.ok).toBe(true)
  })

  describe('L1 path whitelist', () => {
    it('L1: 拒 references[].file = ../etc/passwd', () => {
      const spec = baseSpec()
      ;(spec.references as Array<{ file: string }>)[0].file = '../etc/passwd'
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L1')).toBe(true)
    })

    it('L1: 接受 src/foo.ts', () => {
      const spec = baseSpec()
      ;(spec.references as Array<{ file: string; line?: number }>)[0] = {
        file: 'src/foo.ts', line: 1, purpose: 'x',
      } as any
      const { exitCode } = runLint(spec, ['--report']) // worktree 不传 → L9 不跑；--report 兜底 L9 warn
      expect(exitCode).toBe(0)
    })
  })

  describe('L2 AC id', () => {
    it('L2: 重复 AC id 触发 fail', () => {
      const spec = baseSpec()
      spec.acceptanceCriteria = [
        { id: 'AC-1', text: 'Given x，When y，Then z' },
        { id: 'AC-1', text: 'Given a，When b，Then c' },
      ]
      ;(spec.e2eScenarios as Array<{ coversAC: string[] }>).forEach((s) => (s.coversAC = ['AC-1']))
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L2')).toBe(true)
    })
  })

  describe('L3 GWT 格式', () => {
    it('L3: AC text 缺 Given 触发 fail', () => {
      const spec = baseSpec()
      ;(spec.acceptanceCriteria as Array<{ text: string }>)[0].text = 'When x，Then y'
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L3')).toBe(true)
    })
  })

  describe('L4 e2eScenarios', () => {
    it('L4: 无 negative scenario 触发 fail', () => {
      const spec = baseSpec()
      ;(spec.e2eScenarios as Array<{ kind: string }>).forEach((s) => (s.kind = 'happy'))
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L4' && e.message.includes('negative'))).toBe(true)
    })

    it('L4: ID 非 kebab-case 触发 fail（如 "badID"）', () => {
      const spec = baseSpec()
      ;(spec.e2eScenarios as Array<{ id: string }>)[0].id = 'badID'
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L4' && e.message.includes('kebab-case'))).toBe(true)
    })
  })

  describe('L5 AC 全覆盖', () => {
    it('L5: AC-2 未被 scenario 覆盖 触发 fail', () => {
      const spec = baseSpec()
      spec.acceptanceCriteria = [
        ...(spec.acceptanceCriteria as any),
        { id: 'AC-2', text: 'Given a，When b，Then c' },
      ] as any
      // 现有 scenario 只 covers AC-1，AC-2 未被覆盖
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L5' && e.message.includes('AC-2'))).toBe(true)
    })
  })

  describe('L6 steps 反模式', () => {
    it('L6: scenarios.steps 含 "应该" 触发 fail', () => {
      const spec = baseSpec()
      ;(spec.e2eScenarios as Array<{ steps: string[] }>)[0].steps = ['用户应该登录']
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L6')).toBe(true)
    })
  })

  describe('L7 acceptance 反模式', () => {
    it('L7: acceptance "成功" 单字断言触发 fail', () => {
      const spec = baseSpec()
      ;(spec.e2eScenarios as Array<{ acceptance: string[] }>)[0].acceptance = ['成功']
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L7')).toBe(true)
    })
  })

  describe('L8 risks 非空', () => {
    it('L8: risks 含 "无明显风险" 触发 fail', () => {
      const spec = baseSpec()
      spec.risks = [{ desc: '无明显风险', severity: 'low' }]
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L8')).toBe(true)
    })
  })

  describe('L9 file:line worktree 校验', () => {
    it('L9: 行号超出文件总行数 + 5 触发 warn（warn-only）', () => {
      const spec = baseSpec()
      // 创建临时 worktree 含 1 行的 src/foo.ts
      const wt = join(tmpDir, `wt-${Date.now()}`)
      mkdirSync(join(wt, 'src'), { recursive: true })
      writeFileSync(join(wt, 'src/foo.ts'), 'line1\n')
      ;(spec.references as Array<{ file: string; line?: number }>)[0] = {
        file: 'src/foo.ts', line: 999, purpose: 'x',
      } as any
      const { exitCode, json } = runLint(spec, [`--worktree`, wt])
      expect(exitCode).toBe(0) // warn-only
      expect(json.warnings.some((w: any) => w.code === 'L9' && w.message.includes('exceeds'))).toBe(true)
    })

    it('L9: ±5 行容忍（line=6 vs file 总 1 行 → 不 warn）', () => {
      const spec = baseSpec()
      const wt = join(tmpDir, `wt-tolerate-${Date.now()}`)
      mkdirSync(join(wt, 'src'), { recursive: true })
      writeFileSync(join(wt, 'src/foo.ts'), 'line1\n')
      ;(spec.references as Array<{ file: string; line?: number }>)[0] = {
        file: 'src/foo.ts', line: 6, purpose: 'x',  // 1 + 5 = 6 边界
      } as any
      const { exitCode, json } = runLint(spec, [`--worktree`, wt])
      expect(exitCode).toBe(0)
      expect(json.warnings.some((w: any) => w.code === 'L9' && w.message.includes('exceeds'))).toBe(false)
    })
  })

  describe('L10 spec.md ↔ JSON 一致性', () => {
    it('L10: spec.md §4 AC count ≠ JSON.acceptanceCriteria.length 触发 fail', () => {
      const spec = baseSpec()
      // spec 有 1 条 AC，但 spec.md §4 写了 3 条
      const mdPath = join(tmpDir, `spec-md-${Date.now()}.md`)
      const md = `# Spec

## 4. 验收标准
- AC-1: foo
- AC-2: bar
- AC-3: baz

## 5. E2E
### Scenario S-1
### Scenario S-2

## 7. 技术说明
内容

## 8. 风险与未知
- 风险 1: x
`
      writeFileSync(mdPath, md)
      const { exitCode, json } = runLint(spec, [`--spec-md`, mdPath])
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L10' && e.message.includes('AC count'))).toBe(true)
    })
  })

  describe('L11 clarifications kind=assumption (v3)', () => {
    it('L11: clarifications 全 fact 触发 fail', () => {
      const spec = baseSpec()
      spec.clarifications = [
        { kind: 'fact', q: 'x', a: 'y' },
        { kind: 'fact', q: 'a', a: 'b' },
      ]
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L11')).toBe(true)
    })
  })

  describe('L12 selfCheck (v3)', () => {
    it('L12: selfCheck.length = 4 触发 fail（>3 上限）', () => {
      const spec = baseSpec()
      ;(spec.evidence as { selfCheck: unknown[] }).selfCheck = [
        { item: '本 spec 最弱点', answer: 'X' },
        { item: 'AC GWT', passed: true },
        { item: 'refs ≥ 1', passed: true },
        { item: '5 维度齐全', passed: true },
      ]
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L12' && e.message.includes('≤3'))).toBe(true)
    })

    it('L12: selfCheck 缺最弱点关键词触发 fail', () => {
      const spec = baseSpec()
      ;(spec.evidence as { selfCheck: unknown[] }).selfCheck = [
        { item: 'AC 用 GWT 格式', passed: true },
      ]
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(1)
      expect(json.errors.some((e: any) => e.code === 'L12' && e.message.includes('self-critique'))).toBe(true)
    })
  })

  describe('CLI 模式', () => {
    it('--report 模式：有错误时仍 exit 0', () => {
      const spec = baseSpec()
      ;(spec.acceptanceCriteria as Array<{ text: string }>)[0].text = 'When x，Then y'  // L3 fail
      const { exitCode, json } = runLint(spec, ['--report'])
      expect(exitCode).toBe(0)
      expect(json.ok).toBe(false)
      expect(json.errors.length).toBeGreaterThan(0)
    })

    it('--json 模式 stdout 是合法 JSON 含 ok/errors/warnings/meta', () => {
      const { json } = runLint(baseSpec())
      expect(json).toHaveProperty('ok')
      expect(json).toHaveProperty('errors')
      expect(json).toHaveProperty('warnings')
      expect(json).toHaveProperty('meta')
      expect(json.meta).toHaveProperty('schemaVersion')
    })
  })

  describe('schemaVersion 兼容性', () => {
    it('schemaVersion 缺失（v2 in-flight 老数据）跳过 L11/L12', () => {
      const spec = baseSpec()
      delete (spec as Record<string, unknown>).schemaVersion
      // selfCheck 7 条机械 + clarifications 全 fact —— 老数据预期
      ;(spec.evidence as { selfCheck: unknown[] }).selfCheck = [
        { item: 'AC GWT', passed: true },
        { item: 'refs', passed: true },
        { item: '5 维度', passed: true },
        { item: '风险非空', passed: true },
      ]
      spec.clarifications = [{ kind: 'fact', q: 'x', a: 'y' }]
      const { exitCode, json } = runLint(spec)
      expect(exitCode).toBe(0)
      expect(json.errors.some((e: any) => e.code === 'L11' || e.code === 'L12')).toBe(false)
    })
  })
})
