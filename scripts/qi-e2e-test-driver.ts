#!/usr/bin/env -S pnpm exec tsx
/**
 * QI E2E Test 节点 — 真实端到端验证驱动器
 *
 * 用真 PG + 真 git + 真 deploy.sh + 真 Claude CLI + 真 Playwright，
 * 单独跑 qi_e2e_runner 节点的 4 个主场景。
 *
 * 用法：
 *   pnpm exec tsx scripts/qi-e2e-test-driver.ts <scenario>
 *   scenario: D | C | A | B | all
 */

import { existsSync, readFileSync, copyFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

// ─── 测试参数 ─────────────────────────────────────────────────────────────
const REQUIREMENT_ID = 99999
const BRANCH = 'feat/qi-99999'
const TARGET_DIR = '/tmp/qi-e2e-test'
const WORKTREE = `${TARGET_DIR}/worktree/qi-${REQUIREMENT_ID}`
const BARE_REPO = `${TARGET_DIR}/bare/qi-mock.git`
const SANDBOX_BASE = `${TARGET_DIR}/sandboxes`
const PLAYBOOK_PASS = `${TARGET_DIR}/playbooks/qi-${REQUIREMENT_ID}-pass.yaml`
const PLAYBOOK_FAIL = `${TARGET_DIR}/playbooks/qi-${REQUIREMENT_ID}-fail.yaml`
const WORKTREE_PLAYBOOK = `${WORKTREE}/docs/test-playbooks/qi-${REQUIREMENT_ID}.yaml`

const CHROMIUM_MAC =
  '/Users/zhangshanshan/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'

// ─── 环境变量（必须在 import 业务模块前设置）──────────────────────────
process.env.CI ??= 'true' // 跳过 vitest globalSetup（这里不走 vitest，但保险）
process.env.DATABASE_URL ??= 'postgres://zhangshanshan@localhost:5432/chatops'
process.env.QI_SANDBOX_DIR_BASE = SANDBOX_BASE
process.env.PLAYWRIGHT_CHROMIUM_BIN = CHROMIUM_MAC
// 同步 Claude config（system_config.claude 里也读一份，但 env 优先）
// .env 里 BASE_URL/TOKEN 没设就让 chatops 从 system_config 读
process.env.NODE_ENV = 'development'

// ─── 业务模块 dynamic import（保证 env 已 set）─────────────────────────
const { getExecutor } = await import('../src/pipeline/node-types/registry.js')
await import('../src/pipeline/node-types/qi-e2e-runner.js')

// ─── 辅助函数 ─────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', bold: '\x1b[1m',
}
const log = (...a: unknown[]) => console.log(...a)
const banner = (s: string) => log(`\n${C.bold}${C.cyan}━━━ ${s} ━━━${C.reset}`)
const ok = (s: string) => log(`${C.green}✓${C.reset} ${s}`)
const ko = (s: string) => log(`${C.red}✗${C.reset} ${s}`)
const info = (s: string) => log(`${C.blue}ℹ${C.reset} ${s}`)

function setPlaybook(kind: 'none' | 'pass' | 'fail') {
  if (existsSync(WORKTREE_PLAYBOOK)) rmSync(WORKTREE_PLAYBOOK, { force: true })
  if (kind === 'none') return
  mkdirSync(join(WORKTREE, 'docs/test-playbooks'), { recursive: true })
  const src = kind === 'pass' ? PLAYBOOK_PASS : PLAYBOOK_FAIL
  copyFileSync(src, WORKTREE_PLAYBOOK)
  // commit 改动到 worktree（pushToBare 才能推到 bare）
  execSync(
    `git -c user.email=test@qi.local -c user.name="QI Test" add docs/test-playbooks/qi-${REQUIREMENT_ID}.yaml && ` +
    `git -c user.email=test@qi.local -c user.name="QI Test" commit -q --allow-empty -m "test(qi-${REQUIREMENT_ID}): switch playbook to ${kind}"`,
    { cwd: WORKTREE, stdio: 'pipe' },
  )
}

async function runNode(opts: {
  scenarioName: string
  envOverrides?: Record<string, string>
}): Promise<{ status: string; output: any; durationMs: number }> {
  const exec = getExecutor('qi_e2e_runner')
  if (!exec) throw new Error('qi_e2e_runner executor not registered')

  // 临时 env 注入（场景 C 用 QI_MOCK_PROVISION_FAIL）
  const savedEnv: Record<string, string | undefined> = {}
  if (opts.envOverrides) {
    for (const [k, v] of Object.entries(opts.envOverrides)) {
      savedEnv[k] = process.env[k]
      process.env[k] = v
    }
  }

  const start = Date.now()
  try {
    const result = await exec.execute(
      {
        requirementId: REQUIREMENT_ID,
        worktreePath: WORKTREE,
        branch: BRANCH,
        bareRepoPath: BARE_REPO,
      },
      {
        runId: -REQUIREMENT_ID,
        pipelineId: 0,
        nodeId: 'qi_e2e_runner',
        triggerParams: { requirementId: REQUIREMENT_ID },
        vars: {},
        steps: {},
      } as never,
    )
    return { ...result, durationMs: Date.now() - start } as never
  } finally {
    // 恢复 env
    if (opts.envOverrides) {
      for (const [k, original] of Object.entries(savedEnv)) {
        if (original === undefined) delete process.env[k]
        else process.env[k] = original
      }
    }
  }
}

function fmtResult(r: { status: string; output: any; durationMs: number }): void {
  const o = r.output
  log(`  ${C.bold}status${C.reset}:        ${r.status}`)
  log(`  ${C.bold}result${C.reset}:        ${o.result}${o.skipped ? ` ${C.yellow}(skipped)${C.reset}` : ''}`)
  log(`  ${C.bold}attempt${C.reset}:       ${o.attempt}`)
  log(`  ${C.bold}scenariosRun${C.reset}:  ${o.scenariosRun}`)
  log(`  ${C.bold}passed/failed${C.reset}: ${o.passed} / ${o.failed}`)
  log(`  ${C.bold}duration${C.reset}:      ${(r.durationMs / 1000).toFixed(1)}s`)
  if (o.sandboxError) log(`  ${C.red}sandboxError${C.reset}: ${o.sandboxError}`)
  if (o.failureReport) {
    log(`  ${C.bold}failureReport${C.reset}:`)
    log(`    total=${o.failureReport.total}, failed=${o.failureReport.failed}`)
    for (const s of o.failureReport.scenarios.slice(0, 5)) {
      log(`    - ${C.yellow}${s.id}${C.reset} (${s.result}): ${s.failureReason.slice(0, 200)}`)
      for (const a of s.failedAcceptances.slice(0, 3)) {
        log(`        ${a.kind}#${a.index}: expected=${JSON.stringify(a.expected)} actual=${JSON.stringify(a.actual)}`)
      }
    }
  }
}

// ─── 各场景定义 ────────────────────────────────────────────────────────
async function scenarioD() {
  banner('场景 D: 无 playbook → 应当 skip + result=pass')
  setPlaybook('none')
  const r = await runNode({ scenarioName: 'D' })
  fmtResult(r)
  const passed =
    r.status === 'success' && r.output.result === 'pass' && r.output.skipped === true
  passed ? ok('场景 D 符合预期') : ko('场景 D 不符合预期')
  return passed
}

async function scenarioC() {
  banner('场景 C: deploy.sh provision 故意 fail → 应当 result=sandbox_failed')
  setPlaybook('pass') // 有 playbook 才能进 provision 这步
  const r = await runNode({
    scenarioName: 'C',
    envOverrides: { QI_MOCK_PROVISION_FAIL: '1' },
  })
  fmtResult(r)
  const passed =
    r.status === 'failed' &&
    r.output.result === 'sandbox_failed' &&
    String(r.output.sandboxError ?? '').includes('simulated provision failure')
  passed ? ok('场景 C 符合预期') : ko('场景 C 不符合预期')
  return passed
}

async function scenarioA() {
  banner('场景 A: 真 Claude+Playwright，3 个 scenario 全 pass → result=pass')
  info('预计 15-30 分钟。每个 scenario 一个新 Claude 会话 + Playwright headless chrome。')
  setPlaybook('pass')
  const r = await runNode({ scenarioName: 'A' })
  fmtResult(r)
  const passed = r.status === 'success' && r.output.result === 'pass' && r.output.failed === 0
  passed ? ok('场景 A 符合预期') : ko('场景 A 不符合预期')
  return passed
}

async function scenarioB() {
  banner('场景 B: 真 Claude+Playwright，1 个故意 fail → result=fail + failureReport')
  info('预计 10-20 分钟。')
  setPlaybook('fail')
  const r = await runNode({ scenarioName: 'B' })
  fmtResult(r)
  const passed =
    r.status === 'success' &&
    r.output.result === 'fail' &&
    r.output.failed >= 1 &&
    r.output.failureReport?.scenarios?.some(
      (s: { id: string }) => s.id === 'login-impossible-redirect',
    )
  passed ? ok('场景 B 符合预期') : ko('场景 B 不符合预期')
  return passed
}

// ─── 入口 ──────────────────────────────────────────────────────────────
async function main() {
  const which = process.argv[2] || 'all'

  banner(`QI E2E 端到端验证 — scenario=${which}`)
  info(`requirementId=${REQUIREMENT_ID} branch=${BRANCH}`)
  info(`bare=${BARE_REPO}`)
  info(`worktree=${WORKTREE}`)
  info(`sandbox base=${SANDBOX_BASE}`)
  info(`chromium=${CHROMIUM_MAC.slice(0, 80)}...`)

  const results: Record<string, boolean> = {}

  if (which === 'D' || which === 'all') results.D = await scenarioD()
  if (which === 'C' || which === 'all') results.C = await scenarioC()
  if (which === 'A' || which === 'all') results.A = await scenarioA()
  if (which === 'B' || which === 'all') results.B = await scenarioB()

  banner('总结')
  for (const [k, v] of Object.entries(results)) {
    log(`  ${v ? C.green + '✓ PASS' : C.red + '✗ FAIL'}${C.reset}  scenario ${k}`)
  }
  const allOk = Object.values(results).every(Boolean)
  process.exit(allOk ? 0 : 1)
}

main().catch((err) => {
  console.error('\n[driver] uncaught error:', err)
  process.exit(2)
})
