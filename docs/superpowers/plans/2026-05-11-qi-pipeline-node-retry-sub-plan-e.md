# QI Pipeline Node-Level Retry (Sub-plan E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `status='failed'` 的 QI requirement 能从「最后失败的节点」一键 retry。手动测试时发现 spec_ai_review 因 spec-reviewer.md 缺失而 fail 后只能整条重跑，新机制让修复后能从失败节点继续。

**Architecture:** 新增 admin endpoint `POST /admin/requirements/:id/retry`。后端逻辑：校验 run status='failed' + LangGraph checkpoint 仍存在 → 把 test_runs.status 从 `failed` 重置为 `running` → 调用 `resumeRun(runId, new Command({}))` 让 LangGraph 从 checkpoint 继续（因 graph 在失败节点停留，re-stream 会再试该节点）。前端在 RequirementsPage 详情抽屉里 status='failed' 时显示「重试」按钮。

**Tech Stack:** TypeScript ES2022 + Fastify + LangGraph + PostgresSaver + React 18 + Ant Design 5 + Vitest

**Spec:** [docs/superpowers/specs/2026-05-11-qi-pipeline-topology-design.md](../specs/2026-05-11-qi-pipeline-topology-design.md) §2.5 + §5.5
**审计:** [docs/qi-workflow-audit.md](../../qi-workflow-audit.md) §4-C.9 "graph 终态后无法从单节点重起"

**Out of Scope（本 plan 不涉及）：**
- `invalidate_downstream` 模式（任意 fromNode 回退 + 清下游 stage_results + LangGraph state 截断）— 留 Sub-plan E.1
- 节点选择 UI（前端只显示一个「重试」按钮，自动选最后失败的节点）— Sub-plan E.1
- 跨 interrupt 的 retry（人审 waiter 超时后想再发卡片）— 已有 abort-then-retry 路径替代
- E2E sandbox VM 改造（独立大议题）

---

## File Structure

**Create:**
- `src/__tests__/integration/qi-retry-admin.test.ts` — Task 1+2 集成测试

**Modify:**
- `src/pipeline/graph-runner.ts` — 新增 `retryFailedRun(runId)` 导出函数
- `src/admin/routes/requirements.ts` — 加 `POST /requirements/:id/retry` endpoint
- `web/src/api/requirements.ts` — 加 `retry()` API client 方法
- `web/src/pages/RequirementsPage.tsx` — 详情抽屉加「重试」按钮

**单元测试 pattern 参考：** [src/__tests__/integration/human-gate-timeout.test.ts](../../../src/__tests__/integration/human-gate-timeout.test.ts) + [src/__tests__/integration/qi-pipeline-bootstrap-v13.test.ts](../../../src/__tests__/integration/qi-pipeline-bootstrap-v13.test.ts)

---

## Task 1: graph-runner.ts 新增 `retryFailedRun(runId)` helper

封装"从失败节点继续 graph 执行"的逻辑：校验状态 → 重置 test_runs.status → 调 resumeRun。

**Files:**
- Modify: `src/pipeline/graph-runner.ts` — 加 `export async function retryFailedRun(runId: number)`

### Steps

- [ ] **Step 1.1: 探查现状**

```bash
grep -n "export async function\|resumeRun\|getCheckpointer\|test_runs.*status\|getTestRunById" src/pipeline/graph-runner.ts | head -20
```

确认：
- `resumeRun(runId, command)` 在 L183，依赖 `reloadContext` 从 DB 加载 ctx
- `getCheckpointer()` 返回 `PostgresSaver`
- `getTestRunById` / `updateTestRunStatus` 在 `src/db/repositories/test-runs.ts`

- [ ] **Step 1.2: 写失败测试**

Create `src/__tests__/integration/qi-retry-admin.test.ts`:

```typescript
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Command } from '@langchain/langgraph'
import { resetTestDb } from '../helpers/db.js'
import {
  createTestRun,
  updateTestRunStatus,
  getTestRunById,
} from '../../db/repositories/test-runs.js'
import { createTestPipeline } from '../../db/repositories/test-pipelines.js'

// 注：vi.mock 必须放最前，beforeAll 之前
vi.mock('../../pipeline/graph-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pipeline/graph-runner.js')>()
  return {
    ...actual,
    // 不 mock retryFailedRun（要测它）
    // mock resumeRun 让它不真跑 graph
    resumeRun: vi.fn(),
  }
})

const grr = await import('../../pipeline/graph-runner.js')

describe('retryFailedRun', () => {
  let pipelineId: number
  let runId: number

  beforeAll(async () => {
    await resetTestDb()
    const pipeline = await createTestPipeline({
      name: 'test-retry-pipeline',
      description: 'test',
      stages: [],
      graph: { nodes: [], edges: [] } as any,
      enabled: true,
      variables: {},
    })
    pipelineId = pipeline.id
  })

  beforeEach(async () => {
    const run = await createTestRun({
      pipelineId,
      triggerType: 'manual',
      triggeredBy: 'test',
      servers: {},
      triggerParams: {},
      runtimeVars: {},
    })
    runId = run.id
    vi.clearAllMocks()
  })

  it('rejects retry when run is not failed', async () => {
    await updateTestRunStatus(runId, 'running')

    await expect(grr.retryFailedRun(runId)).rejects.toThrow(/not failed/i)
    expect(grr.resumeRun).not.toHaveBeenCalled()
  })

  it('rejects retry when run not found', async () => {
    await expect(grr.retryFailedRun(999999)).rejects.toThrow(/not found/i)
  })

  it('resets failed run to running + invokes resumeRun with empty Command', async () => {
    await updateTestRunStatus(runId, 'failed')

    await grr.retryFailedRun(runId)

    const after = await getTestRunById(runId)
    expect(after?.status).toBe('running')
    expect(grr.resumeRun).toHaveBeenCalledTimes(1)
    expect(grr.resumeRun).toHaveBeenCalledWith(runId, expect.any(Command))
  })
})
```

- [ ] **Step 1.3: Run — expect FAIL**

```bash
npx vitest run src/__tests__/integration/qi-retry-admin.test.ts
```

- [ ] **Step 1.4: 实现 retryFailedRun**

修改 `src/pipeline/graph-runner.ts`，在 `resumeRun` 函数（约 L183）之后添加：

```typescript
/**
 * Retry a failed pipeline run from its last stuck node.
 *
 * Semantics: graph 在 failed 节点处停留（LangGraph checkpoint 没动），
 * 重置 test_runs.status 为 'running' + 调 resumeRun(Command({}))，
 * LangGraph re-stream 会重试该节点。
 *
 * Spec §2.5 + §5.5 'resume' mode. 任意 fromNode 回退是 'invalidate_downstream'
 * 模式留给 Sub-plan E.1。
 */
export async function retryFailedRun(runId: number): Promise<void> {
  const run = await getTestRunById(runId)
  if (!run) {
    throw new Error(`retryFailedRun: run ${runId} not found`)
  }
  if (run.status !== 'failed') {
    throw new Error(
      `retryFailedRun: run ${runId} status is '${run.status}', expected 'failed'`,
    )
  }
  // 重置 status；LangGraph checkpoint 保持不动（resumeRun 会从 checkpoint 继续）
  await updateTestRunStatus(runId, 'running')
  await resumeRun(runId, new Command({}))
}
```

并在文件顶部 import `Command`（如果还没 import）：

```bash
grep -n "from '@langchain/langgraph'" src/pipeline/graph-runner.ts | head -3
```

确认 `Command` 是否已 import；若无，加：
```typescript
import { Command } from '@langchain/langgraph'
```

并 import `getTestRunById` + `updateTestRunStatus`（grep 看现有 test-runs 仓库 imports 在 graph-runner.ts 的哪一行）：

```typescript
import { getTestRunById, updateTestRunStatus } from '../db/repositories/test-runs.js'
```

- [ ] **Step 1.5: Run — expect PASS**

```bash
npx vitest run src/__tests__/integration/qi-retry-admin.test.ts
./test.sh --typecheck
```

- [ ] **Step 1.6: Commit**

```bash
git add src/pipeline/graph-runner.ts src/__tests__/integration/qi-retry-admin.test.ts
git commit -m "feat(qi): 新增 retryFailedRun helper — 从失败节点继续 graph

修审计 §4-C.9 'graph 终态后无法从单节点重起'。实现 spec §5.5 'resume' 模式：
- 校验 run status='failed' + run 存在
- 重置 test_runs.status='running'
- 调 resumeRun(runId, Command({})) 让 LangGraph 从 checkpoint 继续（在失败节点）

任意 fromNode 回退（invalidate_downstream）留 Sub-plan E.1。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: admin route `POST /requirements/:id/retry`

新增 endpoint：根据 requirement.pipeline_run_id 找 run，调 retryFailedRun。

**Files:**
- Modify: `src/admin/routes/requirements.ts`

### Steps

- [ ] **Step 2.1: 在测试文件加 admin route 集成测试**

继续 `src/__tests__/integration/qi-retry-admin.test.ts`，加新 describe block：

```typescript
import { buildFastifyApp } from '../helpers/fastify-app.js'  // grep 看现有 helper 用法

describe('POST /requirements/:id/retry', () => {
  let app: any
  let requirementId: number

  beforeAll(async () => {
    app = await buildFastifyApp()
  })

  beforeEach(async () => {
    // 建一个有 pipelineRunId 关联到上面 failed run 的 requirement
    const reqRow = await app.pg.query(
      `INSERT INTO requirements (title, raw_input, status, gitlab_project, base_branch, pipeline_run_id, source)
       VALUES ('test', 'x', 'failed', 'g/p', 'main', $1, 'web') RETURNING id`,
      [runId],
    )
    requirementId = reqRow.rows[0].id
  })

  it('returns 404 when requirement not found', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/admin/requirements/999999/retry',
      payload: {},
    })
    expect(resp.statusCode).toBe(404)
  })

  it('returns 400 when requirement has no pipelineRunId', async () => {
    const orphan = await app.pg.query(
      `INSERT INTO requirements (title, raw_input, status, gitlab_project, base_branch, source)
       VALUES ('orphan', 'x', 'failed', 'g/p', 'main', 'web') RETURNING id`,
    )
    const resp = await app.inject({
      method: 'POST',
      url: `/admin/requirements/${orphan.rows[0].id}/retry`,
      payload: {},
    })
    expect(resp.statusCode).toBe(400)
    expect(JSON.parse(resp.body).error).toMatch(/no pipelineRunId/i)
  })

  it('returns 200 + triggers retryFailedRun on valid failed requirement', async () => {
    await updateTestRunStatus(runId, 'failed')

    const resp = await app.inject({
      method: 'POST',
      url: `/admin/requirements/${requirementId}/retry`,
      payload: {},
    })
    expect(resp.statusCode).toBe(200)
    expect(JSON.parse(resp.body)).toMatchObject({ ok: true, retried: true })
    expect(grr.resumeRun).toHaveBeenCalledTimes(1)
  })

  it('propagates 400 when run is not failed', async () => {
    await updateTestRunStatus(runId, 'running')

    const resp = await app.inject({
      method: 'POST',
      url: `/admin/requirements/${requirementId}/retry`,
      payload: {},
    })
    expect(resp.statusCode).toBe(400)
    expect(JSON.parse(resp.body).error).toMatch(/not failed/i)
  })
})
```

注：`buildFastifyApp` helper 实际名可能不同；先 `grep "buildFastifyApp\|createTestApp\|inject" src/__tests__/integration/ | head` 看现有集成测试 app 启动 pattern。若无该 helper，可直接在测试里 `import server from '../../server.js'` + `inject`。

- [ ] **Step 2.2: Run — expect FAIL（endpoint 不存在）**

```bash
npx vitest run src/__tests__/integration/qi-retry-admin.test.ts
```

- [ ] **Step 2.3: 实现 endpoint**

修改 `src/admin/routes/requirements.ts`，在 `POST /requirements/:id/abort` 之后（约 L194 之前）插入：

```typescript
  // POST /requirements/:id/retry — Sub-plan E：从失败节点 retry（resume 模式）
  app.post<{ Params: { id: string } }>('/requirements/:id/retry', async (req, reply) => {
    const id = Number(req.params.id)
    if (isNaN(id)) return reply.status(400).send({ error: 'invalid id' })

    const requirement = await getRequirementById(id)
    if (!requirement) return reply.status(404).send({ error: 'requirement not found' })

    if (!requirement.pipelineRunId) {
      return reply.status(400).send({
        error: 'requirement has no pipelineRunId; cannot retry (was never run?)',
      })
    }

    try {
      await retryFailedRun(requirement.pipelineRunId)
      return { ok: true, retried: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(400).send({ error: msg })
    }
  })
```

并在文件顶部 import：
```typescript
import { retryFailedRun } from '../../pipeline/graph-runner.js'
```

- [ ] **Step 2.4: Run — expect PASS**

```bash
npx vitest run src/__tests__/integration/qi-retry-admin.test.ts
./test.sh --typecheck
```

- [ ] **Step 2.5: Commit**

```bash
git add src/admin/routes/requirements.ts src/__tests__/integration/qi-retry-admin.test.ts
git commit -m "feat(qi): admin endpoint POST /requirements/:id/retry

新加 endpoint：查 requirement → 校验 pipelineRunId 存在 → 调 retryFailedRun。
错误处理：404 (requirement 不存在) / 400 (没 pipelineRunId / run 不是 failed 状态)。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: 前端 API client + UI 重试按钮

`web/src/api/requirements.ts` 加 `retry()` 方法；`RequirementsPage.tsx` 详情抽屉 status=failed 时显示「重试」按钮。

**Files:**
- Modify: `web/src/api/requirements.ts`
- Modify: `web/src/pages/RequirementsPage.tsx`

### Steps

- [ ] **Step 3.1: 加 API client 方法**

修改 `web/src/api/requirements.ts`，在现有 `requirementsApi` object 里加：

```typescript
async retry(id: number): Promise<{ ok: boolean; retried: boolean }> {
  const { data } = await axios.post(`/admin/requirements/${id}/retry`)
  return data
},
```

（具体位置：grep `requirementsApi\|abort:` 在 web/src/api/requirements.ts 找现有 abort 实现，紧跟着加 retry，pattern 一致）

- [ ] **Step 3.2: 加 UI 按钮**

`web/src/pages/RequirementsPage.tsx`。先 grep 看 abort 按钮的实现：

```bash
grep -n "abort\|Abort\|停止" web/src/pages/RequirementsPage.tsx | head -10
```

参考 abort 按钮 pattern，在详情抽屉里加：

```tsx
{detail?.status === 'failed' && (
  <Popconfirm
    title="确定从失败节点重试？"
    description="将重置 run 状态并从 LangGraph checkpoint 继续执行。"
    onConfirm={async () => {
      try {
        await requirementsApi.retry(detail.id)
        message.success('已触发重试')
        await loadDetail(detail.id)  // 刷新详情
      } catch (err: any) {
        message.error(`重试失败：${err?.response?.data?.error ?? err.message}`)
      }
    }}
    okText="确定"
    cancelText="取消"
  >
    <Button icon={<ReloadOutlined />}>从失败节点重试</Button>
  </Popconfirm>
)}
```

注：
- import `ReloadOutlined` from `@ant-design/icons`（如果没 import）
- `message` / `Popconfirm` 应该已 import（abort 按钮也用）
- `loadDetail` / `detail` 是 RequirementsPage 已有的 state；grep 确认名称

- [ ] **Step 3.3: 前端 typecheck**

```bash
cd web && pnpm exec tsc --noEmit
```

或全套：
```bash
./test.sh --typecheck
```

- [ ] **Step 3.4: 手动 smoke（可选）**

```bash
cd web && pnpm dev
# 浏览器打开 http://localhost:5173
# 找 status=failed 的需求 → 详情抽屉应显示「从失败节点重试」按钮
```

如果 dev server 没跑或无失败需求，跳过此步。

- [ ] **Step 3.5: Commit**

```bash
git add web/src/api/requirements.ts web/src/pages/RequirementsPage.tsx
git commit -m "feat(qi/web): RequirementsPage 加「从失败节点重试」按钮

详情抽屉 status='failed' 时显示按钮，Popconfirm 确认后调
POST /admin/requirements/:id/retry，成功后 reload detail 刷新状态。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: 全套测试 verify

verify Sub-plan E 改动不破坏 Sub-plan A/B/C/D 任何已建测试。

### Steps

- [ ] **Step 4.1: typecheck**

```bash
./test.sh --typecheck
```

Expected: PASS

- [ ] **Step 4.2: 相关测试套件**

```bash
npx vitest run --exclude '**/var/**' \
  src/__tests__/integration/qi-retry-admin \
  src/__tests__/integration/human-gate-timeout \
  src/__tests__/integration/qi-pipeline-bootstrap-v12 \
  src/__tests__/integration/qi-pipeline-bootstrap-v13 \
  src/__tests__/unit/node-types/init-qi-branch-push \
  src/__tests__/unit/node-types/mr-create-idempotent \
  src/__tests__/unit/node-types/cleanup-gitlab
```

Expected: 所有 pass。

- [ ] **Step 4.3: 可选 — 跑完整测试**

```bash
./test.sh
```

Expected: 仅 pre-existing failures（Sub-plan B Task 6 已列）。Sub-plan E 不应引入新 failures。

- [ ] **Step 4.4: 不需要 commit**（仅 verify）

---

## Self-Review

- [ ] **Spec coverage**：spec §5.5 "resume 模式" → Task 1 实现 `retryFailedRun` ✅。spec §5.5 "invalidate_downstream 模式" → 明确推迟到 Sub-plan E.1，文档化 ✅。spec §2.5 "新增 admin API" → Task 2 实现 ✅。

- [ ] **Placeholder scan**：grep `TODO|TBD|implement later` 在本 plan 代码块。无（"留 Sub-plan E.1" 是 explicit follow-up，不是 placeholder）。

- [ ] **Type consistency**：
  - `retryFailedRun(runId: number): Promise<void>` ✅
  - admin endpoint 接收 `Params: { id: string }` 不接 body（spec 写有 body 但 v1 不用 fromNode/resetMode 参数）✅
  - response `{ ok: boolean; retried: boolean }` ✅
  - 前端 api `retry(id: number)` 签名一致 ✅

- [ ] **跨 sub-plan 兼容**：
  - 不动 LangGraph checkpoint state，只 reset DB test_runs.status — Sub-plan A/B/C/D 节点行为不受影响
  - resumeRun 是现有 API（B-Task 1 timeout 也用），retry 复用同一入口
  - 前端 detail 抽屉已有 status=failed 处理（show 错误），加按钮是附加

- [ ] **Commit message 约定**：`feat(qi): ...` / `feat(qi/web): ...` 前缀 ✅

---

## 已知 follow-up（不阻塞本 plan）

1. **Sub-plan E.1: invalidate_downstream 模式** — 用户指定任意 fromNode 回退：
   - 截断 stage_results 数组
   - LangGraph state mutation（Command({update: ..., goto: fromNode})）
   - 前端节点列表每节点加「从此节点重跑」按钮（vs 当前只有"从失败节点"）
   - 复杂度：中高，需研究 LangGraph state 截断 API

2. **跨 interrupt 的 retry** — 人审 waiter 超时但用户想再发卡片：
   - 当前 abort + 新建需求是 workaround
   - 真正的"重发卡片"需要 cancel timeout timer + 改 waiter.claimed_by=null + 重新发 IM 卡片

3. **Retry 计数 + 上限** — 避免一个 failed 需求被 retry 无限次：
   - 加 `retryCounters['failed_retry']` 计数（requirements 表已有 retryCounters 字段）
   - 超限（如 5 次）禁止 retry，UI 灰按钮

---

## Execution Handoff

Plan 写完，保存到 `docs/superpowers/plans/2026-05-11-qi-pipeline-node-retry-sub-plan-e.md`。

**风险：**
- Task 1: LangGraph 在 failed 节点处 checkpoint 是否真能 resume？— 需 verify。如果 checkpoint 是"未失败"状态（即上一次成功节点之后），resumeRun(Command({})) 会重跑失败节点；如果 checkpoint 已记录 failed status，需要更复杂处理。Task 1.2 集成测试只 mock resumeRun，没验证真 LangGraph 行为。**手动 smoke 在 Task 4 之后跑一遍 needs**。
- Task 2: `buildFastifyApp` helper 名可能跟现有不一致，需 grep 确认；最坏情况直接 import server
- Task 3: UI 按钮位置（抽屉顶部 / 底部 actions），grep abort 按钮位置照做

**执行选项：**

1. **Subagent-Driven（推荐）** — 每 task fresh subagent + 两阶段 review
2. **Inline 执行** — 当前 session 用 executing-plans skill 批量跑

Which approach?
