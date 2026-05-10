#!/usr/bin/env node
/**
 * qi-plan-lint: plan-decomposer v3 输出 JSON 机械校验（9 条）
 *
 * L1: tasks[].files / migrations[].file 路径白名单（无 ../ node_modules / 绝对路径）
 * L2: tasks[].dependsOn 引用的 ID 必须在本 plan tasks[] 中存在
 * L3: dependsOn DAG 无环（DFS）
 * L4: 每个 feature 任务有 ≥1 个 test 任务 dependsOn 它（estimatedLoc<10 降为 warn）
 * L5: migrations[].length == tasks.filter(type='migration').length
 * L6: spec 全部 AC 被 tasks[].coverAC 覆盖（需 --spec-json）
 * L7: plan.md §1 调研发现 有 ≥3 个 file:line 引用（需 --plan-md）
 * L8: plan.md 任务数 == JSON tasks[] 数（需 --plan-md）
 * L9: tasks[].files 在 worktree 存在（warn-only；需 --worktree）
 *
 * 用法：
 *   pnpm exec tsx scripts/qi-plan-lint.ts --plan docs/plans/qi-7.json
 *   pnpm exec tsx scripts/qi-plan-lint.ts --plan out.json \
 *     --spec-json spec-out.json --plan-md docs/plans/qi-7.md --worktree /tmp/wt
 *   pnpm exec tsx scripts/qi-plan-lint.ts --plan out.json --report  # 非阻断 exit 0
 *   pnpm exec tsx scripts/qi-plan-lint.ts --plan out.json --json    # 机器可读
 *
 * 退出码：0=通过  1=有违规  2=配置错误
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// =============================================================================
// CLI
// =============================================================================

function parseArgs() {
  const argv = process.argv.slice(2)
  const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  const planPath = get('--plan')
  if (!planPath) {
    console.error('[qi-plan-lint] --plan <path> is required')
    process.exit(2)
  }
  return {
    planPath: planPath!,
    specJsonPath: get('--spec-json'),
    planMdPath: get('--plan-md'),
    worktreePath: get('--worktree'),
    reportMode: argv.includes('--report'),
    jsonMode: argv.includes('--json'),
  }
}

// =============================================================================
// Types
// =============================================================================

interface PlanTask {
  id: string
  type: 'feature' | 'test' | 'migration' | 'refactor' | 'chore'
  title: string
  files: string[]
  coverAC: string[]
  dependsOn: string[]
  estimatedLoc?: number
}

interface Migration { file: string }

interface PlanOutput {
  decision: 'pass' | 'fail' | 'reject_input'
  tasks: PlanTask[]
  migrations: Migration[]
}

interface SpecOutput {
  acceptanceCriteria: Array<{ id: string }>
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
// L1: Path whitelist
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

function checkL1(plan: PlanOutput) {
  for (const t of plan.tasks) for (const f of t.files ?? []) checkPath(f, `tasks[${t.id}].files`)
  for (const m of plan.migrations ?? []) checkPath(m.file, `migrations[].file`)
}

// =============================================================================
// L2: dependsOn references exist
// =============================================================================

function checkL2(plan: PlanOutput) {
  const ids = new Set(plan.tasks.map((t) => t.id))
  for (const t of plan.tasks) {
    for (const dep of t.dependsOn ?? []) {
      if (!ids.has(dep)) fail('L2', `tasks[${t.id}].dependsOn references unknown task "${dep}"`)
    }
  }
}

// =============================================================================
// L3: DAG cycle detection
// =============================================================================

function checkL3(plan: PlanOutput) {
  const adj = new Map(plan.tasks.map((t) => [t.id, t.dependsOn ?? []]))
  const visited = new Set<string>()
  const stack = new Set<string>()
  let found = false

  const dfs = (id: string, path: string[]): boolean => {
    if (stack.has(id)) { fail('L3', `cycle: ${[...path, id].join(' → ')}`); found = true; return true }
    if (visited.has(id)) return false
    visited.add(id); stack.add(id)
    for (const d of adj.get(id) ?? []) if (dfs(d, [...path, id])) return true
    stack.delete(id); return false
  }

  for (const t of plan.tasks) if (!found) dfs(t.id, [])
}

// =============================================================================
// L4: feature → test coverage
// =============================================================================

function checkL4(plan: PlanOutput) {
  const testTasks = plan.tasks.filter((t) => t.type === 'test')
  for (const ft of plan.tasks.filter((t) => t.type === 'feature')) {
    if (!testTasks.some((t) => (t.dependsOn ?? []).includes(ft.id))) {
      if ((ft.estimatedLoc ?? Infinity) < 10)
        warn('L4', `tasks[${ft.id}] feature has no test task — OK if <10 LOC glue sharing parent commit`)
      else
        fail('L4', `tasks[${ft.id}] feature has no test task with it in dependsOn`)
    }
  }
}

// =============================================================================
// L5: migration tasks ↔ migrations[]
// =============================================================================

function checkL5(plan: PlanOutput) {
  const n = plan.tasks.filter((t) => t.type === 'migration').length
  const m = (plan.migrations ?? []).length
  if (n !== m) fail('L5', `${n} migration-type task(s) but ${m} entry(ies) in migrations[]`)
}

// =============================================================================
// L6: AC full coverage (requires --spec-json)
// =============================================================================

function checkL6(plan: PlanOutput, spec: SpecOutput) {
  const acIds = new Set((spec.acceptanceCriteria ?? []).map((ac) => ac.id))
  if (!acIds.size) { warn('L6', 'spec has no acceptanceCriteria — skipping'); return }
  const covered = new Set(plan.tasks.flatMap((t) => t.coverAC ?? []))
  for (const ac of acIds) if (!covered.has(ac)) fail('L6', `${ac} not covered by any task.coverAC`)
}

// =============================================================================
// L7: plan.md §1 调研发现 has ≥3 file:line links
// =============================================================================

function checkL7(md: string) {
  const secMatch = /^##\s+1[^#\n]*调研/m.exec(md)
  if (!secMatch) { fail('L7', 'plan.md missing "## 1. 调研发现" section'); return }
  const rest = md.slice(secMatch.index + secMatch[0].length)
  const nextSec = /^##\s/m.exec(rest)
  const section = nextSec ? rest.slice(0, nextSec.index) : rest
  const links = section.match(/\[[^\]]+\]\([^)]+#L\d+\)/g) ?? []
  if (links.length < 3)
    fail('L7', `plan.md §1 has ${links.length} file:line link(s) (need ≥3). Found: ${JSON.stringify(links)}`)
}

// =============================================================================
// L8: plan.md task count matches JSON tasks[]
// =============================================================================

function checkL8(md: string, plan: PlanOutput) {
  const lines = md.match(/^- \[[ x]\] (?:\*\*)?T\d+/gm) ?? []
  if (lines.length !== plan.tasks.length)
    fail('L8', `plan.md task count (${lines.length}) ≠ JSON tasks[].length (${plan.tasks.length})`)
}

// =============================================================================
// L9: file existence in worktree (warn-only)
// =============================================================================

function checkL9(plan: PlanOutput, wt: string) {
  for (const t of plan.tasks)
    for (const f of t.files ?? [])
      if (!existsSync(join(wt, f))) warn('L9', `tasks[${t.id}]: "${f}" not found in worktree (OK if new)`)
  for (const m of plan.migrations ?? [])
    if (!existsSync(join(wt, m.file))) warn('L9', `migrations[]: "${m.file}" not found in worktree (OK if new)`)
}

// =============================================================================
// Main
// =============================================================================

const args = parseArgs()

if (!existsSync(args.planPath)) {
  console.error(`[qi-plan-lint] plan file not found: ${args.planPath}`)
  process.exit(2)
}

let plan: PlanOutput
try {
  plan = JSON.parse(readFileSync(args.planPath, 'utf8')) as PlanOutput
} catch (e) {
  console.error(`[qi-plan-lint] failed to parse plan JSON: ${(e as Error).message}`)
  process.exit(2)
}

if (!Array.isArray(plan.tasks)) {
  console.error('[qi-plan-lint] plan JSON missing tasks[] array')
  process.exit(2)
}
plan.migrations ??= []

// reject_input plans are intentionally empty — lint doesn't apply
if (plan.decision === 'reject_input') {
  if (!args.jsonMode) console.log('[qi-plan-lint] decision=reject_input: skipping lint')
  process.exit(0)
}

checkL1(plan)
checkL2(plan)
checkL3(plan)
checkL4(plan)
checkL5(plan)

if (args.specJsonPath) {
  if (!existsSync(args.specJsonPath)) {
    warn('L6', `--spec-json not found: ${args.specJsonPath}`)
  } else {
    try {
      checkL6(plan, JSON.parse(readFileSync(args.specJsonPath, 'utf8')) as SpecOutput)
    } catch (e) {
      warn('L6', `failed to parse spec JSON: ${(e as Error).message}`)
    }
  }
} else if (!args.jsonMode) {
  console.log('[qi-plan-lint] --spec-json not provided: skipping L6')
}

if (args.planMdPath) {
  if (!existsSync(args.planMdPath)) {
    warn('L7', `--plan-md not found: ${args.planMdPath}`)
  } else {
    const md = readFileSync(args.planMdPath, 'utf8')
    checkL7(md)
    checkL8(md, plan)
  }
} else if (!args.jsonMode) {
  console.log('[qi-plan-lint] --plan-md not provided: skipping L7/L8')
}

if (args.worktreePath) {
  if (!existsSync(args.worktreePath)) warn('L9', `--worktree not found: ${args.worktreePath}`)
  else checkL9(plan, args.worktreePath)
} else if (!args.jsonMode) {
  console.log('[qi-plan-lint] --worktree not provided: skipping L9')
}

// =============================================================================
// Output
// =============================================================================

const ok = errors.length === 0

if (args.jsonMode) {
  console.log(JSON.stringify({
    ok,
    errors,
    warnings,
    meta: { plan: args.planPath, tasks: plan.tasks.length, migrations: plan.migrations.length },
  }, null, 2))
} else {
  console.log(`\n=== qi-plan-lint ===`)
  console.log(`  plan:      ${args.planPath}`)
  console.log(`  tasks:     ${plan.tasks.length}   migrations: ${plan.migrations.length}`)
  console.log(`  errors:    ${errors.length}   warnings: ${warnings.length}`)
  if (errors.length) { console.log('\nErrors:'); errors.forEach((e) => console.log(`  ✗ [${e.code}] ${e.message}`)) }
  if (warnings.length) { console.log('\nWarnings:'); warnings.forEach((w) => console.log(`  ⚠ [${w.code}] ${w.message}`)) }
  console.log(ok ? '\n✓ All checks passed' : args.reportMode ? `\n(--report) exit 0 despite ${errors.length} error(s)` : '\n✗ Lint failed')
}

process.exit(ok ? 0 : args.reportMode ? 0 : 1)
