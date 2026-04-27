# Phase 4 T3 — notify_bug handler → pipeline DAG 迁移设计

- **日期**：2026-04-27
- **状态**：design 待 review，未开 implementer
- **上游**：[2026-04-26 capability/pipeline 重构 spec §6.3](./2026-04-26-capability-pipeline-refactor-design.md)、[phase 4 plan T3](../plans/2026-04-26-capability-pipeline-refactor-phase4.md)
- **范围决策**：30min design + 全 8 scenario 一次性迁移（用户 2026-04-27 拍板，Option A）

---

## 0. 摘要（TL;DR）

把 521 行的 [notify-handler.ts](../../../src/agent/notify/notify-handler.ts) 迁移成 **5 节点 pipeline DAG**，靠**一条 PostgreSQL CTE + jsonb_agg** 把 `decideScenario + buildMessage + buildOwnerMap` 三层 imperative 逻辑全压到 SQL 里——这样**不必扩 graph-builder 的 conditionMatches**（这是 phase 3 deferred 的最大盲点），也不必动 fan_out 嵌套限制和 template_render 条件。

唯一需要改的代码是 [`src/pipeline/node-types/dm.ts`](../../../src/pipeline/node-types/dm.ts)：在节点 output 里增加一个 **`extraMeta` 透传字段**，让下游 db_update 节点能从 fan_out items[] 里取 messageKind/mrIids 等元数据写 `bug_fix_events(code='notify')`。

接受 3 个**已知差异**（与 handler 不严格对等的 edge case），都属于"少数路径错误码不匹配"，记录在 §6。

---

## 1. notify_handler 现状摸底

| Sub-step | 代码位置 | 内容 | 复杂度 |
|---|---|---|---|
| `gatherProjects` | notify-handler.ts:196 | per-project 查 fix_attempt / create_mr / ai_review 各取最新一条 | per-project 3 次查询 |
| `collectProjectPaths` | notify-handler.ts:222 | 优先 `findDistinctProjects`，回退 `scope_identified` | 简单 |
| `decideScenario` | notify-handler.ts:233 | 4 层优先级状态机：handover > approval > l4 > fix 结果 | **8 种 MessageKind 输出** |
| `shouldNotifyOwners` | notify-handler.ts:341 | 只 fix_success/fix_success_review_concerns/l4_created/handover 这 4 种发 DM | 简单 |
| `buildOwnerMap` | notify-handler.ts:159 | per-project 反查 `projects.owner_id`，按 ownerId 聚合 projectPaths/mrIids/mrUrls/reviewLabels | group-by |
| `buildMessage` | notify-handler.ts:377 | 4 种文案 × 多个条件分支（attemptLine/ownerProjectsLine/commentLine/failureLine） | **多模板 + 字典** |
| `reasonToCn` | notify-handler.ts:358 | 7 项 reason → 中文映射字典 | 简单 |
| `sendOne` | notify-handler.ts:469 | 发 DM + 写 `bug_fix_events(code='notify')`，成功/失败各写一行 | 双状态写事件 |
| 错误码 | 散落 handleNotify 各处 | `missing_reportId / report_not_found / no_recipients / no_adapter / im_api_error` | 5 种 |

handler 的 **3 个事件 side effect**（行为对等测试要核对的）：
1. **DM 发送**：`adapter.sendDirectMessage(userId, {text})`
2. **success 事件**：`bug_fix_events(reportId, code='notify', status='success', data={userId, role, messageKind, mrIids})`
3. **failed 事件**：`bug_fix_events(reportId, code='notify', status='failed', data={...同上 + error})`

---

## 2. Pipeline DSL 现状盲点 & T3 阻塞排查

| # | 阻塞 | 现状代码 | 解决方向 |
|---|------|---------|---------|
| **B1** | 边 `when` 条件 evaluator 极弱（不能跨节点访问 `steps.x.output.y`） | `graph-builder.ts:853 conditionMatches` 仅识别 `onSuccess`/`onFailure`/`status === 'X'`/`output.includes('X')` | **避开**：scenario 路由全部塞 SQL，不用边路由 |
| **B2** | `template_render` 不支持 if/else | `template-render.ts:64` 单纯 `resolveVariables` | **避开**：4 种文案在 SQL CASE WHEN 拼好成 `message_text` 字段 |
| **B3** | `fan_out` 禁止嵌套 + body 节点之间不能 chain stepOutputs | `fan-out.ts:206` 显式抛错；body 是 plain `for` loop，无 graph routing | **避开**：扁平化为「单 sql_query 输出 owners[] → 单层 fan_out 跑 dm」 |
| **B4** | `dm` 节点失败语义只回 status='failed'，不写 `bug_fix_events` | `dm.ts:50` try/catch 只回 NodeResult | **小改 dm 节点**：output 加 `extraMeta` 透传字段，让 fan_out 后的 db_update 节点统一从 `fan_out.output.items[]` 和 `failed[]` 写事件 |
| **B5** | `decideScenario` 8 种 boolean 状态机 | imperative 90 行 TS | **塞进 SQL**：CTE + EXISTS + CASE WHEN |
| **B6** | `reasonToCn` 7 项字典 | `notify-handler.ts:358` Record 字面量 | **塞进 SQL**：CASE WHEN 在 message_text 拼接处展开 |
| **B7** | `buildMessage` 4 种文案条件分支 | imperative if/else + Array.join | **塞进 SQL**：每种 scenario 一个 format() 表达式，外层 CASE 选 |
| **B8** | `buildOwnerMap` per-project 反查 owner + group-by 聚合 | imperative for + Map | **塞进 SQL**：JOIN projects + GROUP BY owner_id + jsonb_agg |
| **B9** | 5 种错误码（missing_reportId / report_not_found / no_recipients / no_adapter / im_api_error） | handler 各分支硬编码 | **接受 3 个已知差异**（详见 §6），仅 missing_reportId 在 pipeline 启动前由 trigger_params 校验拦下 |

**关键洞察**：B5/B6/B7/B8 全塞 SQL 后，B1/B2/B3 自然不再阻塞。只剩 B4 需要改 5 行 dm.ts。

---

## 3. Pipeline DAG 设计（5 节点）

```
┌────────────────────────────────────────────┐
│ 1. compute_notify_plan (sql_query)         │
│    输入: triggerParams.reportId             │
│    输出 rows: [                             │
│      { ownerId, projectPaths, mrIids,      │
│        mrUrls, reviewLabels,               │
│        scenarioKind, shouldNotify,         │
│        messageText }                       │
│    ]                                       │
└──────────┬─────────────────────────────────┘
           ↓
┌────────────────────────────────────────────┐
│ 2. send_dms (fan_out, source = rows)       │
│    body: [send_one_dm (dm)]                │
│    onItemFailure: continue                 │
│    输出: { items: [...], failed: [...] }   │
└──────────┬─────────────────────────────────┘
           ↓
┌────────────────────────────────────────────┐
│ 3. write_success_events (db_update)        │
│    INSERT INTO bug_fix_events ...          │
│    SELECT FROM jsonb_array_elements        │
│      (steps.send_dms.output.items)         │
└──────────┬─────────────────────────────────┘
           ↓
┌────────────────────────────────────────────┐
│ 4. write_failed_events (db_update)         │
│    INSERT INTO bug_fix_events ...          │
│    SELECT FROM jsonb_array_elements        │
│      (steps.send_dms.output.failed)        │
└────────────────────────────────────────────┘
```

只用 4 个 stage（数完上面是 4 个，第 5 个是把 `compute_notify_plan` 早期失败时整体 abort 的 guard，下面 §3.5 说）。

### 3.1 节点 1：`compute_notify_plan` (sql_query)

**职责**：报告查询 + per-project 元数据汇总 + scenario 判定 + reasonToCn + ownerMap 构造 + 4 种文案拼接，**全压到一条 CTE**。

```sql
WITH report AS (
  SELECT id, level, classification, issue_id, issue_url,
         root_cause_summary, primary_project_path, product_line_id
  FROM bug_analysis_reports WHERE id = $1
),
latest_handover AS (
  SELECT data FROM bug_fix_events
  WHERE report_id = $1 AND code = 'handover' AND status = 'success'
  ORDER BY id DESC LIMIT 1
),
latest_approval_decision AS (
  SELECT (data->>'decision') AS decision FROM bug_fix_events
  WHERE report_id = $1 AND code = 'approval'
  ORDER BY id DESC LIMIT 1
),
scope_paths AS (
  SELECT DISTINCT project_path FROM bug_fix_events
  WHERE report_id = $1 AND project_path IS NOT NULL
    AND code IN ('scope_identified', 'fix_attempt', 'create_mr')
),
per_project AS (
  SELECT
    sp.project_path,
    (SELECT status FROM bug_fix_events WHERE report_id = $1
       AND project_path = sp.project_path AND code = 'fix_attempt'
       ORDER BY id DESC LIMIT 1) AS fix_status,
    (SELECT data->>'error' FROM bug_fix_events WHERE report_id = $1
       AND project_path = sp.project_path AND code = 'fix_attempt' AND status = 'failed'
       ORDER BY id DESC LIMIT 1) AS fix_error,
    (SELECT (data->>'mrIid')::int FROM bug_fix_events WHERE report_id = $1
       AND project_path = sp.project_path AND code = 'create_mr' AND status = 'success'
       ORDER BY id DESC LIMIT 1) AS mr_iid,
    (SELECT data->>'mrUrl' FROM bug_fix_events WHERE report_id = $1
       AND project_path = sp.project_path AND code = 'create_mr' AND status = 'success'
       ORDER BY id DESC LIMIT 1) AS mr_url,
    (SELECT data->>'label' FROM bug_fix_events WHERE report_id = $1
       AND project_path = sp.project_path AND code = 'ai_review'
       ORDER BY id DESC LIMIT 1) AS review_label
  FROM scope_paths sp
),
scenario AS (
  SELECT
    CASE
      WHEN EXISTS (SELECT 1 FROM latest_handover) THEN 'handover'
      WHEN (SELECT decision FROM latest_approval_decision) = 'rejected' THEN 'approval_rejected'
      WHEN (SELECT decision FROM latest_approval_decision) = 'timeout' THEN 'approval_timeout'
      WHEN (SELECT decision FROM latest_approval_decision) = 'retry_analysis' THEN 'approval_retry_analysis'
      WHEN (SELECT classification = 'bug' AND level = 'l4' FROM report)
        AND NOT EXISTS (SELECT 1 FROM per_project WHERE mr_iid IS NOT NULL)
      THEN 'l4_created'
      WHEN EXISTS (SELECT 1 FROM per_project WHERE fix_status = 'failed')
        AND NOT EXISTS (SELECT 1 FROM per_project WHERE mr_iid IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM per_project
          WHERE fix_status = 'success' AND mr_iid IS NOT NULL
        )
      THEN 'fix_failed'
      WHEN (SELECT count(*) FROM per_project) > 0
        AND NOT EXISTS (SELECT 1 FROM per_project WHERE fix_status != 'success' OR mr_iid IS NULL)
      THEN
        CASE WHEN EXISTS (SELECT 1 FROM per_project WHERE review_label = 'ai-needs-attention')
             THEN 'fix_success_review_concerns'
             ELSE 'fix_success'
        END
      WHEN EXISTS (SELECT 1 FROM per_project WHERE mr_iid IS NOT NULL)
      THEN
        CASE WHEN EXISTS (SELECT 1 FROM per_project WHERE review_label = 'ai-needs-attention')
             THEN 'fix_success_review_concerns'
             ELSE 'fix_success'
        END
      ELSE 'fix_failed'
    END AS kind
),
should_notify AS (
  SELECT (SELECT kind FROM scenario) IN
    ('fix_success', 'fix_success_review_concerns', 'l4_created', 'handover') AS yes
),
owner_plan AS (
  SELECT
    p.owner_id,
    jsonb_agg(pp.project_path ORDER BY pp.project_path) AS project_paths,
    jsonb_agg(pp.mr_iid ORDER BY pp.project_path) FILTER (WHERE pp.mr_iid IS NOT NULL) AS mr_iids,
    jsonb_agg(pp.mr_url ORDER BY pp.project_path) FILTER (WHERE pp.mr_url IS NOT NULL) AS mr_urls,
    jsonb_agg(pp.review_label ORDER BY pp.project_path) AS review_labels
  FROM per_project pp
  JOIN projects p ON p.gitlab_path = pp.project_path
  WHERE p.owner_id IS NOT NULL AND p.owner_id != ''
  GROUP BY p.owner_id
)
SELECT
  o.owner_id,
  o.project_paths,
  COALESCE(o.mr_iids, '[]'::jsonb) AS mr_iids,
  COALESCE(o.mr_urls, '[]'::jsonb) AS mr_urls,
  o.review_labels,
  (SELECT kind FROM scenario) AS scenario_kind,
  (SELECT yes FROM should_notify) AS should_notify,
  -- 文案在 SQL 里拼好（4 种 scenario 各自的 message_text）
  build_notify_message(
    (SELECT kind FROM scenario),
    o.project_paths,
    o.mr_urls,
    o.mr_iids,
    o.review_labels,
    (SELECT root_cause_summary FROM report),
    (SELECT issue_url FROM report),
    (SELECT issue_id FROM report),
    (SELECT data FROM latest_handover)
  ) AS message_text
FROM owner_plan o
WHERE (SELECT yes FROM should_notify);
```

`build_notify_message(...)` 是一个 **PL/pgSQL 函数**（在 schema-v40 里 CREATE FUNCTION），把 4 种 scenario 的文案拼接逻辑封装起来——直接写 inline CASE WHEN 也可以但 message_text 长度估计 1.5KB+，inline 太丑。推荐函数化。

**`reasonToCn` 字典**也作为该函数内的 CASE WHEN 实现：
```sql
-- 函数内片段
v_reason_cn := CASE p_handover_data->>'reason'
  WHEN 'fix_exhausted' THEN 'AI 修复多次未通过'
  WHEN 'revise_exhausted' THEN 'AI 修订多次仍未通过'
  WHEN 'l4_manual' THEN 'Bug 需架构级改动，AI 无法自动修复'
  WHEN 'low_confidence' THEN 'AI 分析置信度过低'
  WHEN 'user_requested' THEN '用户在前端主动请求转人工'
  WHEN 'owner_label' THEN '你在 GitLab 标记了 needs-manual'
  WHEN 'tag_unrevisable' THEN 'tag 版本 Bug 无法自动处理'
  ELSE COALESCE(p_handover_data->>'reason', 'AI 无法继续')
END;
```

### 3.2 节点 2：`send_dms` (fan_out)

```yaml
- id: send_dms
  stageType: fan_out
  params:
    source: "{{steps.compute_notify_plan.output.rows}}"
    as: owner
    parallel: 5
    onItemFailure: continue
    body:
      - id: send_one_dm
        nodeTypeKey: dm
        params:
          platform: dingtalk
          userId: "{{owner.owner_id}}"
          text: "{{owner.message_text}}"
          extraMeta:                           # ← 新增字段，dm executor 透传到 output
            ownerId: "{{owner.owner_id}}"
            messageKind: "{{owner.scenario_kind}}"
            mrIids: "{{owner.mr_iids}}"
```

`should_notify=false` 的 scenario（fix_failed / approval_rejected / approval_timeout / approval_retry_analysis）→ compute_notify_plan 输出 0 rows → fan_out 跑 0 次 → 整体 success-noop。这与 handler 行为一致（`return { success: true, output: '场景 xxx 无需发送 DM' }`）。

### 3.3 节点 3：`write_success_events` (db_update)

```yaml
- id: write_success_events
  stageType: db_update
  params:
    sqlTemplate: |
      INSERT INTO bug_fix_events (report_id, project_path, code, status, data)
      SELECT
        $1, NULL, 'notify', 'success',
        jsonb_build_object(
          'userId',      item->'extraMeta'->>'ownerId',
          'role',        'owner',
          'messageKind', item->'extraMeta'->>'messageKind',
          'mrIids',      item->'extraMeta'->'mrIids'
        )
      FROM jsonb_array_elements($2::jsonb) item
    params:
      - "{{triggerParams.reportId}}"
      - "{{steps.send_dms.output.items | jsonStringify}}"
```

### 3.4 节点 4：`write_failed_events` (db_update)

```yaml
- id: write_failed_events
  stageType: db_update
  params:
    sqlTemplate: |
      INSERT INTO bug_fix_events (report_id, project_path, code, status, data)
      SELECT
        $1, NULL, 'notify', 'failed',
        jsonb_build_object(
          'userId',      f->'item'->>'owner_id',
          'role',        'owner',
          'messageKind', f->'item'->>'scenario_kind',
          'mrIids',      f->'item'->'mr_iids',
          'error',       f->>'error'
        )
      FROM jsonb_array_elements($2::jsonb) f
    params:
      - "{{triggerParams.reportId}}"
      - "{{steps.send_dms.output.failed | jsonStringify}}"
```

### 3.5 早返/abort 保护

`compute_notify_plan` 节点输出空 rows 的两种情况：
1. `report_not_found`（id 错）
2. `should_notify = false`（fix_failed / approval_* 系列）

两者**都不算**节点 failed —— sql_query 节点对空 rows 仍回 success。这导致后续 fan_out 跑 0 次、db_update 跑 0 行 INSERT，整个 pipeline success-noop。

**1 与 2 在 pipeline 路径上无法区分**——这是 §6 的「已知差异 1」。如果想区分，需要 phase 3 deferred 的 `shortCircuitWhen` wired，或者引入新的 `assert` 节点类型。**T3 不做**，记录为 deferred。

---

## 4. dm executor 改造点（仅有的代码改动）

文件：[`src/pipeline/node-types/dm.ts`](../../../src/pipeline/node-types/dm.ts)

```typescript
// 改 1：params 接受可选的 extraMeta 透传字段
const extraMeta = params.extraMeta as Record<string, unknown> | undefined

// 改 2：success output 增加 extraMeta（如果 params 给了）
return {
  status: 'success',
  output: {
    messageId: result.messageId ?? '',
    deliveredAt: new Date().toISOString(),
    ...(extraMeta ? { extraMeta } : {}),
  },
}
```

仅 5 行代码。`extraMeta` 含义：调用方可在 fan_out 内的 dm 节点 params 里塞 owner 元数据（已经被 fan_out 的模板渲染从 `{{owner.x}}` 解析好了），dm 节点在 success output 里把它原样吐回，让下游 db_update 能从 `fan_out.output.items[i].extraMeta` 拿到。

**为什么不放到 dm 节点 params**？因为 fan_out failed 数组里 `f.item` 已经包含整个 owner 行（compute_notify_plan 输出的原始 row），所以 failed 路径上不需要 extraMeta —— 只有 success 路径需要（dm 默认 output 不含 owner 元数据）。

**dm.ts 的 unit test**：
- 现有测试覆盖 success/failed 路径
- 需要补一个 case：传 `extraMeta` 时 success output 带回 extraMeta

---

## 5. T3 实施清单（dispatch implementer 用）

### 5.1 文件改动

| 文件 | 动作 | 内容 |
|------|------|------|
| `src/db/schema-v40.sql` | 创建 | CREATE FUNCTION build_notify_message + INSERT into test_pipelines (notify-internal) + INSERT into internal_capability_pipelines |
| `src/db/migrate.ts` | 修改 | SCHEMA_FILES 列表追加 v40 |
| `src/pipeline/node-types/dm.ts` | 修改 | extraMeta 透传 |
| `src/__tests__/unit/dm-executor.test.ts` | 修改/创建 | extraMeta unit test |
| `src/__tests__/integration/handler-vs-pipeline-notify.test.ts` | 创建 | 8 scenario × handler-vs-pipeline 行为对等 |

**预计代码改动**：~250 行（schema-v40 ~150 行 SQL + dm.ts +5 行 + 测试 ~100 行）。

### 5.2 测试矩阵（8 scenario × 边界 case）

每个 fixture 在两条路径下分别跑：
- 路径 A：`PIPELINE_DAG_HANDLERS=''`（handler 路径）
- 路径 B：`PIPELINE_DAG_HANDLERS='notify_bug'`（pipeline 路径）

| # | Scenario | Fixture 设置 | 期望共同行为 | 已知差异 |
|---|----------|-------------|------------|---------|
| 1 | `fix_success` | per project: fix_attempt(success) + create_mr(success) + ai_review(ai-approved) | DM 发送（含 MR 列表 + rootCauseSummary）；写 notify success 事件 | - |
| 2 | `fix_success_review_concerns` | 同上 + ai_review(ai-needs-attention) | DM（含 attention 标签）；写 success 事件 | - |
| 3 | `l4_created` | report.classification='bug' & level='l4' & 无 MR | DM（含 issueUrl + summary）；写 success 事件 | - |
| 4 | `handover` | bug_fix_events(handover, success, data={reason: fix_exhausted, fixBranch: ...}) | DM（含 reasonCn + fixBranch + ownerProjectsLine）；写 success 事件 | DM 文案中 attemptLine/commentLine/failureLine 条件分支按 handler data 字段呈现 |
| 5 | `fix_failed` | per project: fix_attempt(failed) 无 create_mr | **不发 DM**，handler/pipeline 都直接 noop | - |
| 6 | `approval_rejected` | bug_fix_events(approval, data={decision: rejected}) | 不发 DM | - |
| 7 | `approval_timeout` | 同上 decision=timeout | 不发 DM | - |
| 8 | `approval_retry_analysis` | 同上 decision=retry_analysis | 不发 DM | - |

**5 种错误码 case**：见 §6。

### 5.3 dispatch 给 implementer 的 prompt 重点

- 明确 dm.ts 改动 = 5 行（extraMeta 透传）
- schema-v40 SQL 跑过 PostgreSQL 16 syntax check（pg 16 with jsonb_agg + FILTER 完全支持）
- compute_notify_plan 的 SQL 必须先在本机 psql 手测通过再嵌进 schema-v40（建议 implementer 先单独跑 SQL fixture 确认）
- 行为对等测试可参考 [`handler-vs-pipeline-handover.test.ts`](../../../src/__tests__/integration/handler-vs-pipeline-handover.test.ts) 的 setup pattern（resetTestDb / resetCheckpointerForTesting / bootstrapXxxPipelineMapping）
- IM adapter mock：fetch 不够（pipeline 走 `sendImDirect` 不走 fetch），需要 mock `src/pipeline/im-notifier.ts` 的 `sendImDirect`，或注入一个 fake adapter 通过 `registerImDmSender`

---

## 6. 已知差异（接受不严格对等）

| # | Scenario | Handler 行为 | Pipeline 行为 | 影响 | 后续处理 |
|---|----------|------------|---------------|------|---------|
| KD-1 | `report_not_found` | 立刻 `return {success: false, error: 'report_not_found'}` | sql_query 返回空 rows → fan_out 跑 0 次 → pipeline success-noop（无 DM、无 event） | 错误码丢失，但 side effects 与 handler 一致（都没发 DM） | 等 phase 3 `shortCircuitWhen` wired 后加 assert 节点修复 |
| KD-2 | `no_recipients`（ownerMap 空） | `return {success: false, error: 'no_recipients'}` | 同 KD-1，sql_query 输出空 rows → success-noop | 同 KD-1 | 同 KD-1 |
| KD-3 | `im_api_error`（部分 owner DM 失败） | `return {success: false, error: 'im_api_error', output: '部分 DM 失败'}` | fan_out onItemFailure=continue → 整体 success；失败行写 `bug_fix_events(notify, failed, error=...)` | 错误码丢失，但 bug_fix_events 写入的 success/failed 行**完全对等**（这是行为对等测试的主要断言） | 接受 |
| KD-4 | `no_adapter`（IM adapter 未注册） | `return {success: false, error: 'no_adapter'}` | dm executor 调 `sendImDirect` 时抛错 → 每个 owner 都 fan_out failed item → 整体仍 success（onItemFailure=continue） | 同 KD-3 | 接受 |
| KD-5 | `missing_reportId`（extraParams 没传 reportId） | `return {success: false, error: 'missing_reportId'}` | runPipeline 启动前 trigger_params 校验拦下 → pipeline 没启动 | **此 case 行为对等**（都是失败），错误码不一样但都不会写任何 event | 接受 |

**测试断言策略**：
- 主要断言三个 side effects（DM 调用次数 + content + bug_fix_events 行数 + status + data 字段）
- 错误码对比放在「软断言」section（仅日志输出，不 fail）
- 测试 case 名字明示 known difference（如 `it.skip('handler vs pipeline error code parity (KD-1: report_not_found)')`)

---

## 7. 工作量估算

| 阶段 | 工作 | 时间 |
|------|------|------|
| design 笔记（本文档） | 主 agent 完成 | 30 min ✓ |
| 用户 review + 决策 | 跟用户确认 4 个关键决策（§9） | 10 min |
| 改 dm.ts + unit test | implementer | 30 min |
| 写 schema-v40.sql | implementer（含 build_notify_message 函数 + pipeline 种子） | 3-4h |
| 行为对等测试 8 case | implementer | 2-3h |
| 修 typecheck / 跑全套测试 / commit | implementer + 主 agent | 30 min |
| merge 回 main | 主 agent | 30 min |

**总计**：8-10h（一天）。

---

## 8. 风险清单

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| R1 | compute_notify_plan SQL ~120 行 CTE，调试不便 | 中 | implementer 先在 psql 单独跑 SQL fixture 确认每种 scenario 输出正确再嵌入 schema-v40 |
| R2 | `{{... \| jsonStringify}}` 经 graph-builder 模板渲染 → SQL 参数 → ::jsonb cast 链路有未 verify 的环节 | 中 | implementer 先写一个最小 SQL fixture（fan_out items 进 db_update）跑通，再做完整 8 scenario |
| R3 | dm.ts 加 extraMeta 字段可能影响其他用 dm 节点的 pipeline | 低 | extraMeta 可选，default 不变；现有 pipeline 不传 extraMeta 行为完全一致 |
| R4 | scenario CTE 逻辑边界 case 写错（特别是 fix_failed vs fix_success 的兜底逻辑） | 中 | 行为对等测试 8 case 全跑过；handler 的兜底逻辑（notify-handler.ts:325-338）逐行映射到 SQL |
| R5 | PL/pgSQL `build_notify_message` 函数维护性差 | 低 | 函数名 + 注释明示「请勿在此添加业务逻辑，仅 message 文案」；future 重写计划放 §9 |
| R6 | jsonb_agg 在 0 rows 时返回 NULL 而非空数组 | 低 | 已用 COALESCE(..., '[]'::jsonb) 处理 |

---

## 9. 待 review 的关键决策（review 时跟用户确认）

1. **D1 — 5 节点 DAG 设计 + 单 sql_query 包揽决策/文案/ownerMap**：是否接受？还是想 sql_query 拆成 2-3 个节点（load_report / per_project / build_message）以提高单节点可读性？
2. **D2 — dm executor 加 extraMeta 透传字段**：是否接受？还是想避免改 dm 节点（用其他方式让 fan_out items 带 owner 元数据）？
3. **D3 — 接受 5 个已知差异**（KD-1 到 KD-5）：是否接受？还是要为 KD-1/KD-2 引入 assert 节点类型 / wire shortCircuitWhen？
4. **D4 — 文案逻辑放 PL/pgSQL `build_notify_message` 函数**：是否接受？还是 inline CASE WHEN 在 sql_query 里？

---

## 10. 后续 deferred 议题

- **shortCircuitWhen wiring**（phase 3 deferred） + **conditionMatches 增强**（支持点记法表达式）—— 不在 T3 范围，但解决后能修复 KD-1/KD-2 错误码丢失
- **`build_notify_message` PL/pgSQL 函数**：长期看应该重写为 TS（在 sql_query 节点之前/之后插入 template_render 节点），等 template_render 支持 if/else 后再迁移
- T5（删旧 handler）需要在所有差异都接受/修复后再做
