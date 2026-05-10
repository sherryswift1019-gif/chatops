#!/usr/bin/env node
/**
 * qi-spec-lint: spec-author v3 输出 JSON 机械校验（12 条）
 *
 * L1: references[].file 路径白名单（无 ../ node_modules / 绝对路径）
 * L2: acceptanceCriteria[].id 唯一 + 匹配 /^AC-\d+$/
 * L3: acceptanceCriteria[].text 匹配 Given-When-Then 模式
 * L4: e2eScenarios.length ∈ [1,5] + ≥1 negative + ID kebab-case 唯一
 * L5: 每个 AC.id 都被某 scenarios.coversAC 引用
 * L6: scenarios.steps 反模式黑名单（"应该/正常/正确"等应然词）
 * L7: scenarios.acceptance 反模式黑名单（trim 后等于 "通过/成功/OK" 单字断言）
 * L8: risks.length ≥ 1 + 拒 desc 含"无明显风险"字样
 * L9: references file:line 在 worktree 存在 + 行号 ±5 行容忍（warn-only；需 --worktree）
 * L10: spec.md §4/§5/§7/§8 项数 == JSON 字段长度（需 --spec-md）
 * L11: clarifications 至少 1 条 kind="assumption"（v3 新；防全 fact 凑数）
 * L12: selfCheck.length ≤ 3 + 至少 1 条 item 含"最弱点/最不确定"关键词（v3 新）
 *
 * 用法：
 *   pnpm exec tsx scripts/qi-spec-lint.ts --spec docs/specs-out/qi-7.json
 *   pnpm exec tsx scripts/qi-spec-lint.ts --spec out.json \
 *     --spec-md docs/specs/qi-7.md --worktree /tmp/wt
 *   pnpm exec tsx scripts/qi-spec-lint.ts --spec out.json --report  # 非阻断 exit 0
 *   pnpm exec tsx scripts/qi-spec-lint.ts --spec out.json --json    # 机器可读
 *
 * 退出码：0=通过  1=有违规  2=配置错误
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

// =============================================================================
// CLI
// =============================================================================

function parseArgs() {
  const argv = process.argv.slice(2)
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  const specPath = get('--spec')
  if (!specPath) {
    console.error('[qi-spec-lint] --spec <path> is required')
    process.exit(2)
  }
  return {
    specPath: specPath!,
    specMdPath: get('--spec-md'),
    worktreePath: get('--worktree'),
    reportMode: argv.includes('--report'),
    jsonMode: argv.includes('--json'),
  }
}

// =============================================================================
// Types
// =============================================================================

interface AC { id: string; format?: string; text: string }
interface Risk { desc: string; severity: 'high' | 'medium' | 'low' }
interface Reference { file: string; line?: number; purpose: string }
interface Clarification {
  q: string; a: string
  kind?: 'fact' | 'assumption'
  userMayDisagreeIf?: string
}
interface E2eScenario {
  id: string
  name: string
  kind: 'happy' | 'negative'
  coversAC: string[]
  tags: string[]
  steps: string[]
  acceptance: string[]
}
interface SelfCheckItem {
  item: string
  passed?: boolean
  reason?: string
  answer?: string
}
interface SpecOutput {
  decision: 'pass' | 'fail' | 'reject_input'
  schemaVersion?: 'v2'
  acceptanceCriteria: AC[]
  risks: Risk[]
  references: Reference[]
  clarifications: Clarification[]
  e2eScenarios?: E2eScenario[]
  evidence: {
    selfCheck: SelfCheckItem[]
    standardsConsulted: unknown[]
  }
}

// =============================================================================
// Result
// =============================================================================

interface Issue { code: string; message: string }
const errors: Issue[] = []
const warnings: Issue[] = []

function fail(code: string, message: string) { errors.push({ code, message }) }
function warn(code: string, message: string) { warnings.push({ code, message }) }

// =============================================================================
// L1: Path whitelist (for references[].file)
// =============================================================================

const ALLOWED: RegExp[] = [
  /^src\/.+\.(ts|tsx|sql)$/,
  /^web\/src\/.+\.(ts|tsx|css)$/,
  /^scripts\/.+\.(ts|sh)$/,
  /^docs\/.+\.md$/,
  /^\.gitlab-ci\.yml$/,
  /^Dockerfile(\..*)?$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig.*\.json$/,
  /^vitest\.config\.(ts|js)$/,
  /^vite\.config\.(ts|js)$/,
]
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\.\./, 'path traversal (..)'],
  [/node_modules/, 'node_modules/'],
  [/\.git\//, '.git/'],
  [/^\//, 'absolute path'],
  [/^~/, '~-relative path'],
  [/^[A-Za-z]:\\/, 'Windows absolute path'],
]

function checkPath(p: string, ctx: string) {
  for (const [pat, desc] of FORBIDDEN) {
    if (pat.test(p)) { fail('L1', `${ctx}: forbidden ${desc}: "${p}"`); return }
  }
  if (!ALLOWED.some((r) => r.test(p))) {
    fail('L1', `${ctx}: not in whitelist: "${p}"`)
  }
}

function checkL1(spec: SpecOutput) {
  for (const r of spec.references ?? []) checkPath(r.file, `references[].file`)
}

// =============================================================================
// L2: AC id 唯一 + format
// =============================================================================

function checkL2(spec: SpecOutput) {
  const seen = new Set<string>()
  for (const ac of spec.acceptanceCriteria ?? []) {
    if (!/^AC-\d+$/.test(ac.id)) fail('L2', `acceptanceCriteria[]: invalid id "${ac.id}" (must match /^AC-\\d+$/)`)
    if (seen.has(ac.id)) fail('L2', `acceptanceCriteria[]: duplicate id "${ac.id}"`)
    seen.add(ac.id)
  }
}

// =============================================================================
// L3: AC text Given-When-Then 格式
// =============================================================================

const GWT_PATTERN = /^Given .+[,，]\s*When .+[,，]\s*Then /

function checkL3(spec: SpecOutput) {
  for (const ac of spec.acceptanceCriteria ?? []) {
    if (!GWT_PATTERN.test(ac.text)) {
      fail('L3', `${ac.id}: text does not match Given-When-Then format: "${ac.text.slice(0, 60)}..."`)
    }
  }
}

// =============================================================================
// L4: e2eScenarios 数量 + negative + ID kebab-case + 唯一
// =============================================================================

const KEBAB_PATTERN = /^[a-z][a-z0-9-]+$/

function checkL4(spec: SpecOutput) {
  const scenarios = spec.e2eScenarios
  if (!scenarios || scenarios.length === 0) {
    fail('L4', 'e2eScenarios is empty (must have ≥1 scenario)')
    return
  }
  if (scenarios.length > 5) {
    fail('L4', `e2eScenarios.length=${scenarios.length} exceeds max 5 (防 LLM 凑数)`)
  }
  if (!scenarios.some((s) => s.kind === 'negative')) {
    fail('L4', 'e2eScenarios must include ≥1 negative scenario (error/permission/boundary)')
  }
  const seen = new Set<string>()
  for (const s of scenarios) {
    if (!KEBAB_PATTERN.test(s.id)) {
      fail('L4', `scenario id "${s.id}" must be kebab-case (lowercase letters, digits, hyphens; starts with letter)`)
    }
    if (seen.has(s.id)) fail('L4', `duplicate scenario id: "${s.id}"`)
    seen.add(s.id)
  }
}

// =============================================================================
// L5: AC 全覆盖
// =============================================================================

function checkL5(spec: SpecOutput) {
  if (!spec.e2eScenarios || spec.e2eScenarios.length === 0) return  // L4 already failed
  const covered = new Set(spec.e2eScenarios.flatMap((s) => s.coversAC ?? []))
  for (const ac of spec.acceptanceCriteria ?? []) {
    if (!covered.has(ac.id)) fail('L5', `${ac.id} not covered by any scenarios.coversAC`)
  }
}

// =============================================================================
// L6: scenarios.steps 反模式黑名单（应然词）
// =============================================================================

// L6 反模式词：仅捕"应然语气"，不捕名词搭配
// "正确" 已从黑名单移除（"正确密码/账号/路径"等是合法描述，误杀率高）
const STEPS_ANTIPATTERNS = ['应该', '应当', '正常', '理论上']

function checkL6(spec: SpecOutput) {
  if (!spec.e2eScenarios) return
  for (const s of spec.e2eScenarios) {
    for (let i = 0; i < (s.steps ?? []).length; i++) {
      const step = s.steps[i]
      for (const word of STEPS_ANTIPATTERNS) {
        if (step.includes(word)) {
          fail('L6', `scenario "${s.id}" step ${i + 1} contains anti-pattern word "${word}": "${step.slice(0, 60)}..."`)
          break
        }
      }
    }
  }
}

// =============================================================================
// L7: scenarios.acceptance 反模式（trim 后等于单字断言）
// =============================================================================

const ACCEPTANCE_TRIVIAL = ['通过', '成功', 'OK', '正常', '完成']

function checkL7(spec: SpecOutput) {
  if (!spec.e2eScenarios) return
  for (const s of spec.e2eScenarios) {
    for (let i = 0; i < (s.acceptance ?? []).length; i++) {
      const a = s.acceptance[i].trim()
      if (ACCEPTANCE_TRIVIAL.some((w) => a === w || a === `${w}。` || a === `${w}.`)) {
        fail('L7', `scenario "${s.id}" acceptance ${i + 1} is trivial: "${a}" (must be observable assertion)`)
      }
    }
  }
}

// =============================================================================
// L8: risks 非空 + 拒"无明显风险"
// =============================================================================

const RISK_TRIVIAL_PATTERN = /无(明显|风险|任何)/

function checkL8(spec: SpecOutput) {
  if (!spec.risks || spec.risks.length === 0) {
    fail('L8', 'risks[] must have ≥1 entry (write OPEN_QUESTION instead if truly unknown)')
    return
  }
  for (const r of spec.risks) {
    if (RISK_TRIVIAL_PATTERN.test(r.desc)) {
      fail('L8', `risks[].desc "无明显风险" 类描述不可接受: "${r.desc}"`)
    }
  }
}

// =============================================================================
// L9: references file:line 在 worktree 存在 + 行号 ±5 容忍（warn-only）
// =============================================================================

function checkL9(spec: SpecOutput, wt: string) {
  for (const r of spec.references ?? []) {
    const fp = join(wt, r.file)
    if (!existsSync(fp)) {
      warn('L9', `references[].file "${r.file}" not found in worktree (OK if new)`)
      continue
    }
    if (r.line !== undefined) {
      if (r.line < 1) {
        warn('L9', `references "${r.file}": line ${r.line} < 1 (invalid)`)
        continue
      }
      try {
        const totalLines = readFileSync(fp, 'utf8').split('\n').length
        // ±5 行容忍：line 不能超过 totalLines + 5
        if (r.line > totalLines + 5) {
          warn('L9', `references "${r.file}:${r.line}": exceeds file length (${totalLines} lines) by >5`)
        }
      } catch {
        // file unreadable — skip silently
      }
    }
  }
}

// =============================================================================
// L10: spec.md §X 项数 == JSON 字段长度（需 --spec-md）
// =============================================================================

function countMdSection(md: string, sectionRe: RegExp, itemRe: RegExp): number | null {
  const secMatch = sectionRe.exec(md)
  if (!secMatch) return null
  const rest = md.slice(secMatch.index + secMatch[0].length)
  const nextSec = /^##\s/m.exec(rest)
  const section = nextSec ? rest.slice(0, nextSec.index) : rest
  return (section.match(itemRe) ?? []).length
}

function checkL10(md: string, spec: SpecOutput) {
  // §4 验收标准（"## 4. 验收标准"）
  const acCount = countMdSection(md, /^##\s+4[^#\n]*验收/m, /^- AC-\d+/gm)
  if (acCount === null) fail('L10', 'spec.md missing "## 4. 验收标准" section')
  else if (acCount !== spec.acceptanceCriteria.length) {
    fail('L10', `spec.md §4 AC count (${acCount}) ≠ JSON.acceptanceCriteria.length (${spec.acceptanceCriteria.length})`)
  }

  // §5 E2E Scenario（"## 5. E2E"）— 数 "### Scenario" 子标题
  if (spec.e2eScenarios) {
    const scenCount = countMdSection(md, /^##\s+5[^#\n]*E2E/m, /^###\s+Scenario\s+/gm)
    if (scenCount === null) fail('L10', 'spec.md missing "## 5. E2E Scenario" section')
    else if (scenCount !== spec.e2eScenarios.length) {
      fail('L10', `spec.md §5 Scenario count (${scenCount}) ≠ JSON.e2eScenarios.length (${spec.e2eScenarios.length})`)
    }
  }

  // §7 技术说明 — 数 file: 引用行（每条 reference 至少一行）
  // 由于 §7 自由文本格式不固定，仅 sanity check 章节存在
  if (!/^##\s+7[^#\n]*技术/m.test(md)) fail('L10', 'spec.md missing "## 7. 技术说明" section')

  // §8 风险 — 数"- 风险"开头的行
  const riskCount = countMdSection(md, /^##\s+8[^#\n]*风险/m, /^-\s+风险/gm)
  if (riskCount === null) fail('L10', 'spec.md missing "## 8. 风险与未知" section')
  else if (riskCount !== spec.risks.length) {
    fail('L10', `spec.md §8 risk count (${riskCount}) ≠ JSON.risks.length (${spec.risks.length})`)
  }
}

// =============================================================================
// L11: clarifications 至少 1 条 kind=assumption（v3）
// =============================================================================

function checkL11(spec: SpecOutput) {
  if (spec.schemaVersion !== 'v2') return  // v3 仅在 schemaVersion 显式 'v2' 时强校验
  const clarifs = spec.clarifications ?? []
  if (clarifs.length === 0) return  // 允许 trivial spec 无 clarifications
  if (!clarifs.some((c) => c.kind === 'assumption')) {
    fail('L11', 'v3: clarifications must include ≥1 entry with kind="assumption" (LLM 替用户做的默认决定)')
  }
}

// =============================================================================
// L12: selfCheck.length ≤ 3 + 至少 1 条 self-critique（v3）
// =============================================================================

const SELF_CRITIQUE_PATTERN = /最弱|最不确定|weakest|uncertain/i

function checkL12(spec: SpecOutput) {
  if (spec.schemaVersion !== 'v2') return  // v3 强校验仅 schemaVersion='v2' 触发
  const selfCheck = spec.evidence?.selfCheck ?? []
  if (selfCheck.length > 3) {
    fail('L12', `v3: selfCheck must have ≤3 items (got ${selfCheck.length}); move mechanical checks to qi-spec-lint`)
  }
  const hasCritique = selfCheck.some((sc) => SELF_CRITIQUE_PATTERN.test(sc.item ?? ''))
  if (!hasCritique && selfCheck.length > 0) {
    fail('L12', 'v3: selfCheck must include ≥1 self-critique item (e.g. "本 spec 最弱点?" / "最不确定的是?")')
  }
}

// =============================================================================
// Main
// =============================================================================

const args = parseArgs()

if (!existsSync(args.specPath)) {
  console.error(`[qi-spec-lint] spec file not found: ${args.specPath}`)
  process.exit(2)
}

let spec: SpecOutput
try {
  spec = JSON.parse(readFileSync(args.specPath, 'utf8')) as SpecOutput
} catch (e) {
  console.error(`[qi-spec-lint] failed to parse spec JSON: ${(e as Error).message}`)
  process.exit(2)
}

if (!Array.isArray(spec.acceptanceCriteria)) {
  console.error('[qi-spec-lint] spec JSON missing acceptanceCriteria[] array')
  process.exit(2)
}

// reject_input specs are intentionally minimal — lint doesn't apply
if (spec.decision === 'reject_input') {
  if (!args.jsonMode) console.log('[qi-spec-lint] decision=reject_input: skipping lint')
  process.exit(0)
}

checkL1(spec)
checkL2(spec)
checkL3(spec)
checkL4(spec)
checkL5(spec)
checkL6(spec)
checkL7(spec)
checkL8(spec)

if (args.worktreePath) {
  if (!existsSync(args.worktreePath)) warn('L9', `--worktree not found: ${args.worktreePath}`)
  else checkL9(spec, args.worktreePath)
} else if (!args.jsonMode) {
  console.log('[qi-spec-lint] --worktree not provided: skipping L9')
}

if (args.specMdPath) {
  if (!existsSync(args.specMdPath)) {
    warn('L10', `--spec-md not found: ${args.specMdPath}`)
  } else {
    checkL10(readFileSync(args.specMdPath, 'utf8'), spec)
  }
} else if (!args.jsonMode) {
  console.log('[qi-spec-lint] --spec-md not provided: skipping L10')
}

checkL11(spec)
checkL12(spec)

// =============================================================================
// Output
// =============================================================================

const ok = errors.length === 0

if (args.jsonMode) {
  console.log(JSON.stringify({
    ok,
    errors,
    warnings,
    meta: {
      spec: args.specPath,
      acceptanceCriteria: spec.acceptanceCriteria.length,
      risks: spec.risks?.length ?? 0,
      references: spec.references?.length ?? 0,
      e2eScenarios: spec.e2eScenarios?.length ?? 0,
      schemaVersion: spec.schemaVersion ?? 'pre-v3',
    },
  }, null, 2))
} else {
  console.log(`\n=== qi-spec-lint ===`)
  console.log(`  spec:           ${args.specPath}`)
  console.log(`  AC: ${spec.acceptanceCriteria.length}   risks: ${spec.risks?.length ?? 0}   references: ${spec.references?.length ?? 0}   scenarios: ${spec.e2eScenarios?.length ?? 0}`)
  console.log(`  schemaVersion:  ${spec.schemaVersion ?? 'pre-v3'}`)
  console.log(`  errors:         ${errors.length}   warnings: ${warnings.length}`)
  if (errors.length) { console.log('\nErrors:'); errors.forEach((e) => console.log(`  ✗ [${e.code}] ${e.message}`)) }
  if (warnings.length) { console.log('\nWarnings:'); warnings.forEach((w) => console.log(`  ⚠ [${w.code}] ${w.message}`)) }
  console.log(ok ? '\n✓ All checks passed' : args.reportMode ? `\n(--report) exit 0 despite ${errors.length} error(s)` : '\n✗ Lint failed')
}

process.exit(ok ? 0 : args.reportMode ? 0 : 1)
