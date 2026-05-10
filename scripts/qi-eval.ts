/**
 * Quick-Impl Role 评测脚本
 *
 * Phase 0 baseline / Phase 3 v2 对比 / Phase 5 regression CI 都用这个脚本。
 *
 * 用法：
 *   # dry-run：只准备 .qi-context、不调 Claude（验证脚本本身）
 *   pnpm exec tsx scripts/qi-eval.ts --role spec-author --case login-remember-me --mode v1
 *
 *   # 真跑（消耗 token）
 *   pnpm exec tsx scripts/qi-eval.ts --role spec-author --case login-remember-me --mode v1 --execute
 *
 *   # 指定上游输入（plan-decomposer 需要 spec 输出）
 *   pnpm exec tsx scripts/qi-eval.ts --role plan-decomposer --case login-remember-me --mode v1 \
 *     --input-from /tmp/qi-eval-spec-output.json --execute
 *
 * 设计 spec：docs/prds/quick-impl-roles-v2/05-evaluation.md §1
 *
 * 输出：
 *   docs/qi-eval-{date}-{role}-{mode}.json — 完整结果（含 rawOutput / parsed / token / 一致性校验）
 *   stdout — 概要（pass/fail + token 数 + 校验结果）
 *
 * 主观打分（5 项 × 1-5 分）由人工填写到 docs/qi-eval-baseline.md 报告模板，本脚本不自动打分。
 * Phase 5 接 LLM-as-judge：用 scripts/qi-eval-judge-prompt.md 二次跑 Claude 打分。
 */
import 'dotenv/config'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

import { fileURLToPath } from 'url'
import { dirname, resolve as pathResolve } from 'path'

import { runSkill } from '../src/quick-impl/skill-runner.js'
import { createProductionSkillExecutor } from '../src/quick-impl/skill-executor.js'
import { validateRoleOutput, type RoleName } from '../src/quick-impl/role-output-schemas.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const MCP_SERVER_TS = pathResolve(__dirname, '..', 'src', 'quick-impl', 'mcp-server.ts')

// =============================================================================
// CLI 解析（极简版，避免外部依赖）
// =============================================================================

interface CliArgs {
  role: string
  case: string
  mode: 'v1' | 'v2-compact' | 'v2-full'
  execute: boolean
  inputFrom?: string
  output?: string
  cleanup: boolean
  maxTurns: number
  timeoutMs: number
  noManifest: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {
    mode: 'v1',
    execute: false,
    cleanup: false,
    maxTurns: 60,
    timeoutMs: 600_000, // 10 min
    noManifest: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i]!
    const next = argv[i + 1]
    switch (v) {
      case '--role':       args.role = next; i++; break
      case '--case':       args.case = next; i++; break
      case '--mode':       args.mode = next as CliArgs['mode']; i++; break
      case '--input-from': args.inputFrom = next; i++; break
      case '--output':     args.output = next; i++; break
      case '--max-turns':  args.maxTurns = Number(next); i++; break
      case '--timeout-ms': args.timeoutMs = Number(next); i++; break
      case '--execute':    args.execute = true; break
      case '--cleanup':    args.cleanup = true; break
      case '--no-manifest': args.noManifest = true; break
      case '--help': case '-h':
        printUsage(); process.exit(0)
      default:
        if (v?.startsWith('--')) {
          console.error(`unknown flag: ${v}`)
          printUsage(); process.exit(1)
        }
    }
  }
  if (!args.role) { console.error('--role required'); process.exit(1) }
  if (!args.case) { console.error('--case required'); process.exit(1) }
  if (!['v1', 'v2-compact', 'v2-full'].includes(args.mode!)) {
    console.error(`--mode must be v1 | v2-compact | v2-full`); process.exit(1)
  }
  // --no-manifest 等价于 v2-full（一股脑模式），自动设环境变量
  if (args.noManifest) {
    process.env.QI_NO_MANIFEST = '1'
  }
  return args as CliArgs
}

function printUsage(): void {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 22).join('\n'))
}

// =============================================================================
// Case 定义（baseline 阶段只有 login-remember-me）
// =============================================================================

interface EvalCase {
  id: string
  rawInput: string
  /** 人工 gold-standard spec，做对照 */
  goldSpecPath?: string
}

const CASES: Record<string, EvalCase> = {
  'login-remember-me': {
    id: 'login-remember-me',
    rawInput: '给登录页加记住密码 checkbox：勾选后下次访问自动回填用户名（不存密码）',
    goldSpecPath: 'docs/test-specs/login-remember-me.md',
  },
}

function loadCase(id: string): EvalCase {
  const c = CASES[id]
  if (!c) {
    console.error(`unknown case: ${id}. available: ${Object.keys(CASES).join(', ')}`)
    process.exit(1)
  }
  return c
}

// =============================================================================
// Worktree 准备
// =============================================================================

interface WorktreeInfo {
  path: string
  branch: string
}

function prepareWorktree(caseId: string, role: string): WorktreeInfo {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const branch = `qi-eval/${caseId}-${role}-${ts}`
  const wtPath = join(tmpdir(), `qi-eval-${caseId}-${role}-${ts}`)
  if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true })

  // 当前 cwd = repo root
  console.log(`[qi-eval] creating worktree: ${wtPath} branch=${branch}`)
  execSync(`git worktree add -b ${branch} ${wtPath}`, { stdio: 'inherit' })
  return { path: wtPath, branch }
}

function cleanupWorktree(wt: WorktreeInfo): void {
  console.log(`[qi-eval] cleaning up worktree: ${wt.path}`)
  try {
    execSync(`git worktree remove --force ${wt.path}`, { stdio: 'inherit' })
    execSync(`git branch -D ${wt.branch}`, { stdio: 'inherit' })
  } catch (err) {
    console.warn(`[qi-eval] cleanup failed (may already be removed): ${err}`)
  }
}

// =============================================================================
// Inputs 构建（按 role 决定字段）
// =============================================================================

function buildInputs(args: CliArgs, evalCase: EvalCase): Record<string, unknown> {
  // v1 baseline：role 拿不到结构化字段，只有 rawInput / 路径
  // v2 mode：从 --input-from 读上游结构化输出（plan-decomposer / dev-loop / reviewer）
  switch (args.role) {
    case 'spec-author':
      return { rawInput: evalCase.rawInput }
    case 'plan-decomposer': {
      if (!args.inputFrom) {
        console.error('plan-decomposer needs --input-from <spec-output.json>')
        process.exit(1)
      }
      const upstream = JSON.parse(readFileSync(args.inputFrom!, 'utf8'))
      return {
        spec: upstream.artifactPath ?? upstream.specPath,
        specAcceptanceCriteria: upstream.acceptanceCriteria,
      }
    }
    case 'dev-loop': {
      if (!args.inputFrom) {
        console.error('dev-loop needs --input-from <plan-output.json>')
        process.exit(1)
      }
      const upstream = JSON.parse(readFileSync(args.inputFrom!, 'utf8'))
      return {
        plan: upstream.artifactPath ?? upstream.planPath,
        planTasks: upstream.tasks,
      }
    }
    case 'code-quality-reviewer': {
      if (!args.inputFrom) {
        console.error('code-quality-reviewer needs --input-from <plan-output.json>')
        process.exit(1)
      }
      const upstream = JSON.parse(readFileSync(args.inputFrom!, 'utf8'))
      return {
        specAcceptanceCriteria: upstream.specAcceptanceCriteria ?? [],
        planTasks: upstream.tasks ?? [],
        // branch 在上面 prepareWorktree 时已建
      }
    }
    default:
      console.error(`unknown role: ${args.role}`)
      process.exit(1)
  }
}

// =============================================================================
// 一致性校验（A4：spec.md AC 数量 vs JSON 字段）
// =============================================================================

interface ConsistencyResult {
  ok: boolean
  details: string[]
}

function checkArtifactConsistency(
  role: string,
  artifactPath: string,
  parsedOutput: { acceptanceCriteria?: unknown[]; tasks?: unknown[] },
): ConsistencyResult {
  const details: string[] = []
  if (!existsSync(artifactPath)) {
    return { ok: false, details: [`artifact not found: ${artifactPath}`] }
  }
  const content = readFileSync(artifactPath, 'utf8')

  if (role === 'spec-author') {
    // spec.md 第 4 节 "## 4. 验收标准" 后的列表项数量
    const acSection = content.match(/^## 4\. 验收标准[\s\S]*?(?=^## |\Z)/m)?.[0] ?? ''
    const acLines = (acSection.match(/^- /gm) ?? []).length
    const jsonAcs = parsedOutput.acceptanceCriteria?.length ?? 0
    if (acLines === jsonAcs) {
      details.push(`✓ spec.md AC count (${acLines}) === JSON.acceptanceCriteria.length (${jsonAcs})`)
    } else {
      details.push(`✗ spec.md AC count (${acLines}) !== JSON.acceptanceCriteria.length (${jsonAcs})`)
    }
    return { ok: acLines === jsonAcs, details }
  }

  if (role === 'plan-decomposer') {
    // plan.md 任务清单格式 `- [ ] N. ...`
    const taskLines = (content.match(/^- \[ \] \d+\./gm) ?? []).length
    const jsonTasks = parsedOutput.tasks?.length ?? 0
    if (taskLines === jsonTasks) {
      details.push(`✓ plan.md task count (${taskLines}) === JSON.tasks.length (${jsonTasks})`)
    } else {
      details.push(`✗ plan.md task count (${taskLines}) !== JSON.tasks.length (${jsonTasks})`)
    }
    return { ok: taskLines === jsonTasks, details }
  }

  // dev-loop / reviewer 没有 markdown artifact，跳过
  details.push(`(no artifact consistency check for role=${role})`)
  return { ok: true, details }
}

// =============================================================================
// 主流程
// =============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const evalCase = loadCase(args.case)
  const wt = prepareWorktree(args.case, args.role)

  const date = new Date().toISOString().slice(0, 10)
  const outputPath = args.output ?? `docs/qi-eval-${date}-${args.role}-${args.mode}.json`
  const artifactPath = join(wt.path, 'docs', `qi-eval-${args.role}.md`)
  mkdirSync(join(wt.path, 'docs'), { recursive: true })

  const inputs = buildInputs(args, evalCase)
  console.log(`[qi-eval] role=${args.role} case=${args.case} mode=${args.mode} execute=${args.execute}`)
  console.log(`[qi-eval] artifact_path=${artifactPath}`)
  console.log(`[qi-eval] inputs=${JSON.stringify(inputs).slice(0, 200)}...`)

  if (!args.execute) {
    console.log('\n[qi-eval] DRY RUN — script ready, .qi-context not yet prepared (runSkill not called).')
    console.log('[qi-eval] Add --execute to run for real (will consume Claude tokens).\n')
    if (args.cleanup) cleanupWorktree(wt)
    return
  }

  // 真跑
  const executor = createProductionSkillExecutor()
  const startedAt = Date.now()
  let result: Awaited<ReturnType<typeof runSkill>> | null = null
  let runError: { message: string; rawOutput?: string; stage?: string } | null = null
  try {
    result = await runSkill(
      {
        requirementId: 0, // eval 模式无 requirement 记录
        nodeId: `qi-eval-${args.role}`,
        skill: 'quick-impl-artifact-author',
        role: args.role,
        worktreePath: wt.path,
        branch: wt.branch,
        baseBranch: 'main',
        artifactPath,
        inputs,
        maxTurns: args.maxTurns,
        timeoutMs: args.timeoutMs,
      },
      executor,
      MCP_SERVER_TS,
    )
  } catch (err) {
    // baseline 评测期间 v1 输出 JSON 可能不规范（schema/解析失败）。这是 baseline 数据点，不要 hard exit。
    const e = err as Error & { stage?: string }
    const msg = e?.message ?? String(err)
    // 从错误信息里抠出 "raw output (last 500 chars)" 段
    const rawMatch = msg.match(/--- raw output \(last 500 chars\) ---\n([\s\S]*)$/)
    runError = {
      message: msg,
      rawOutput: rawMatch?.[1],
      stage: e?.stage,
    }
    console.error(`[qi-eval] runSkill failed (continuing to write report): ${msg.split('\n')[0]}`)
  }

  const totalMs = Date.now() - startedAt
  if (result) {
    console.log(`\n[qi-eval] runSkill done in ${totalMs}ms`)
    console.log(`[qi-eval] tokens: input=${result.inputTokens} output=${result.outputTokens}`)
    console.log(`[qi-eval] decision=${result.output.decision ?? 'pass'}`)
    console.log(`[qi-eval] summary=${result.output.summary}\n`)
  } else {
    console.log(`\n[qi-eval] runSkill failed in ${totalMs}ms — falling back to artifact-only report`)
  }

  // 一致性校验（A4）
  // 注：v1 阶段 parseSkillOutput 只解析 summary/decision/notes，没有 acceptanceCriteria/tasks 字段。
  // 用 raw output 的 fenced JSON 二次解析拿全字段。
  let extendedOutput: Record<string, unknown> = {}
  const rawOutputForParse = result?.rawOutput ?? runError?.rawOutput ?? ''
  try {
    const fenced = rawOutputForParse.match(/```\s*json\s*([\s\S]*?)```/g)
    if (fenced) {
      const last = fenced[fenced.length - 1]!
      extendedOutput = JSON.parse(last.replace(/```\s*json\s*/, '').replace(/```$/, ''))
    }
  } catch {
    // ignore，v1 baseline 没有扩展字段是正常的；JSON 不规范也吞掉
  }

  const consistency = checkArtifactConsistency(args.role, artifactPath, extendedOutput as { acceptanceCriteria?: unknown[]; tasks?: unknown[] })
  console.log(`[qi-eval] consistency check:`)
  consistency.details.forEach(d => console.log(`  ${d}`))

  // v2 schema 校验（Phase 2）：跑 zod schema 看结构化字段是否齐全
  const schemaResult = validateRoleOutput(args.role as RoleName, extendedOutput)
  console.log(`[qi-eval] schema validation: ${schemaResult.ok ? '✓ pass' : '✗ fail'}`)
  if (!schemaResult.ok) {
    schemaResult.errors.slice(0, 10).forEach((e) => console.log(`  ${e}`))
    if (schemaResult.errors.length > 10) console.log(`  ... and ${schemaResult.errors.length - 10} more`)
  }

  // 落盘报告（无论成功失败都落）
  const report = {
    meta: {
      date,
      role: args.role,
      case: args.case,
      mode: args.mode,
      worktreePath: wt.path,
      branch: wt.branch,
      durationMs: totalMs,
      inputTokens: result?.inputTokens ?? null,
      outputTokens: result?.outputTokens ?? null,
      runStatus: result ? 'ok' : 'parse_failed',
    },
    inputs,
    output: result?.output ?? null,
    extendedOutput,
    rawOutput: rawOutputForParse,
    runError,
    artifactPath,
    artifactContent: existsSync(artifactPath) ? readFileSync(artifactPath, 'utf8') : null,
    consistency,
    schemaValidation: schemaResult,
  }
  writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n[qi-eval] report written to ${outputPath}`)
  console.log(`[qi-eval] worktree kept at ${wt.path} (use --cleanup to remove)`)

  if (args.cleanup) cleanupWorktree(wt)
  if (runError) process.exitCode = 2 // 标记非零退出但允许 baseline 数据落盘
}

main().catch((err) => {
  console.error(err)
  process.exit(3)
})
