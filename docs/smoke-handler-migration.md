# 冒烟：phase 4 handler → pipeline DAG 迁移

Phase 4 把 3 个非 LLM 决策类 capability handler（`request_handover` / `notify_bug` / `create_mr`）迁成 pipeline DAG，靠 `PIPELINE_DAG_HANDLERS` 环境变量做双轨路由：

- 命中 → 走 `internal_capability_pipelines` 表里映射的 pipeline（DAG 用 sql_query CTE + fan_out + db_update 节点实现）
- 不命中 → 走原 handler 路径（handler 文件本期保留作火路）

T5（2026-04-27）起默认值改为 `'request_handover,notify_bug,create_mr'`，3 个 capability 默认全切 pipeline。

## 前置

- 数据库已 migrate 到 v41（`pnpm migrate`）
- `internal_capability_pipelines` 表存在三行：
  ```bash
  pnpm migrate
  psql $DATABASE_URL -c "SELECT capability_key, pipeline_id FROM internal_capability_pipelines"
  ```
  应输出 `request_handover` / `notify_bug` / `create_mr` 三行。空表说明 `product_lines` 表为空，需先在管理后台建一条产线再重跑 migrate 让 seed 生效。
- 三条 internal pipeline 存在：
  ```bash
  psql $DATABASE_URL -c "SELECT name FROM test_pipelines WHERE name LIKE '%-internal'"
  ```
  应输出 `handover-internal` / `notify-internal` / `create-mr-internal`。

## 场景 1：默认走 pipeline 路径（happy path）

**步骤**：在测试环境跑一次 bug 分析全链路（issue 提交 → analyze_bug → fix_bug → create_mr → notify_bug），观察日志：

```
[AgentCoordinator] triggering: create_mr
[AgentCoordinator] pipeline run #N started for "create_mr" (PIPELINE_DAG_HANDLERS flag)
```

而**不是**：

```
[AgentCoordinator] completed: create_mr
[CreateMr] handler 入口...
```

**预期链路**：

1. `coordinator.triggerCapability('create_mr', ...)` 进入 → 读 `process.env.PIPELINE_DAG_HANDLERS`，未设则用默认值 `'request_handover,notify_bug,create_mr'`
2. flag 命中 + `getInternalPipelineId('create_mr')` 返回 pipeline_id → `runPipelineAsCapability(pipelineId, opts)`
3. Pipeline run 启动，graph 4 节点（`compute_mr_plan` / `fan_out_create_mrs` / `write_success_events` / `write_failed_events`）依次执行
4. `bug_fix_events` 表新增 `code='create_mr', status='success'` 行，每个修复成功的 project 一行
5. 接续 `notify_bug` 同样走 pipeline 路径，DM 发到 owner

**验证点**：
- `test_runs` 表新增三行（每个 capability 一次 pipeline 运行）：
  ```sql
  SELECT id, pipeline_id, status, started_at FROM test_runs ORDER BY id DESC LIMIT 5
  ```
- `bug_fix_events` 行内容跟旧 handler 写出的一致（schema 严格对等，参考行为对等测试断言项）
- GitLab 收到 MR creation API call、IM 群收到 owner DM

## 场景 2：显式回退到 handler 路径（回滚演练）

**目的**：验证生产撞 pipeline bug 时能立刻回 handler 路径。

**步骤**：

```bash
export PIPELINE_DAG_HANDLERS=''
pnpm dev  # 或 docker-compose restart chatops
```

再跑一次 capability 触发（手动调 `/admin/api/_e2e/...` 或 IM 群对话）。日志应见：

```
[CreateMr] handler 入口
[CreateMr] project xxx mr created: ...
```

**预期**：handler 路径全部正常工作，三个 handler 文件未删，火路完整。

**部分回滚**：只想回退某一个 capability，flag 可设为子集，例如：

```bash
export PIPELINE_DAG_HANDLERS='request_handover,notify_bug'
# create_mr 回 handler 路径，其他两个仍走 pipeline
```

## 场景 3：行为对等测试

每个 capability 都有 handler-vs-pipeline 行为对等 integration test，确认两条路径写入 `bug_fix_events` / 调用 GitLab API / 发送 IM 内容严格对等。

```bash
npx vitest run src/__tests__/integration/handler-vs-pipeline-handover.test.ts
npx vitest run src/__tests__/integration/handler-vs-pipeline-notify.test.ts
npx vitest run src/__tests__/integration/handler-vs-pipeline-mr.test.ts
```

**预期**：18 个 case 全绿（T2: 3 case，T3: 8 case，T4: 5 case + 2 个相关）+ 10 个 `it.todo` KD 占位（已知错误码差异，详见下方 KD list）。

## 场景 4：DAG 节点级排错

如果 pipeline 路径报错，先看 `test_runs.error_message` 和 stage_results：

```sql
SELECT id, status, error_message, stage_results
  FROM test_runs WHERE pipeline_id IN (
    SELECT pipeline_id FROM internal_capability_pipelines
  )
  ORDER BY id DESC LIMIT 10
```

`stage_results` 是 JSON 数组，每个节点一个 entry：
```json
[
  {"name": "compute_notify_plan", "status": "success", "output": "{\"rows\":[...]}"},
  {"name": "send_dms", "status": "success", "output": "{\"items\":[...],\"failed\":[]}"},
  {"name": "write_success_events", "status": "success", "output": "{\"rowsAffected\":1}"},
  ...
]
```

常见排错点：

- **compute_notify_plan SQL 报错**：`build_notify_message` 函数签名错或 input 字段缺失 → 检查 schema-v40 是否完整 apply
- **send_dms fan_out items[] 空**：sql_query 返回 0 rows（report_not_found / no_recipients / should_notify=false 的 4 种 noop scenario）→ 这是 KD-1/KD-2 已知差异
- **DM 发送 failed**：检查 `fan_out.output.failed[].error`（`adapter not registered` / `userId not found` / IM API 错误等），handler 路径同样会失败但错误码是 `im_api_error`
- **fan_out body 内 `{{owner.x}}` 解析为 literal**：dm/http executor 的 internal resolveVariables 没起作用 → 重启服务确认 phase 4 T3 改动已生效

## 已知差异（KD list）

迁移过程中接受 5 类错误码差异，handler 路径返回特定错误码时 pipeline 路径表现为 success-noop 或 success-with-failed-items（side effects 严格对等）：

| KD | Scenario | Handler 错误码 | Pipeline 行为 | 影响 |
|---|---|---|---|---|
| KD-1 | report_not_found | `report_not_found` | sql_query 返回空 rows，pipeline success-noop | 无 DM、无 event 写入（与 handler 一致） |
| KD-2 | no_recipients (notify_bug) | `no_recipients` | 同 KD-1 | 同上 |
| KD-3 | no_primary_issue (create_mr) | `no_primary_issue` | 同 KD-1 | 同上 |
| KD-4 | no_successful_fixes (create_mr) | `no_successful_fixes` | 同 KD-1 | 同上 |
| KD-5 | im_api_error / gitlab_api_error | 整体 success=false | onItemFailure=continue → 整体 success；写 failed event | bug_fix_events 失败行写入跟 handler 完全对等 |

KD-1/KD-4 修复需要 phase 3 deferred 的 `shortCircuitWhen` wired 后引入 `assert` 节点；T5 不做。

## 全量稳定后删 handler 的 checklist

production 灰度稳定 1-2 周后（业务有数据 ≥ 100 次成功调用 + 0 次回退到 handler）才动手做 plan 原意的 T5「删 handler + 删表」：

- [ ] 1-2 周生产观察期：无 `[AgentCoordinator] runPipelineAsCapability failed` 日志、无 `[Coordinator] no handler registered` 错误（说明 flag 一直命中、pipeline 路径稳定）
- [ ] grep `bug_fix_events` 表，确认 `code IN ('handover','notify','create_mr')` 的行最近 1-2 周全部由 pipeline 写入（status / data 字段格式与 handler 时期一致）
- [ ] 删 `src/agent/handover/request-handover-handler.ts` / `src/agent/notify/notify-handler.ts` / `src/agent/mr/mr-handler.ts`
- [ ] 删对应 `register*Handler()` 调用 + `src/server.ts` 中的引用
- [ ] schema-v42: `DROP TABLE internal_capability_pipelines` —— 改 coordinator 用 hardcode `capability_key → pipeline_name` 映射启动时查 pipeline_id 缓存
- [ ] 改 `coordinator.ts:triggerCapability`：去掉 `isPipelineDagEnabled` flag 检查，3 个 capability 永远走 pipeline
- [ ] 删 `PIPELINE_DAG_HANDLERS` 环境变量文档
- [ ] 改 / 删 3 个行为对等 integration test（handler 路径不存在了，这些测试只剩 pipeline-only 验证）

## 回滚机制

**单次回滚**：`export PIPELINE_DAG_HANDLERS='' && restart` —— 立即回到 handler 路径，**不需要回滚数据库**（schema-v37/v40/v41 的表结构不影响 handler 路径）。

**永久回滚（如要彻底放弃 phase 4 迁移）**：

1. 回 `process.env.PIPELINE_DAG_HANDLERS=''`（或 unset） + 改 coordinator.ts 默认值改回 `''`
2. 三条 internal pipeline 留在 DB 不影响（只是 fan_out 不再被触发）
3. 如想清场：`DELETE FROM internal_capability_pipelines; DELETE FROM test_pipelines WHERE name LIKE '%-internal'`

## 相关 commit

- T1 (`bbd9b84`)：基础设施 — feature flag + internal_capability_pipelines 表 + L1 pipeline 种子
- T2 (`f6c55fb`)：L1 行为对等 — request_handover
- T3 (`28e3bf5`)：L2 迁移 + 行为对等 — notify_bug（schema-v40 + dm.ts extraMeta）
- T4 (`5425b17`)：L3 迁移 + 行为对等 — create_mr（schema-v41 + http.ts extraMeta + coerceScalar）
- T5 (`6652e55`)：默认 flag 切为 pipeline 路径

## 相关文档

- [phase 4 plan](./superpowers/plans/2026-04-26-capability-pipeline-refactor-phase4.md)
- [总 spec §6](./superpowers/specs/2026-04-26-capability-pipeline-refactor-design.md)
- [T3 design 笔记（含 4 节点 DAG 详解 + KD-1~KD-5 处理）](./superpowers/specs/2026-04-27-phase4-t3-notify-design.md)
- [pipeline DSL 节点类型冒烟](./smoke-pipeline-node-types.md)
