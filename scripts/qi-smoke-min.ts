#!/usr/bin/env -S pnpm exec tsx
/**
 * Quick-Impl 全流程最小烟测 — 给 AI 当固定测试入口用
 *
 * 提交一个最小需求（给 GET /health 返回里加 uptime 字段），启动它，
 * 自动 approve 沿途所有 waiter，轮询到 mr_open / merged / failed / aborted
 * 任一终态退出。
 *
 * 用法：
 *   pnpm exec tsx scripts/qi-smoke-min.ts            # 默认：自动 approve，跑到 mr_open
 *   pnpm exec tsx scripts/qi-smoke-min.ts --cleanup  # 终态后删除测试需求
 *   pnpm exec tsx scripts/qi-smoke-min.ts --no-auto-approve  # 等真人审
 *   pnpm exec tsx scripts/qi-smoke-min.ts --dry-run  # 只验证 server 可达 + 登录成功，不真跑
 *
 * 环境变量：
 *   QI_ADMIN_BASE_URL    默认 http://localhost:3000/admin（后端 API，不是浏览器 URL）
 *   QI_ADMIN_USER        默认 admin
 *   QI_ADMIN_PASSWORD    默认 admin（生产是 Paraview2026）
 *   QI_GITLAB_PROJECT    默认 PAM/devops/chatops
 *   QI_BASE_BRANCH       默认 main
 *   QI_POLL_INTERVAL_MS  默认 5000
 *   QI_POLL_TIMEOUT_MS   默认 1800000（30 分钟）
 *
 * ⚠️ 端口区分（很容易搞错）：
 *   :3000  后端 Fastify — admin API / /health，脚本用这个调 API
 *   :5173  前端 Vite dev server — 真人在浏览器审批走这个
 *          （vite proxy 会把 /admin/* 转发到 :3000，cookie 体系独立于脚本）
 *   --no-auto-approve 模式下，提示真人去 http://localhost:5173 审批，不是 :3000
 *
 * Exit codes:
 *   0 — 跑到 mr_open 或 merged
 *   1 — 跑到 failed / aborted
 *   2 — 超时（QI_POLL_TIMEOUT_MS）
 *   3 — 网络 / 登录 / 提交失败
 */

import { setTimeout as sleep } from 'timers/promises'

// ─── 配置 ──────────────────────────────────────────────────────────────
const BASE_URL = (process.env.QI_ADMIN_BASE_URL ?? 'http://localhost:3000/admin').replace(/\/+$/, '')
const ADMIN_USER = process.env.QI_ADMIN_USER ?? 'admin'
const ADMIN_PASSWORD = process.env.QI_ADMIN_PASSWORD ?? 'admin'
const GITLAB_PROJECT = process.env.QI_GITLAB_PROJECT ?? 'PAM/devops/chatops'
const BASE_BRANCH = process.env.QI_BASE_BRANCH ?? 'main'
const POLL_INTERVAL_MS = Number(process.env.QI_POLL_INTERVAL_MS ?? 5000)
const POLL_TIMEOUT_MS = Number(process.env.QI_POLL_TIMEOUT_MS ?? 30 * 60 * 1000)

const ARGS = new Set(process.argv.slice(2))
const CLEANUP = ARGS.has('--cleanup')
const NO_AUTO_APPROVE = ARGS.has('--no-auto-approve')
const DRY_RUN = ARGS.has('--dry-run')

// ─── 最小需求（写死）— 改 /health 返回，加 uptime 字段 ───────────────
const REQUIREMENT_TITLE = '/health 接口返回进程运行时长'
const REQUIREMENT_RAW_INPUT = [
  '在现有 GET /health 接口的响应里增加一个 uptime 字段，',
  '类型为整数，单位为秒，值取自 process.uptime() 向下取整。',
  '原有的 status: "ok" 字段保持不变。',
  '补充一个单元测试断言响应同时包含 status: "ok" 和一个非负整数的 uptime。',
].join('')

// ─── console 工具 ──────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m', bold: '\x1b[1m',
}
const log = (...a: unknown[]) => console.log(...a)
const banner = (s: string) => log(`\n${C.bold}${C.cyan}━━━ ${s} ━━━${C.reset}`)
const ok = (s: string) => log(`${C.green}✓${C.reset} ${s}`)
const ko = (s: string) => log(`${C.red}✗${C.reset} ${s}`)
const info = (s: string) => log(`${C.blue}ℹ${C.reset} ${s}`)
const warn = (s: string) => log(`${C.yellow}!${C.reset} ${s}`)
const dim = (s: string) => log(`${C.gray}${s}${C.reset}`)

// ─── HTTP 客户端（手动管理 session cookie）────────────────────────────
let cookieJar = ''

async function http<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const url = `${BASE_URL}${path}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookieJar) headers.Cookie = cookieJar
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  // Node 19.7+: getSetCookie() 返回数组，避免逗号 split 误拆
  // （cookie attribute 里的 Expires=Wed, 09 May 2026... 自带逗号）
  const setCookies =
    typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])
  if (setCookies.length > 0) {
    cookieJar = setCookies.map(c => c.split(';')[0].trim()).join('; ')
  }
  const text = await res.text()
  let parsed: unknown = text
  if (text && res.headers.get('content-type')?.includes('application/json')) {
    try { parsed = JSON.parse(text) } catch { /* keep text */ }
  }
  return { status: res.status, body: parsed as T }
}

async function login(): Promise<void> {
  const r = await http<{ ok?: boolean; error?: string }>('POST', '/auth/login', {
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
  })
  if (r.status !== 200) {
    throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`)
  }
  ok(`登录成功（${ADMIN_USER}）`)
}

// ─── 业务流程 ──────────────────────────────────────────────────────────
interface RequirementDetail {
  id: number
  status: string
  currentStage: string | null
  branch: string | null
  worktreePath: string | null
  pipelineRunId: number | null
  mrUrl: string | null
  abortReason: string | null
  specContent: string | null
  waiters: Array<{
    id: number
    approvalKind: string
    decisionSet: string
    round: number
    claimedBy: string | null
    decision: string | null
    contextSummary: string | null
  }>
  stageResults: unknown[] | null
}

async function createRequirement(): Promise<number> {
  const r = await http<{ id?: number; error?: string }>('POST', '/requirements', {
    title: REQUIREMENT_TITLE,
    rawInput: REQUIREMENT_RAW_INPUT,
    gitlabProject: GITLAB_PROJECT,
    baseBranch: BASE_BRANCH,
    createdBy: 'qi-smoke-min',
  })
  if (r.status !== 201 || typeof r.body?.id !== 'number') {
    throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`)
  }
  ok(`需求已创建 id=${r.body.id} (gitlabProject=${GITLAB_PROJECT}, baseBranch=${BASE_BRANCH})`)
  return r.body.id
}

async function startRequirement(id: number): Promise<void> {
  const r = await http('POST', `/requirements/${id}/run`)
  if (r.status !== 200) {
    throw new Error(`run failed: ${r.status} ${JSON.stringify(r.body)}`)
  }
  ok(`需求已切到 queued，worker 30s 内捡起`)
}

async function getDetail(id: number): Promise<RequirementDetail> {
  const r = await http<RequirementDetail>('GET', `/requirements/${id}`)
  if (r.status !== 200) {
    throw new Error(`get detail failed: ${r.status} ${JSON.stringify(r.body)}`)
  }
  return r.body
}

async function approveWaiter(reqId: number, waiterId: number, kind: string): Promise<void> {
  // spec / plan / final 都用 approved；escalation 用 force_passed 让流程继续
  const decision = kind === 'escalation' ? 'force_passed' : 'approved'
  const r = await http('POST', `/requirements/${reqId}/approvals/${waiterId}`, {
    decision,
    decidedBy: 'qi-smoke-min',
  })
  if (r.status !== 200) {
    warn(`approve waiter#${waiterId} (${kind}) 失败: ${r.status} ${JSON.stringify(r.body)}`)
    return
  }
  ok(`已自动审批 waiter#${waiterId} (${kind} → ${decision})`)
}

async function deleteRequirement(id: number): Promise<void> {
  const r = await http('DELETE', `/requirements/${id}`)
  if (r.status !== 204) {
    warn(`delete failed: ${r.status} ${JSON.stringify(r.body)}`)
    return
  }
  ok(`已清理需求 #${id}`)
}

const TERMINAL_OK = new Set(['mr_open', 'merged'])
const TERMINAL_BAD = new Set(['failed', 'aborted'])

async function pollUntilTerminal(id: number): Promise<RequirementDetail> {
  const start = Date.now()
  let lastStatus = ''
  let lastStage = ''
  let approvedWaiters = new Set<number>()

  while (true) {
    const elapsed = Date.now() - start
    if (elapsed > POLL_TIMEOUT_MS) {
      throw Object.assign(new Error(`轮询超时 ${(elapsed / 1000).toFixed(0)}s`), { code: 2 })
    }

    const d = await getDetail(id)
    if (d.status !== lastStatus || d.currentStage !== lastStage) {
      const ts = new Date().toISOString().slice(11, 19)
      info(`[${ts}] status=${d.status} stage=${d.currentStage ?? '-'} branch=${d.branch ?? '-'}`)
      lastStatus = d.status
      lastStage = d.currentStage ?? ''
    }

    // 自动 approve 没认领过的 waiter
    if (!NO_AUTO_APPROVE) {
      for (const w of d.waiters) {
        if (w.claimedBy === null && !approvedWaiters.has(w.id)) {
          approvedWaiters.add(w.id)
          await approveWaiter(id, w.id, w.approvalKind)
        }
      }
    } else {
      // 让真人去审；脚本只打印提醒
      for (const w of d.waiters) {
        if (w.claimedBy === null && !approvedWaiters.has(w.id)) {
          approvedWaiters.add(w.id)
          warn(`待审批 waiter#${w.id} (${w.approvalKind}) — 请到 http://localhost:5173 web UI 决策`)
        }
      }
    }

    if (TERMINAL_OK.has(d.status) || TERMINAL_BAD.has(d.status)) {
      return d
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

// ─── 入口 ──────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  banner('Quick-Impl 全流程最小烟测')
  info(`base url:        ${BASE_URL}`)
  info(`gitlab project:  ${GITLAB_PROJECT}@${BASE_BRANCH}`)
  info(`auto-approve:    ${NO_AUTO_APPROVE ? 'OFF（等真人）' : 'ON'}`)
  info(`cleanup on exit: ${CLEANUP ? 'ON' : 'OFF'}`)
  info(`poll: ${POLL_INTERVAL_MS}ms / timeout: ${(POLL_TIMEOUT_MS / 60000).toFixed(0)}min`)

  // Step 1: 登录
  banner('Step 1 — 登录 admin')
  await login()

  if (DRY_RUN) {
    ok('--dry-run：server 可达 + 登录成功，不提交需求')
    return 0
  }

  // Step 2: 提交需求
  banner('Step 2 — 提交最小需求')
  dim(`title:    ${REQUIREMENT_TITLE}`)
  dim(`rawInput: ${REQUIREMENT_RAW_INPUT}`)
  const reqId = await createRequirement()

  // Step 3: 启动
  banner('Step 3 — 启动需求（draft → queued）')
  await startRequirement(reqId)

  // Step 4: 轮询
  banner('Step 4 — 轮询全流程（自动审批 sp/ec/plan/final）')
  let detail: RequirementDetail
  try {
    detail = await pollUntilTerminal(reqId)
  } catch (err) {
    const e = err as Error & { code?: number }
    ko(`轮询失败：${e.message}`)
    if (CLEANUP) {
      banner('清理')
      try { await http('POST', `/requirements/${reqId}/abort`) } catch { /* ignore */ }
      await deleteRequirement(reqId).catch(() => {})
    }
    return e.code ?? 3
  }

  // Step 5: 总结
  banner('Step 5 — 终态')
  log(`  ${C.bold}id${C.reset}:           ${detail.id}`)
  log(`  ${C.bold}status${C.reset}:       ${detail.status}`)
  log(`  ${C.bold}currentStage${C.reset}: ${detail.currentStage ?? '-'}`)
  log(`  ${C.bold}branch${C.reset}:       ${detail.branch ?? '-'}`)
  log(`  ${C.bold}worktree${C.reset}:     ${detail.worktreePath ?? '-'}`)
  log(`  ${C.bold}mrUrl${C.reset}:        ${detail.mrUrl ?? '-'}`)
  if (detail.abortReason) log(`  ${C.bold}abortReason${C.reset}: ${detail.abortReason}`)
  if (detail.specContent) {
    log(`  ${C.bold}spec head${C.reset}:`)
    for (const line of detail.specContent.split('\n').slice(0, 8)) {
      dim(`    ${line}`)
    }
  }

  const isOk = TERMINAL_OK.has(detail.status)
  isOk ? ok(`流程跑通（${detail.status}）`) : ko(`流程未跑通（${detail.status}）`)

  if (CLEANUP) {
    banner('清理')
    await deleteRequirement(reqId).catch((e) => warn(`cleanup: ${(e as Error).message}`))
  } else {
    info(`未清理。手动删除：curl -X DELETE ${BASE_URL}/requirements/${reqId} -b 'session-cookie'`)
  }

  return isOk ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\n${C.red}[smoke] uncaught:${C.reset}`, err)
    process.exit(3)
  },
)
