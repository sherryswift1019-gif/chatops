# MR 状态定时对账（Reconciliation Job）实现计划

> **For agentic workers:** 按 TDD（先写失败测试 → 改代码 → 测试通过 → commit）节奏实施。每个 Task 独立 commit。

**Goal**：补救 GitLab webhook 漏发场景 —— 对所有 `pipeline_success` 态的 bug_analysis_reports，定时主动查 GitLab MR 真实 state，补齐 `lifecycle_sync` 事件并同步报告 `status` 到 `completed` / `aborted`。

**背景**：
- 现有实现 [issue-handler.ts](../../../src/adapters/gitlab/issue-handler.ts) 靠 webhook 被动同步 MR 状态，webhook 漏发时报告会永远停在 `pipeline_success`
- GitLab MR 有明确的终态：`state='merged'` / `'closed'`，可通过 REST API 随时回查
- 产品评审（2026-04-20）认为此问题在生产上线前必须解决

**关联文档（双向链接已就位）**：

| 文档 | 关联点 | 状态 |
|---|---|---|
| [specs/2026-04-19-bug-fix-workflow-v2-design.md](../specs/2026-04-19-bug-fix-workflow-v2-design.md) §5.3 | 状态转换代码位置对照表中加 reconciler 兜底行 + 双轨制说明 | ✅ 已改（plan 阶段） |
| [specs/2026-04-19-bug-fix-workflow-v2-design.md](../specs/2026-04-19-bug-fix-workflow-v2-design.md) §7.1 | `lifecycle_sync` 事件码扩展发起方 + 新增 `source` 字段 | ✅ 已改（plan 阶段） |
| [specs/2026-04-17-bug-fix-workflow-orchestration-design.md](../specs/2026-04-17-bug-fix-workflow-orchestration-design.md) §状态机 | 状态机 + 触发方列追加 reconciler 兜底路径 | ✅ 已改（plan 阶段） |
| [plans/2026-04-17-bug-fix-workflow-orchestration.md](2026-04-17-bug-fix-workflow-orchestration.md) Task 12 | 前向链接到本 plan（webhook 主路径的补丁说明） | ✅ 已改（plan 阶段） |
| [CLAUDE.md](../../../CLAUDE.md) 环境变量段 | 加 `MR_RECONCILE_*` 环境变量说明 | ⏳ Task 5 做 |

**Spec reference**：
- 相关 API：[GitLab API v4 - Merge Request single](https://docs.gitlab.com/ee/api/merge_requests.html#get-single-mr) `GET /projects/:id/merge_requests/:iid`
- 事件码表：v2 spec §7.1 `lifecycle_sync` 行（本 plan 为其新增 `source` 字段）

**Tech Stack 约束**：
- TypeScript / Fastify / pg driver（现有）
- **不装新依赖**：用现有 `p-limit`（C4 已装）+ `node-cron`（已有）或 `setInterval`（参照 `worktree/cleanup-scheduler.ts`）
- 严益昌原创代码零改动（executor / approval-manager / test-runs repo / test-pipelines repo 等）

---

## 实施前需要你确认的决策点

### D1. 调度频率
- [ ] **方案 A（推荐）**：每 15 分钟一次
- [ ] 方案 B：每 5 分钟一次（更实时但 GitLab 压力大）
- [ ] 方案 C：每 30 分钟一次（省资源但补救慢）

**建议理由**：webhook 漏发是小概率事件，5 分钟延迟能接受；GitLab API 每次调用限流是 600/min 级别，5 分钟扫一次远不到瓶颈。

### D2. 扫描窗口
- [ ] **方案 A（推荐）**：最近 7 天（`created_at > now() - 7d`）
- [ ] 方案 B：最近 30 天
- [ ] 方案 C：全扫（不限时间）

**建议理由**：超过 7 天的报告很大概率已被人工放弃（MR 长期不合并），对账也无意义；避免每次扫全表。

### D3. 并发
- [ ] **方案 A（推荐）**：`pLimit(3)`（和 analyzer 一致）
- [ ] 方案 B：串行一个个查
- [ ] 方案 C：`pLimit(10)` 加速

**建议理由**：和 [analyzer.ts C4 并发](../../../src/agent/analysis/analyzer.ts#L273) 保持一致，易于维护。

### D4. 配置可调
- [ ] **方案 A（推荐）**：写死默认值 + 环境变量覆盖（`MR_RECONCILE_INTERVAL_MS` / `MR_RECONCILE_WINDOW_DAYS` / `MR_RECONCILE_CONCURRENCY`）
- [ ] 方案 B：写死常量，不提供覆盖

**等你回 D1–D4 的选择（默认 A/A/A/A 可直接说 "全 A"），我再开始 Task 1。**

---

## File Structure

### 新建文件

| 路径 | 职责 |
|------|-----|
| `src/agent/reconcile/mr-state-reconciler.ts` | 对账核心逻辑 + setInterval 调度器 |
| `src/agent/analysis/gitlab-mr.ts` | `gitlabGetMr(projectPath, mrIid)` GitLab API 封装（参考现有 `gitlab-issue.ts` 结构） |
| `src/__tests__/unit/mr-state-reconciler.test.ts` | 对账逻辑单测 |
| `src/__tests__/integration/mr-reconciliation-flow.test.ts` | 端到端对账集成测试 |

### 修改文件（hanff 自有模块）

| 路径 | 改动要点 |
|------|---------|
| `src/server.ts` | 启动时 `startMrReconciler()`，关闭时 `stopMrReconciler()` |
| `CLAUDE.md` | 新增环境变量说明（`MR_RECONCILE_*`） |

### 零改动文件

- `src/pipeline/executor.ts` / `approval-manager.ts` / `webhook-waiter.ts`（严益昌原创）
- `src/adapters/gitlab/issue-handler.ts`（webhook 同步路径不动，对账只是兜底）
- `src/db/repositories/bug-analysis-reports.ts` / `bug-fix-events.ts`（调现有方法，不扩 repo）

---

## Task 1：`gitlabGetMr` API 封装

**Files:**
- Create: `src/agent/analysis/gitlab-mr.ts`

**Rationale**：对账需要查 MR state / merged_by / closed_by 字段。现有 `gitlab-issue.ts` 里已有 `gitlabGetIssue` / `gitlabUpdateIssue`，MR 相关应平行放在 `gitlab-mr.ts`。

- [ ] **Step 1：先写单测**（放在 `mr-state-reconciler.test.ts` 里 mock axios 即可，不单独建 gitlab-mr.test.ts）
- [ ] **Step 2：实现**

```typescript
// src/agent/analysis/gitlab-mr.ts
// 样式对齐现有 gitlab-issue.ts：使用 resolveGitlabConfig（DB 优先 + env fallback）
import axios from 'axios'
import { resolveGitlabConfig } from '../../config/gitlab.js'

export interface GitLabMr {
  iid: number
  state: 'opened' | 'closed' | 'merged' | 'locked'
  merged_at: string | null
  merged_by: { username: string; name: string } | null
  closed_at: string | null
  closed_by: { username: string; name: string } | null
  web_url: string
}

async function getGitlabEnv(): Promise<{ url: string; token: string }> {
  const { url, token } = await resolveGitlabConfig()
  if (!url || !token) {
    throw new Error('缺少 GitLab 配置（请在 admin UI 或 .env 中设置 URL 和 Token）')
  }
  return { url, token }
}

/** 查单个 MR 的 state 和 merged_by / closed_by 信息（对账用）。 */
export async function gitlabGetMr(params: {
  projectPath: string
  mrIid: number
}): Promise<GitLabMr> {
  const { url, token } = await getGitlabEnv()
  const { data } = await axios.get<GitLabMr>(
    `${url}/api/v4/projects/${encodeURIComponent(params.projectPath)}/merge_requests/${params.mrIid}`,
    { headers: { 'PRIVATE-TOKEN': token }, timeout: 15_000 },
  )
  return data
}
```

- [ ] **Step 3：给 mock GitLab 加对应 endpoint**

`src/__tests__/mock-e2e/mocks/gitlab-server.ts` 追加：
```typescript
// GET /api/v4/projects/:path/merge_requests/:iid — 查 MR 状态（对账用）
app.get('/api/v4/projects/:projectPath/merge_requests/:iid', (req, res) => {
  const iid = Number(req.params.iid)
  const key = buildOverrideKey('GET', `/api/v4/projects/${req.params.projectPath}/merge_requests`, iid)
  const override = state.responseOverrides.get(key)
  if (override !== undefined) return res.json(override)
  // 默认返回 opened，测试通过 override 注入 merged/closed
  return res.json({
    iid,
    state: 'opened',
    merged_at: null,
    merged_by: null,
    closed_at: null,
    closed_by: null,
    web_url: `http://mock-gitlab/${decodeURIComponent(req.params.projectPath)}/merge_requests/${iid}`,
  })
})
```

- [ ] **Step 4：commit**

```
feat(gitlab): gitlabGetMr API 封装 + mock GET /merge_requests/:iid
```

---

## Task 2：对账核心函数 `reconcileOnce`

**Files:**
- Create: `src/agent/reconcile/mr-state-reconciler.ts`
- Create: `src/__tests__/unit/mr-state-reconciler.test.ts`

**Rationale**：把扫描 + 查询 + 判决 + 落库做成一个函数，调度器只负责定时调它。函数可被手动触发（admin endpoint 未来扩展），也方便测试。

### 业务逻辑

```
扫描条件：
  SELECT r.id AS report_id, r.pipeline_run_id, e.project_path, (e.data->>'mrIid')::int AS mr_iid
  FROM bug_analysis_reports r
  JOIN bug_fix_events e
    ON e.report_id = r.id AND e.code = 'create_mr' AND e.status = 'success'
  WHERE r.status = 'pipeline_success'
    AND r.created_at > now() - interval '${WINDOW_DAYS} days'

处理每行：
  mr = gitlabGetMr(projectPath, mrIid)
  switch mr.state:
    case 'merged':
      if (已有 lifecycle_sync{mrAction='merge'} 事件) → skip
      else:
        createEvent({code: 'lifecycle_sync', data: { mrAction: 'merge', mrIid, mergedBy, targetStatus: 'completed', source: 'reconciler' }})
        updateStatus(reportId, 'completed')
    case 'closed':
      if (已有 lifecycle_sync{mrAction='close'} 事件) → skip
      else:
        createEvent({code: 'lifecycle_sync', data: { mrAction: 'close', mrIid, closedBy, targetStatus: 'aborted', source: 'reconciler' }})
        updateStatus(reportId, 'aborted')
    case 'opened' | 'locked':
      // MR 还在开着，不动
      skip

幂等关键：
  - lifecycle_sync 事件 data.source = 'reconciler' 区分 webhook（source='webhook'）
  - 查询 existing lifecycle_sync 时只按 mrAction 判重，不分 source（webhook 已写入的也算）
  - createEvent 失败会 throw（沿用 C1 约定），但单条失败不影响其他
```

### 错误处理

- **单个 MR 查 GitLab 失败**：catch + log + 记入 failures 列表；继续处理下一个
- **429 rate limit / 502**：不重试（下一轮 5min 后自然重跑）
- **报告不存在 / 事件不存在**：扫描 SQL 会跳过（INNER JOIN）
- **createEvent 失败**：throw（沿用 C1 约定，让整个 reconcileOnce 抛出）

- [ ] **Step 1：写失败测试** — `mr-state-reconciler.test.ts`
  - Test 1：`pipeline_success + MR merged → 写 lifecycle_sync + status=completed`
  - Test 2：`pipeline_success + MR closed → 写 lifecycle_sync + status=aborted`
  - Test 3：`pipeline_success + MR opened → 不动`
  - Test 4：`pipeline_success + 已有 lifecycle_sync(merge) 事件 → 跳过，不重复写`
  - Test 5：`扫描窗口过期（> 7 天的报告） → 不扫描`
  - Test 6：`GitLab 返回 500 → 当前 MR 跳过，继续处理下一个，函数正常返回`
  - Test 7：`多个 project 同一 report → 每个 MR 独立判决`（多 project 场景）
  - Test 8：`并发 <= ANALYSIS_CONCURRENCY`（断言 peak concurrency）

- [ ] **Step 2：实现 `reconcileOnce`**

```typescript
// src/agent/reconcile/mr-state-reconciler.ts
import pLimit from 'p-limit'
import { getPool } from '../../db/client.js'
import { updateStatus, findByReportCode } from '../../db/repositories/bug-analysis-reports.js'
import { createEvent, findByReportCode as findEventByCode } from '../../db/repositories/bug-fix-events.js'
import { gitlabGetMr } from '../analysis/gitlab-mr.js'

const DEFAULT_WINDOW_DAYS = 7
const DEFAULT_CONCURRENCY = 3

export interface ReconcileStats {
  scanned: number
  mergedSynced: number
  closedSynced: number
  skipped: number      // 已有 lifecycle_sync 或 state=opened
  failures: Array<{ reportId: number; projectPath: string; mrIid: number; error: string }>
}

export async function reconcileOnce(opts?: {
  windowDays?: number
  concurrency?: number
}): Promise<ReconcileStats> {
  const windowDays = opts?.windowDays ?? Number(process.env.MR_RECONCILE_WINDOW_DAYS ?? DEFAULT_WINDOW_DAYS)
  const concurrency = opts?.concurrency ?? Number(process.env.MR_RECONCILE_CONCURRENCY ?? DEFAULT_CONCURRENCY)
  const validConcurrency = concurrency > 0 ? concurrency : DEFAULT_CONCURRENCY
  const limit = pLimit(validConcurrency)

  const stats: ReconcileStats = { scanned: 0, mergedSynced: 0, closedSynced: 0, skipped: 0, failures: [] }

  const pool = getPool()
  const { rows } = await pool.query<{
    report_id: number
    project_path: string
    mr_iid: number
  }>(`
    SELECT r.id AS report_id, e.project_path, (e.data->>'mrIid')::int AS mr_iid
    FROM bug_analysis_reports r
    JOIN bug_fix_events e
      ON e.report_id = r.id
      AND e.code = 'create_mr'
      AND e.status = 'success'
    WHERE r.status = 'pipeline_success'
      AND r.created_at > now() - ($1 || ' days')::interval
  `, [String(windowDays)])

  stats.scanned = rows.length

  await Promise.all(rows.map(row => limit(() => handleOne(row, stats))))

  return stats
}

async function handleOne(
  row: { report_id: number; project_path: string; mr_iid: number },
  stats: ReconcileStats,
): Promise<void> {
  const { report_id: reportId, project_path: projectPath, mr_iid: mrIid } = row
  try {
    const mr = await gitlabGetMr({ projectPath, mrIid })

    if (mr.state !== 'merged' && mr.state !== 'closed') {
      stats.skipped++
      return
    }

    // 幂等：同 project + mrAction 的 lifecycle_sync 已存在则跳过
    const action = mr.state === 'merged' ? 'merge' : 'close'
    const existingSync = await findEventByCode(reportId, 'lifecycle_sync')
    const alreadySynced = existingSync.some(e => {
      const d = e.data as { mrAction?: string; mrIid?: number }
      return d.mrAction === action && d.mrIid === mrIid
    })
    if (alreadySynced) {
      stats.skipped++
      return
    }

    const targetStatus = mr.state === 'merged' ? 'completed' : 'aborted'
    await createEvent({
      reportId,
      projectPath,
      code: 'lifecycle_sync',
      status: 'success',
      data: {
        mrAction: action,
        mrIid,
        targetStatus,
        mergedBy: mr.merged_by?.username,
        closedBy: mr.closed_by?.username,
        source: 'reconciler',
      },
    })
    await updateStatus(reportId, targetStatus)

    if (mr.state === 'merged') stats.mergedSynced++
    else stats.closedSynced++
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stats.failures.push({ reportId, projectPath, mrIid, error: msg })
    console.error(`[mr-reconciler] report ${reportId} MR ${projectPath}#${mrIid} failed:`, msg)
  }
}
```

- [ ] **Step 3：测试通过**：`npx vitest run src/__tests__/unit/mr-state-reconciler.test.ts`
- [ ] **Step 4：commit**

```
feat(reconcile): reconcileOnce MR 状态对账核心逻辑 + 8 个单测
```

---

## Task 3：调度器 `startMrReconciler` / `stopMrReconciler`

**Files:**
- Modify: `src/agent/reconcile/mr-state-reconciler.ts`
- Modify: `src/server.ts`

**Rationale**：参考 [worktree/cleanup-scheduler.ts](../../../src/agent/worktree/cleanup-scheduler.ts) 的 `setInterval` 模式，简单可靠。

- [ ] **Step 1：在 `mr-state-reconciler.ts` 追加调度器**

```typescript
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000  // 5min
let intervalId: ReturnType<typeof setInterval> | null = null

export function startMrReconciler(): void {
  if (intervalId) return  // 幂等
  const intervalMs = Number(process.env.MR_RECONCILE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS)
  const validInterval = intervalMs >= 60_000 ? intervalMs : DEFAULT_INTERVAL_MS  // 最小 60s 防误配
  intervalId = setInterval(async () => {
    try {
      const stats = await reconcileOnce()
      console.log(`[mr-reconciler] scan done:`, stats)
    } catch (err) {
      console.error('[mr-reconciler] reconcileOnce failed:', err)
    }
  }, validInterval)
  console.log(`[mr-reconciler] started (interval: ${validInterval}ms)`)
}

export function stopMrReconciler(): void {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
  console.log('[mr-reconciler] stopped')
}
```

- [ ] **Step 2：`src/server.ts` 启动 + 优雅关闭**

找到现有 `startCleanupScheduler` / `startScheduler` 调用附近加：
```typescript
import { startMrReconciler, stopMrReconciler } from './agent/reconcile/mr-state-reconciler.js'

// ... 启动序列
startMrReconciler()

// ... 关闭 hook（跟 stopCleanupScheduler 一起）
app.addHook('onClose', async () => {
  stopMrReconciler()
})
```

- [ ] **Step 3：commit**

```
feat(reconcile): setInterval 调度器 + server.ts 集成
```

---

## Task 4：集成测试（端到端对账）

**Files:**
- Create: `src/__tests__/integration/mr-reconciliation-flow.test.ts`

**Rationale**：单测 mock axios，集成测试走真 DB + mock GitLab server，覆盖"整条链路"的幂等性和业务正确性。

- [ ] **测试场景**：

```typescript
describe('MR Reconciliation Integration', () => {
  beforeEach(async () => {
    await resetTestDb()
    await baseSeed()
    // 起 mock GitLab server
  })

  it('pipeline_success + MR merged → completed + lifecycle_sync', async () => {
    // 1. 种：一个 pipeline_success 的 report + create_mr 事件
    // 2. mock GitLab 返回 state=merged
    // 3. 调 reconcileOnce()
    // 4. 断言：lifecycle_sync 事件写入 + status=completed
    // 5. 断言：stats.mergedSynced=1
  })

  it('pipeline_success + MR closed → aborted + lifecycle_sync', async () => { ... })

  it('幂等：重复调 reconcileOnce 不会重复写 lifecycle_sync', async () => {
    // 先让 webhook 路径写过一次 lifecycle_sync(merge)
    // 再调 reconcileOnce
    // 断言：只有 1 条 lifecycle_sync 事件，status 已是 completed
  })

  it('扫描窗口：>7 天的 report 不被扫描', async () => {
    // 种 8 天前的 report
    // reconcileOnce → stats.scanned = 0
  })

  it('多 project：同一 report 3 个 MR，其中 2 个 merged + 1 个 opened', async () => {
    // mock 3 MR 不同 state
    // 断言：2 次 lifecycle_sync(merge)，但 status 只在最后一次 update
    // 注意：status 语义讨论点（见 D5 below）
  })
})
```

- [ ] **commit**：

```
test(integration): MR 对账端到端场景覆盖
```

---

## 需要在集成测试中确定的语义 (D5)

### 多 project 场景下 status 怎么算？

一个 L3 report 涉及 3 个 project，各自 MR：
- A merged + B merged + C opened → report.status = ?
- A merged + B closed + C merged → report.status = ?
- A closed + B closed + C closed → report.status = ?

**选方案**：
- [ ] **方案 A（推荐）**：**所有 MR 都终态**才更新 status
  - 全 merged → completed
  - 任一 closed → aborted（即使有 merged，也视为异常）
- [ ] 方案 B：**任一 MR 终态**就更新
  - 第一个 merged 的 MR 就标 completed（即使其他 MR 还 opened）
- [ ] 方案 C：保持现有 webhook 语义（一次一 update，后面覆盖前面）

**建议理由**：A 最符合业务预期 —— 一个 bug 涉及多 project 修复，需要所有 MR 都处理完才算"bug 修好了"。

---

## Task 5：文档收尾（大部分已在 plan 阶段完成）

### 已完成（plan 阶段已改，不需再动）

- ✅ [2026-04-19-bug-fix-workflow-v2-design.md §5.3](../specs/2026-04-19-bug-fix-workflow-v2-design.md) — 状态转换代码位置对照表追加 reconciler 行 + 双轨制说明
- ✅ [2026-04-19-bug-fix-workflow-v2-design.md §7.1](../specs/2026-04-19-bug-fix-workflow-v2-design.md) — `lifecycle_sync` 事件码行更新发起方和 `source` 字段
- ✅ [2026-04-17-bug-fix-workflow-orchestration-design.md §状态机](../specs/2026-04-17-bug-fix-workflow-orchestration-design.md) — 状态机图 + 触发方列追加 reconciler 兜底路径
- ✅ [2026-04-17-bug-fix-workflow-orchestration.md Task 12](2026-04-17-bug-fix-workflow-orchestration.md) — 前向链接到本 plan

### 本 Task（Task 1–4 完成后做）

**Files:**
- Modify: `CLAUDE.md` — 新增 `MR_RECONCILE_*` 环境变量说明

追加段：
```markdown
- `MR_RECONCILE_INTERVAL_MS`（默认 300000 / 5 min）— 对账调度间隔，最小 60000
- `MR_RECONCILE_WINDOW_DAYS`（默认 7）— 扫描窗口：只对账 created_at 在窗口内的报告
- `MR_RECONCILE_CONCURRENCY`（默认 3）— GitLab API 并发上限
```

- [ ] commit：

```
docs(claude): 补 MR reconciler 环境变量说明
```

---

## 总验收清单

完成后一次性确认：

- [ ] 所有新增单测 + 集成测试通过：`pnpm test`
- [ ] TypeScript 无错：`npx tsc --noEmit`
- [ ] E2E 回归（确认现有 webhook 路径不受影响）：`pnpm test:e2e`
- [ ] **硬约束文件零改动**：
  ```bash
  git diff --name-only master... | grep -E 'src/(pipeline/(executor|types|approval-manager|webhook-waiter)\.ts|db/repositories/(test-runs|test-pipelines)\.ts|adapters/gitlab/issue-handler\.ts)$'
  ```
  Expected: 无输出（issue-handler webhook 路径不动）
- [ ] 本地 dev 启动后观察日志：15 分钟后应看到 `[mr-reconciler] scan done: { scanned: N, ... }`

---

## Commit 规范

每个 Task 独立 commit：

```
Task 1:  feat(gitlab): gitlabGetMr API 封装 + mock GET /merge_requests/:iid
Task 2:  feat(reconcile): reconcileOnce MR 状态对账核心逻辑 + 8 个单测
Task 3:  feat(reconcile): setInterval 调度器 + server.ts 集成
Task 4:  test(integration): MR 对账端到端场景覆盖
Task 5:  docs: 补充 MR 对账双轨制 + 环境变量说明
```

---

## 上线后监控（可选）

目前设计在 `[mr-reconciler] scan done` 日志里打 stats。未来可考虑：
- 加 `reconciler_runs` 表持久化每轮执行记录（方便审计 webhook 漏发频率）
- 加 admin 端点 `POST /admin/reconcile/mr-state` 支持手动触发
- 加 `GET /admin/reconcile/history` 查看最近 N 次执行统计

**本次不做**，保持 MVP 范围。

---

## 风险与权衡

| 风险 | 缓解 |
|---|---|
| GitLab 挂掉时 reconciler 持续失败刷 log | 单次失败只 log 不抛；下次 5min 后再试 |
| 扫描窗口太小漏掉老报告 | 默认 7 天够用；可通过环境变量调 |
| 并发调 GitLab 触发 rate limit | pLimit(3) 限制 + GitLab 600/min 限流充足 |
| webhook 和 reconciler 双写竞争 | 幂等 key `(mrIid, mrAction)` 去重；DB 事务保证 createEvent + updateStatus 原子性（如非原子需加 pg advisory lock）|
| multi-project 下 status 语义 | D5 决策点待确认 |

---

## 文档版本

- **v1.0**（2026-04-20）— 初稿，待 D1–D5 决策确认后进入 Task 1
