# 2026-05-13 QI spec_brainstorm 真实化设计

## 背景与范围

### 当前状态

[graph-builder.ts:2585-2657](../../../src/pipeline/graph-builder.ts#L2585) 的 `buildLlmBrainstormNode` 是 unconditional skeleton：进入即 return `partial:true, readyForSpec:true`，spec_author 直接拿 rawInput 继续。LLM 调用 / interrupt / 多轮 state / artifacts 一概未实现。`POST /admin/requirements/:id/brainstorm/answer` 永远返 `no_active_brainstorm_waiter`，[BrainstormTab.tsx](../../../web/src/pages/requirement-detail/BrainstormTab.tsx) 是静态固定选项 ABCD 占位 UI。

### 本迭代目标（Web 多轮全集）

1. 真调 LLM brainstorm-host role，多轮（1-5 轮）interrupt + resume
2. 失败兜底：partial / earlyDone / quality fail / budget exceed 四条退出路径
3. 24h interrupt 超时 → requirement.status='aborted'
4. `writeBrainstormArtifacts` 写 `docs/brainstorm/qi-{id}.{md,json}`
5. spec_author 接 enrichedInput（拿 brainstormPath 作为 priorBrainstormPath 输入）
6. 用户感知 4 层提示（顶部 Alert / 状态徽章 / Tab Badge / 节点行内 tag）
7. 完整测试覆盖（单测 + 集成 + replay + timeout）

### 不在本迭代

- IM 卡片通道：im_router 加 brainstorm 5-section 解析（下迭代）
- token usage write path：当前 `pipeline_run_state.token_total` 没有任何写入方，`getCumulativeTokenUsage` 永远返 0；本 spec 标记为已知 gap，留作下迭代单独迭代（不影响 brainstorm walking skeleton）
- stage indicator 视觉强化（黄色 pulsating）：L1 Alert + L3 Badge 已足以提示，先不加

## 架构总览

### 节点 loop

`buildLlmBrainstormNode` 重写为节点内 `for (round = 1..maxRounds + 1)` 循环 + LangGraph `interrupt()` 多轮。每轮一行 `brainstorm_waiters` 表记录。replay 时 `getBrainstormWaiterByRound` 命中已有行 → 跳过 LLM 调用、`interrupt()` 在 replay 时返回 resume value 而非抛 — 跟 [skill_with_approval](../../../src/pipeline/graph-builder.ts#L1196) 同模式。

### 数据流

```
spec_brainstorm 节点 (round=N)
   │
   ├── budget gate (Σtokens vs cfg.tokenBudgetPerRequirement)
   ├── 从 round=N-1 的 answered waiter 重建 BrainstormState
   ├── advanceBrainstormState
   ├── 检查 bs.readyForSpec → break loop
   │
   ├── skillExecutor.run(skill=quick-impl-artifact-author, role=brainstorm-host,
   │                     inputs={ rawInput, history, enrichedInput, round, maxRounds },
   │                     worktreePath, timeoutMs=60000)
   │
   ├── parseBrainstormLlmJson → { decision: 'ask'|'ready'|'fail', question?, enrichedInputDelta? }
   │
   ├── decision='ready'|'fail': advanceBrainstormState + continue (下轮 break)
   │
   ├── decision='ask':
   │     parseFiveSectionMarkdown(question) 校验
   │     │
   │     ├── invalid: failedQualityRounds++; ≥2 → partial=true,readyForSpec=true
   │     │
   │     └── valid: extract options[]; createBrainstormWaiter (round=N, status='pending')
   │                  scheduleBrainstormTimeout(waiterId, 24h)
   │                  interrupt({ kind: QI_BRAINSTORM_INTERRUPT, waiterId, ... })
   │                  ↓
   │                  graph 挂起,等 resume
   │                  ↓
   │                  resumeFromBrainstorm → 回到 loop round=N+1
   │
   └── (loop end) writeBrainstormArtifacts → step_output { brainstormPath, enrichedInputPath, rounds, readyForSpec, partial }
```

## 详细设计

### 1. brainstorm_waiters 表（schema-v1016）

```sql
CREATE TABLE IF NOT EXISTS brainstorm_waiters (
  id                    SERIAL PRIMARY KEY,
  requirement_id        INT NOT NULL,
  pipeline_run_id       INT NOT NULL,
  thread_id             TEXT NOT NULL,                     -- LangGraph thread_id (= run_id 字符串)
  node_id               TEXT NOT NULL,                     -- 'spec_brainstorm'
  round                 INT NOT NULL,                      -- 1..maxRounds
  question_md           TEXT NOT NULL,                     -- LLM 原 5-section markdown
  options               JSONB NOT NULL DEFAULT '[]',       -- [{id,label}] 节点 parse 后入库
  enriched_input        JSONB NOT NULL,                    -- 本轮入口 BrainstormState.enrichedInput
  history               JSONB NOT NULL DEFAULT '[]',       -- 本轮入口 BrainstormState.history
  failed_quality_rounds INT NOT NULL DEFAULT 0,
  ready_for_spec        BOOLEAN NOT NULL DEFAULT false,
  status                TEXT NOT NULL,                     -- 'pending' | 'answered' | 'expired'
  source                TEXT,                              -- 'web' | 'im' (answered 后填)
  chosen_option         TEXT,
  free_text             TEXT,
  answered_at           TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pipeline_run_id, node_id, round)
);
CREATE INDEX IF NOT EXISTS brainstorm_waiters_pending_idx
  ON brainstorm_waiters(requirement_id, status) WHERE status='pending';
CREATE INDEX IF NOT EXISTS brainstorm_waiters_expires_idx
  ON brainstorm_waiters(expires_at) WHERE status='pending';
```

无 FK 约束（跟 `requirement_approval_waiters` / `checkpoints` 一致），删除需求时手动级联清。

### 2. node-types/llm-brainstorm.ts 扩展

现有 `parseFiveSectionMarkdown` 只判 valid，扩展输出 `options: Array<{id, label}>`（从"## 选项（带我的推荐）"段落解析 `**A.** ...` / `**B.** ...` 行）。

新增 `parseBrainstormLlmJson(raw: string): BrainstormLlmOutput`，zod schema：

```typescript
const BrainstormLlmOutputSchema = z.object({
  decision: z.enum(['ask', 'ready', 'fail']),
  round: z.number().int().min(1).optional(),
  question: z.string().optional(),             // 5-section markdown
  enrichedInputDelta: z.record(z.unknown()).optional(),
})
```

`stub` 占位 `execute()` 保留（boot guard 需要）。

### 3. buildLlmBrainstormNode（graph-builder.ts L2585-2657 整段替换）

```typescript
function buildLlmBrainstormNode(node, index, ctxBase, triggerParams) {
  return async (state) => {
    const startedAt = nowIso()
    const startedMs = Date.now()
    const stageName = nodeStageResultName(node)
    await markStageRunning(ctxBase.runId, { ...node, name: stageName }, startedAt)
    const nodeId = node.id ?? stageName

    if (!ctxBase.skillExecutor) {
      return finishedFailed(...)  // skill_with_approval 同模板
    }

    const rawParams = node.params ?? {}
    const varCtx = buildVariableContext(state, ctxBase, triggerParams, node, index)
    const params = renderParamTemplates(rawParams, varCtx)
    const requirementId = Number(params.requirementId)
    const skill = String(params.skill)
    const role = String(params.role)
    const maxRounds = Number(params.maxRounds ?? 5)
    const timeoutMs = Number(params.timeoutMs ?? 86400000)
    const llmCallTimeoutMs = 60000
    const rawInput = String(params.rawInput ?? '')

    const cfg = await loadQiConfig()
    let bs = initBrainstormState()

    // 重建 state：从 round=1..maxRounds 的 answered waiter 累积
    const prior = await listBrainstormWaiters(ctxBase.runId, nodeId, 'asc')
    for (const w of prior.filter(w => w.status === 'answered')) {
      bs = rebuildAfterWaiter(bs, w)
    }
    let startRound = prior.length ? Math.max(...prior.map(w => w.round)) + (prior[prior.length-1].status === 'answered' ? 1 : 0) : 1

    for (let round = startRound; round <= maxRounds + 1; round++) {
      // 1. budget gate
      const used = await getCumulativeTokenUsage(ctxBase.runId)
      if (used >= cfg.tokenBudgetPerRequirement) {
        bs.partial = true; bs.readyForSpec = true; break
      }
      // 2. ready 检查（包括 cap）
      if (bs.readyForSpec || round > maxRounds) {
        if (!bs.readyForSpec) { bs.readyForSpec = true; bs.partial = true }
        break
      }

      // 3. 已有 pending waiter (replay)
      const existing = await getBrainstormWaiterByRound(ctxBase.runId, nodeId, round)
      if (existing && existing.status === 'pending') {
        const resume = interrupt({
          kind: 'QI_BRAINSTORM_INTERRUPT',
          waiterId: existing.id, requirementId, round, maxRounds,
          questionMd: existing.question_md, options: existing.options,
        })
        const answered = await getBrainstormWaiterById(existing.id)
        bs = rebuildAfterWaiter(bs, answered!)
        continue
      }

      // 4. 新轮：跑 LLM (硬 timeout)
      let parsed: BrainstormLlmOutput
      try {
        const llmRaw = await ctxBase.skillExecutor!({
          skill, role,
          inputs: { rawInput, history: bs.history, enrichedInput: bs.enrichedInput, round, maxRounds },
          worktreePath: String(params.worktreePath),
          timeoutMs: llmCallTimeoutMs,
        })
        parsed = parseBrainstormLlmJson(llmRaw.output)
      } catch (err) {
        bs.failedQualityRounds += 1
        if (bs.failedQualityRounds >= 2) { bs.partial = true; bs.readyForSpec = true }
        continue
      }

      if (parsed.decision === 'ready' || parsed.decision === 'fail') {
        bs = advanceBrainstormState(bs, { llmOutput: parsed, userAnswer: null, source: 'web' })
        continue
      }

      // decision='ask': 校验 5-section
      const pf = parseFiveSectionMarkdown(parsed.question ?? '')
      if (!pf.valid) {
        bs.failedQualityRounds += 1
        if (bs.failedQualityRounds >= 2) { bs.partial = true; bs.readyForSpec = true }
        continue
      }

      // 写 waiter + interrupt
      const w = await createBrainstormWaiter({
        requirementId, pipelineRunId: ctxBase.runId, threadId: String(ctxBase.runId), nodeId, round,
        questionMd: parsed.question!, options: pf.options,
        enrichedInput: bs.enrichedInput, history: bs.history, failedQualityRounds: bs.failedQualityRounds,
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      })
      scheduleBrainstormTimeout(w.id, timeoutMs, async () => {
        await markBrainstormExpired(w.id)
        await markRequirementAborted(requirementId, 'brainstorm_timeout')
      })

      const resume = interrupt({
        kind: 'QI_BRAINSTORM_INTERRUPT', waiterId: w.id, requirementId,
        round, maxRounds, questionMd: parsed.question, options: pf.options,
      })
      const answered = await getBrainstormWaiterById(w.id)
      bs = rebuildAfterWaiter(bs, answered!)
    }

    // 写 artifacts
    const { brainstormPath, enrichedInputPath } =
      await writeBrainstormArtifacts(String(params.worktreePath), requirementId, bs)

    const exec: StageExecutionResult = {
      status: 'success',
      output: `${nodeId} completed: ${bs.history.length} rounds, partial=${bs.partial}`,
    }
    return {
      currentStageIndex: index,
      stageResults: finishedResult({ ...node, name: stageName } as StageDefinition, startedAt, startedMs, exec),
      stepOutputs: {
        [nodeId]: {
          status: 'success' as const,
          output: {
            rounds: bs.history.length,
            readyForSpec: bs.readyForSpec, partial: bs.partial,
            earlyDone: bs.earlyDone ?? false,
            enrichedInputPath, brainstormPath,
          },
        },
      },
    }
  }
}
```

`rebuildAfterWaiter(bs, waiter)`：取 waiter 的 enriched_input / history snapshot + 用 chosen_option/free_text 调 advanceBrainstormState 推进。

### 4. Admin endpoints（[brainstorm.ts](../../../src/admin/routes/brainstorm.ts) 全文重写）

```typescript
// GET /admin/requirements/:id/brainstorm/state
{
  active: null | {
    waiterId, round, maxRounds, questionMd,
    options: Array<{ id, label }>,
    expiresAt: ISO,
  },
  history: Array<{
    round, questionMd, chosenOption?, freeText?, answeredAt, source
  }>,
}

// POST /admin/requirements/:id/brainstorm/answer
// Body: { chosenOption?: string, freeText?: string }
// 校验：chosenOption 必须在 active.options[].id 中；freeText 长度 ≤ 4096
// SQL: UPDATE brainstorm_waiters SET status='answered',source='web',chosen_option=$,free_text=$,answered_at=now()
//      WHERE id=$ AND status='pending' AND requirement_id=$ RETURNING *
// 0 rows → 409 already_answered（防并发竞态）
// 1 row → resumeFromBrainstorm(run_id, thread_id, { chosenOption, freeText, source: 'web' })
// 返回：{ ok: true, round, nextRound: round + 1 }
```

requirement_id 必须在 WHERE 子句里防 IDOR。

### 5. BrainstormTab + Alert + Badge

`web/src/api/brainstorm.ts`：`getBrainstormState(reqId)` + `submitBrainstormAnswer(reqId, body)`。

[BrainstormTab.tsx](../../../web/src/pages/requirement-detail/BrainstormTab.tsx) 重写：3 态渲染（empty / active / done），active 用 `react-markdown` 渲染 questionMd + Radio.Group 动态选项 + TextArea + 倒计时（`dayjs.fromNow(expiresAt)`）；提交成功后 setTimeout(2s) 轮询 GET state，最多 10 次（20s 内若 round 未变给"LLM 生成中"提示）。

新增 `web/src/pages/requirement-detail/BrainstormAlert.tsx`（顶部 L1 横幅）：active 非空时显示，CTA "去回答 →" 切换到 Brainstorm Tab。

`RequirementDetailPage.tsx` 装入 BrainstormAlert + Tab Badge（active 非空时 Badge dot）+ status 派生为 `awaiting_brainstorm`（前端 effectiveStatus 层）。

轮询：详情页 10s GET state；提交后 fast-polling 2s × 10。

### 6. init_qi_branch 同步 .claude/skills/

[init-qi-branch.ts](../../../src/pipeline/node-types/init-qi-branch.ts) 节点末尾加：

```typescript
import { promises as fsp } from 'node:fs'
import path from 'node:path'

// brainstorm-host role.md 通过 .claude/ 注入（worktree 默认 gitignore .claude/，不入 git）
try {
  const srcRoot = path.join(process.cwd(), '.claude/skills/quick-impl-artifact-author')
  const dstRoot = path.join(worktreePath, '.claude/skills/quick-impl-artifact-author')
  await fsp.cp(srcRoot, dstRoot, { recursive: true, force: true })
} catch (err) {
  ctx.log.warn?.({ err }, 'init_qi_branch: skill role.md sync failed (non-fatal)')
}
```

非 fatal — sync 失败时 brainstorm 节点跑 LLM 会 fail，但有 partial 兜底。

### 7. bootstrap.ts spec_brainstorm 节点参数补齐

[bootstrap.ts](../../../src/quick-impl/bootstrap.ts) 现有 spec_brainstorm 节点 params 中加：

```typescript
{
  stageType: 'llm_brainstorm',
  params: {
    skill: 'quick-impl-artifact-author',
    role: 'brainstorm-host',
    maxRounds: 5,
    timeoutMs: 86400000,
    requirementId: '{{vars.requirementId}}',
    rawInput: '{{triggerParams.rawInput}}',
    worktreePath: '{{vars.worktreePath}}',
  },
}
```

### 8. spec-author role.md 改造

接收 `priorBrainstormPath` 输入（spec_author 节点 params 加 `priorBrainstormPath: '{{steps.spec_brainstorm.output.brainstormPath}}'`）：

```
if priorBrainstormPath != null AND brainstorm.partial == false:
   读 enrichedInputPath JSON, 按 schema 写 spec
elif priorBrainstormPath != null AND brainstorm.partial == true:
   读 enrichedInputPath（partial）+ rawInput fallback 补 missing 字段
   spec 文档头部加 NOTE: "brainstorm partial — 部分字段从 rawInput 推断"
else:
   rawInput-only 模式（向后兼容老需求）
```

### 9. graph-runner 改动

- `dispatchInterrupt` switch 加 `case 'QI_BRAINSTORM_INTERRUPT'`：从 payload 抽 waiterId / requirementId / round / questionMd / options，发布 `brainstorm:waiting` event 给前端轮询（实际就是 waiter row 已经 created in DB,前端 GET state 自然能拿到）
- 新入口 `resumeFromBrainstorm(runId, threadId, { chosenOption, freeText, source })`：模板照 `resumeFromImInput`（race-winner claim + Command resume）
- `scheduleBrainstormTimeout`：与 `scheduleQiApprovalTimeout` 共用同一 setTimeout 调度器，加 `kind='brainstorm'` 分支
- 进程启动时跑 `reapExpiredBrainstormWaiters()`：扫 brainstorm_waiters 历史 pending 且 expires_at < now() 的，批量 expire + abort 对应 requirement（处理停机期间过期）

## 失败兜底矩阵

| 终止原因 | partial | readyForSpec | 触发处 | spec_author 行为 |
|---|---|---|---|---|
| LLM decision='ready' | false | true | node loop | 读 enrichedInput JSON，完整写 spec |
| LLM decision='fail' | true | true | node loop | partial fallback |
| failedQualityRounds ≥ 2 | true | true | node loop / parse fail | partial fallback |
| round > maxRounds | true | true | node loop cap | partial fallback |
| token budget exceeded | true | true | budget gate | partial fallback |
| skillExecutor 抛异常（连续 2 轮） | true | true | catch + failedQualityRounds++ | partial fallback |
| 24h 超时 | — | — | reaper | requirement.status='aborted' (graph thread 不再 resume) |
| 用户 abort（手动）| — | — | 手动 SQL / future endpoint | requirement.status='aborted' |

## 24h 超时实现

- waiter 创建时同步 `scheduleBrainstormTimeout(waiterId, 86400000, onExpire)`
- `onExpire`：`UPDATE brainstorm_waiters SET status='expired' WHERE id=$ AND status='pending'` → 若 update 成功（1 行）→ `markRequirementAborted(requirement_id, reason='brainstorm_timeout')`
- 进程重启时 `reapExpiredBrainstormWaiters()` 扫一遍历史
- 实现位点：[graph-runner.ts](../../../src/pipeline/graph-runner.ts) 共用 `scheduleQiApprovalTimeout` 同一 setTimeout 调度

## 测试策略

| 类型 | 测试位 | 关键 case |
|---|---|---|
| Unit | `qi-brainstorm-parser.test.ts` | parseFiveSectionMarkdown options 提取 / 边界 / 残缺 5-section |
| Unit | `qi-brainstorm-state.test.ts` | advanceBrainstormState 各 decision 分支 + cap |
| Unit | `qi-brainstorm-llm-json.test.ts` | parseBrainstormLlmJson zod / 垃圾输入 fallback |
| Unit | `brainstorm-waiter-repo.test.ts` | create / getByRound / markAnswered / markExpired SQL |
| Integration | `qi-brainstorm-node-loop.integration.test.ts` | mock skillExecutor: 5 轮完整 ask→answer→ask→ready，验证每轮 waiter row + final bs |
| Integration | `qi-brainstorm-replay.integration.test.ts` | round 2 interrupt 后强制 graph 重入，验证 existingWaiter 复用、interrupt() replay 不抛、bs 状态正确重建 |
| Integration | `qi-brainstorm-partial.integration.test.ts` | failedQualityRounds=2 / maxRounds 用尽 / budget exceeded 三条 partial 路径，spec_author 收 partial fallback input |
| Integration | `qi-brainstorm-timeout.integration.test.ts` | fake timer 推进 24h → reaper 标 expired + requirement.status='aborted' |
| Endpoint | `brainstorm-routes.test.ts` | POST answer normal / 409 并发 / 400 invalid option / 404 no waiter / GET state shape |
| UI | `BrainstormTab.test.tsx` | 三态渲染 + 提交后轮询 + 倒计时 + 动态 options |
| E2E | `qi-brainstorm-web-e2e.integration.test.ts` | 完整 trigger → answer×N → ready → spec_author 收 enrichedInput → 节点链继续 |

## 数据迁移与级联清理

- 新建 [src/db/schema-v1016.sql](../../../src/db/schema-v1016.sql)
- [src/db/migrate.ts](../../../src/db/migrate.ts) SCHEMA_FILES 末尾追加 `['v1016', 'schema-v1016.sql']`
- [src/__tests__/helpers/db.ts](../../../src/__tests__/helpers/db.ts) 同名 SCHEMA_FILES 同步追加（CLAUDE.md 约定）
- [deleteRequirement repo](../../../src/db/repositories/requirements.ts#L140)：DELETE 前先 `DELETE FROM brainstorm_waiters WHERE requirement_id = $1`（无 FK，需手动）
- 老需求兼容：requirements 表无新字段，老 req 重跑直接走新路径

## 已知 gap / 跨迭代依赖

1. **token_total 写入方缺失**（critical）：`pipeline_run_state.token_total` 没有任何写入路径，`getCumulativeTokenUsage` 永远返 0。本迭代 budget gate 代码保留但运行时永远 ok。下迭代需补 skillExecutor 返回 token usage + 写 pipeline_run_state 的 path。
2. **IM 卡片通道**：im_router brainstorm 5-section 解析未做，本迭代仅 web 通道
3. **stage indicator 视觉强化**：靠 L1 Alert + L3 Badge 提示，先不动圆圈样式
4. **管理员后门**："重置到 round=N" / "强制 expire" 等运维操作未提供 endpoint，需要时直接走 SQL

## 安全 / 审计 / 可观测性

- **Auth**：[admin/index.ts:61](../../../src/admin/index.ts#L61) `requireAuth` preHandler 自动覆盖 `/admin/*`，brainstorm 路由继承
- **IDOR**：POST answer SQL WHERE 同时校验 `requirement_id` + `status='pending'`，跨需求伪造 waiterId 拿不到
- **XSS**：BrainstormTab `react-markdown` 默认 sanitize；不渲染 raw HTML
- **入参**：chosenOption 必须在 waiter.options[].id 中；freeText 长度 ≤ 4096
- **日志**：每轮 entry pino INFO 日志（runId / round / nodeId）；reaper expired 操作 INFO；POST answer 409 WARN
- **审计**：所有 brainstorm_waiters 行保留，按 requirement_id 可完整审计交互历史

## 部署

- DB 迁移：`pnpm migrate` 加 v1016
- 后端启动顺序无变化（migrate → server）
- 前端：`web/dist/` 重新 build + serve
- 回滚：v1016 表 DROP，graph-builder 还原 skeleton 即可；brainstorm_waiters 数据保留无害

## Self-Review 备注（spec author 视角）

最后一遍扫，刻意挑刺：

1. **`rebuildAfterWaiter` 语义不严**：waiter 行存的 enriched_input/history 是"本轮入口"快照，要重建到"本轮结束"得 + chosen_option/free_text 调 advanceBrainstormState。代码段已暗示但未显式写。实现时 helper 单独抽。
2. **`getCumulativeTokenUsage` 永远返 0** → budget gate 永远 ok → 本迭代功能不被它阻塞，但生产环境无成本保护。已在"已知 gap"列。
3. **进程内 setTimeout 重启丢失** → `reapExpiredBrainstormWaiters` 起步扫一遍兜底，但不能恢复"已过期但 setTimeout 没触发"的 graph thread（graph thread 已 suspend，不会自动 abort）。需要 reaper 在 mark expired 同时调 `graphRunner.abortRun(runId)` 显式 kill thread。spec 第 9 节已写"abort 对应 requirement"，实际是 abort run 而非只 update status，实现时注意。
4. **`options` 解析依赖 5-section markdown 严格格式**：parseFiveSectionMarkdown 现实现只判 valid，扩展 options 提取要兼容 `**A.**` / `**A：**` / `A.` 多种 LLM 输出风格 — 测试要覆盖。
5. **`writeBrainstormArtifacts` 路径与 git 关系**：写到 `docs/brainstorm/qi-{id}.{md,json}` 在 worktree 里。`docs/brainstorm/` 入 git 还是 ignore？跟随 spec / plan / dev artifact 一致 — **入 git**（这样 commit_push 节点会带上）。需要 `.gitignore` 不忽略 `docs/brainstorm/`。
6. **`spec_author` 必须等 spec_brainstorm 完成才入** — 现有 bootstrap.ts 拓扑已经是 init_branch → spec_brainstorm → spec_author 串行，OK。
7. **`source` 字段对 'im' 留 hook**：本迭代不实现 IM 通道，POST answer endpoint 默认填 'web'，未来 IM endpoint 可填 'im'，schema 字段无需改。

按这 7 点修正后 spec 闭环。
