# Quick-Impl Day 0 验证报告

**验证日期**：2026-05-07 · **验证人**：sherryswift1019 · **依据 PRD**：[prd-quick-impl.md §17.1](prds/prd-quick-impl.md)

## 总览

5 项验证全部通过。**无需走 Plan B**，PRD 设计可按原方案进入 Phase 1 编码。Day 0 用时 < 半天（实际查文件，未跑代码）。

| # | 验证项 | 结论 | 引用位置 |
|---|---|---|---|
| 1 | porygon 暴露 ClaudeRunner kill/abort 接口 | ✅ 多层暴露 | porygon@0.10.0 d.ts |
| 2 | porygon 暴露 token 计数 | ✅ AgentResultMessage 含 inputTokens/outputTokens/costUsd | 同上 |
| 3 | LangGraph 运行中 cancel 支持 | ✅ 原生 AbortSignal via RunnableConfig.signal | @langchain/core@1.1.40 |
| 4 | pipeline 主表实际名 | ✅ 表名为 `test_pipelines`（非 `pipelines`） | schema-v3.sql |
| 5 | 现有 system_managed 类标记 | ❌ test_pipelines 没有；但 capabilities.is_system 是 v4 已有先例 | schema-v4.sql |

下面详述每项。

---

## 1. Porygon kill / abort 接口 ✅

`@snack-kit/porygon@0.10.0` 在多个抽象层都暴露了中止能力：

```ts
// 顶层 API — Porygon 实例方法
class Porygon {
  abort(backend: string, sessionId: string): void
}

// 适配器层
interface IAgentAdapter {
  abort(sessionId: string): void
}

// 子进程层 — 一次性进程
class EphemeralProcess {
  /** 终止进程：先发送 SIGTERM，超时后发送 SIGKILL */
  terminate(): void
  get pid(): number | undefined
}

// query/run 调用支持 AbortSignal
class EphemeralProcess {
  execute(options: SpawnOptions, abortSignal?: AbortSignal): Promise<ProcessResult>
  executeStreaming(options: SpawnOptions, abortSignal?: AbortSignal): AsyncGenerator<string>
}

// 抽象基类内部维护 AbortController
abstract class AbstractAgentAdapter {
  protected readonly abortControllers: Map<string, AbortController>
  protected createAbortController(sessionId: string): AbortController
  abort(sessionId: string): void  // 调用对应 controller.abort()
}
```

### 对 PRD §12.7 abort 流程的影响

不需要自己包装 child_process。skill-runner 在启 ClaudeRunner 时拿一个 sessionId，POST /abort 时调 `porygon.abort(backend, sessionId)` 即可。pid 也能直接拿到（`process.pid`），lockfile 机制可保留。

---

## 2. Porygon token 计数 ✅

`AgentResultMessage` 类型显式包含 token / 耗时 / 成本字段：

```ts
interface AgentResultMessage extends BaseAgentMessage {
  type: "result"
  text: string
  durationMs?: number
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
}
```

每次 ClaudeRunner.run() 完成会 yield 一条 `type: "result"` 消息，skill-runner 在收 stream 时捕获该消息即可。

### 对 PRD §16.3 的影响

`qi.skill_finished` 事件的 `tokensUsed` 字段直接拿 `inputTokens + outputTokens` 写入。Phase 1 即可上报，不需要打折。

---

## 3. LangGraph 原生 AbortSignal 支持 ✅

LangGraph 1.2.9 + LangChain Core 1.1.40。LangChain Core 的 `RunnableConfig` 接口（在 [@langchain/core/runnables/types.d.ts:64](../node_modules/.pnpm/@langchain+core@1.1.40_ws@8.20.0/node_modules/@langchain/core/dist/runnables/types.d.ts) 第 64-68 行）原生有：

```ts
interface RunnableConfig {
  /**
   * Abort signal for this call.
   * If provided, the call will be aborted when the signal is aborted.
   */
  signal?: AbortSignal
  // ... 其他字段
}
```

LangGraph 的 `graph.stream(input, config)` 接受 `RunnableConfig`，即所有 LangGraph 调用都可以挂 signal。当 signal abort 时，pregel 内部会在下个节点边界抛错跳出 stream loop。

### 对 PRD §12.7 abort 流程的影响

**不需要新增 graph-runner.cancel() 公开 API，只需小改 streamGraph**：

```typescript
// 现 graph-runner.ts:
async function streamGraph(ctx, input) {
  await graph.stream(input, { configurable: { thread_id: ctx.runId } })
}

// 改后：
async function streamGraph(ctx, input, signal?: AbortSignal) {
  await graph.stream(input, {
    configurable: { thread_id: ctx.runId },
    signal,
  })
}

// runRegistry 改为存 AbortController（非现在的 timer/state）
const runRegistry = new Map<number, { controller: AbortController, ... }>()

// quick-impl 的 abort 入口：
runRegistry.get(pipelineRunId)?.controller.abort()
```

**改动比 PRD 估的更小**——不是新增主路径接口，是给现有 streamGraph 传一个 optional 参数。回归面相应缩小。

PRD §12.7 / §17.1 / §19 #17 描述需要相应更新（Plan B 不再必要）。

---

## 4. Pipeline 主表实际名 ✅（但非预期）

PRD 假设表名是 `pipelines`，**实际是 `test_pipelines`**（[schema-v3.sql:1](../src/db/schema-v3.sql)）。这是历史命名 —— 该表既存放原本的「测试流水线」，schema-v18 之后扩展为通用 pipeline（加 graph 列）。

### 对 PRD 的影响

下面这些章节涉及表名，需要全部把 `pipelines` 改为 `test_pipelines`：

- §10.1：「`pipelines` 表新列 `system_managed`」→ 改 `test_pipelines.is_system`（按现有 capabilities 命名风格，见下条）
- §17.1 Day 0 验证表中「pipeline 主表实际表名」
- §3.2 复用模块描述中可能涉及
- 摘要影响范围表「DBA / 数据库维护者」一行

外键引用同样：
- `test_runs.pipeline_id` 已经引用 `test_pipelines(id)`
- 我们的 `requirements.pipeline_run_id` 应引用 **`test_runs(id)`**（不是想象中的 `pipeline_runs`）

需要更新 schema-v60 设计：

```sql
-- PRD §4.1 当前写：
pipeline_run_id INT REFERENCES pipeline_runs(id)
-- 应改为：
pipeline_run_id INT REFERENCES test_runs(id)
```

---

## 5. system_managed 类标记 ❌（无现成，但有命名先例）

`test_pipelines` 表当前列（v3 + v4/v6/v18/v19/v50/v53 累加）：

```
id, product_line_id, name, description, stages, server_roles, enabled,
created_at, updated_at, trigger_params, variables, graph,
default_pipeline_id, container_image, param_schema, im_prompt
```

**没有 system_managed / is_system / builtin / protected 类列**。

但 [schema-v4.sql:28](../src/db/schema-v4.sql) 给 capabilities 表加了：

```sql
ALTER TABLE capabilities ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT TRUE;
```

这是项目已有命名先例（区分系统内置 capability vs 用户创建）。

### 决策：用 `is_system`，不用 `system_managed`

schema-v60 给 test_pipelines 加：

```sql
ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE test_pipelines SET is_system = TRUE WHERE name = 'quick-impl';
```

PRD §10.1 把 `system_managed=true` 全文替换为 `is_system=true`。前端管理后台 Pipeline 管理页过滤掉 `is_system=true` 的项（沿用现有过滤模式，capabilities 页应已有相似过滤可参考）。

---

## PRD 修订要点（落到代码前必须先改文档）

总结需要改 PRD 的位置：

| PRD 位置 | 当前内容 | 改为 |
|---|---|---|
| §3.2 + §4.1 + §4.2 + §17.1 | `pipeline_runs` | `test_runs` |
| §10.1 + §17.1 + 摘要影响表 | `pipelines.system_managed` | `test_pipelines.is_system` |
| §10.1 节点过滤 | `category='quick_impl_only'` | 实际看 [pipeline_node_types](../src/db/schema-v27.sql) 现有 category 的取值，不冲突即用 |
| §12.7 / §17.1 / §19 #17 | 「graph-runner cancel API 是新增主路径」 | 「graph-runner streamGraph 加 optional `signal` 参数」更轻量 |
| §16.3 token 监控 | 「需要确认 porygon 是否暴露」 | 「直接读 AgentResultMessage 的 inputTokens/outputTokens」 |
| §17.1 Day 0 验证表 | 5 项 + Plan B | 全部已验，标记结论 + 链接到本文档 |

## 结论

**可以正式开 Phase 1 编码**。PRD 改动是文档级别的措辞调整 + 1 个表名 + 1 个列名，没有架构层返工。

下一步：

1. 我把上面 6 处 PRD 修订改完
2. 然后 Day 1 起按 [prd-quick-impl.md §18 Phase 1 排期](prds/prd-quick-impl.md) 开干
   - Day 1-2: schema-v60 + repositories + migration tests
   - Day 3-4: worktree manager + skill-runner
   - ...
