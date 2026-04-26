# 能力(Capability)与流水线(Pipeline)分工重构设计

- **日期**：2026-04-26
- **状态**：brainstorming 已通过，待 plan
- **推翻**：[2026-04-14-unified-capability-pipeline-design.md](./2026-04-14-unified-capability-pipeline-design.md)（"capability 吃 pipeline + Claude 当统一执行引擎"方向作废）
- **衔接**：[2026-04-22-im-trigger-toggle-design.md](./2026-04-22-im-trigger-toggle-design.md)（已实施的产线级 trigger_sources，本 spec 把该字段迁到 product_line_im_triggers 表）

## 0. 决策摘要

| # | 决策 | 选择 |
|---|------|------|
| 1 | 与 2026-04-14 unified spec 关系 | 推翻并替代 |
| 2 | 重构范围 | 完整重构（清理 + DSL 增强 + handler 迁移） |
| 3 | capability 内部类归宿 | 双表物理分离：capabilities + pipeline_node_types |
| 4 | 节点实现形式 | 半开放注册制（DB 注册元信息，代码写 TS executor） |
| 5 | 跨 stage 引用语法 | 点记法子路径 `{{steps.x.output.field}}` |
| 6 | 控制流原语扩展 | retry_when 表达式 + fan_out/map 节点（不开 cycle） |
| 7 | handler 迁移策略 | 双轨并行 + feature flag 逐个切 |

---

## 1. 背景与目标

### 1.1 现状问题

- capabilities 表配置化约 40%（toolNames / systemPrompt / defaultPipelineId 已在 DB），但仍有 **6 处硬编码字典 + 10+ 个必须代码注册的 handler**。每加一个 capability 需要改 [`src/agent/claude-runner.ts`](../../../src/agent/claude-runner.ts) 里 6 个字典：`FAILURE_MSGS`（行 39）、`CAP_NAMES`（行 51）、`HANDLER_CAPABILITIES`（行 378）、`writeCapabilities`（行 473）、`CODE_CAPABILITIES`（行 648）、`examples`（行 532）
- capability 同时担"路由"和"实现"两个角色，职责混杂；新产线接入时必须 grep 整个代码库
- pipeline DSL 不够强：跨 stage 引用语法弱（无 `{{steps.x.output.field}}`）、无 retry_when 表达式、无 fan_out/map，承接不了多 project 修复 / 多服务器并行部署等场景
- 历史 spec [2026-04-14-unified-capability-pipeline-design.md](./2026-04-14-unified-capability-pipeline-design.md) 走的反方向（capability 吃 pipeline + Claude 当统一执行引擎），**本 spec 推翻该方向**

### 1.2 目标

| 目标 | 落地手段 |
|------|---------|
| 职责拆分 | capability = LLM agent 配置库；im_triggers = IM 入口；pipeline_node_types = 节点执行单元 |
| 数据模型清晰 | 三层抽象、四张核心表（im_triggers / pipeline / pipeline_node_types / capabilities） |
| pipeline DSL 增强 | 点记法子路径、retry_when、fan_out/map（不开 cycle） |
| 审批分层 | 入口 approval_rules + pipeline 内部 approval 节点双轨 |
| 硬编码清理 | 6 处字典挪入 DB 字段 |
| handler 迁移 | create_mr / notify_bug / request_handover 双轨 + feature flag 逐个切 |

### 1.3 非目标

- 不动纯 LLM capability（analyze_bug / fix_bug_l* / ai_review_mr / prd_submit）—— 它们作为 pipeline 中 `llm_agent` 节点的引用对象继续存在
- 不开 pipeline cycle 限制（DAG 仍然禁 cycle）
- 不引入完整表达式语言（仅点记法 + 比较运算符 + 逻辑运算符 + `contains`）

---

## 2. 整体架构

### 2.1 四层抽象

```
┌──────────────────────────────────────────────────────────┐
│ 触发器层 (代码里的固定机制)                                 │
│                                                          │
│  IM 触发器                                                │
│  └ detectIntent + 权限校验 + 审批拦截 + 路由 (写死的流程)   │
│  └ 数据驱动配置: im_triggers 表                            │
│                                                          │
│  Web / API / 定时 / Webhook 触发器                        │
│  └ 直接以 (pipeline_id, params) 调用,无中间表             │
└────────────────────┬─────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────┐
│ pipeline (DAG 编排核心)                                   │
│  - graph (nodes + edges)                                 │
│  - 跨 stage 引用 {{steps.x.output.y}}                     │
│  - retry_when / fan_out / 内部 approval stage            │
└────────────────────┬─────────────────────────────────────┘
                     ↓
┌──────────────────────────────────────────────────────────┐
│ pipeline_node_types (节点类型注册表)                       │
│  - 通用: http / dm / db_update / sql_query / file_read    │
│  - 流程: approval / im_input / fan_out / wait_webhook    │
│  - LLM 内核: llm_agent (引用 capabilities 表)              │
└────────────────────┬─────────────────────────────────────┘
                     │ llm_agent.capabilityKey
                     ↓
┌──────────────────────────────────────────────────────────┐
│ capabilities (LLM agent 配置库,纯 prompt + 工具白名单)      │
│  - systemPrompt / toolNames / maxTurns / cwd 类型         │
│  - 没有 default_pipeline_id, 没有审批字段, 没有触发源       │
└──────────────────────────────────────────────────────────┘
```

### 2.2 各表职责对照

| 表 | 角色 | 谁读它 |
|----|------|-------|
| `im_triggers` | IM 入口元数据（intent_key / display_name / pipeline_id / examples / failure_messages / default_approval_rule_id） | IM 触发器代码 |
| `product_line_im_triggers` | 产线级开关（替代当前 product_line_capabilities） | IM 触发器代码 |
| `test_pipelines` | DAG 定义 | pipeline 引擎、画布 UI |
| `pipeline_node_types` | 节点类型注册（key / paramSchema / outputSchema） | pipeline 引擎、画布 UI |
| `capabilities` | LLM agent 配置库（prompt / 工具白名单） | `llm_agent` 节点 executor |

### 2.3 强约束（确保职责不再混杂）

1. **触发器层是代码固定机制**——detectIntent / 权限校验 / 审批拦截这套流程写死在 IM trigger 代码里，只有"什么 intent → 什么 pipeline / 谁能触发 / 要不要审批"走 DB
2. **Web / API / 定时 / Webhook 触发器不查任何中间表**——已知 pipeline_id，直接 `(pipeline_id, params)` 调用 pipeline
3. **pipeline 引擎对触发器透明**——只接收 `(params, triggerContext)`，触发器类型不影响 pipeline 逻辑
4. **`llm_agent` 节点必须引用 `capabilities.key`**——不允许节点参数里直接写 systemPrompt（保证 prompt 库统一管理）
5. **`capabilities` 表禁止出现任何"触发 / 路由 / 审批 / 权限"字段**——彻底纯粹

### 2.4 与现有代码的对应关系

| 现状 | 修订后 |
|------|--------|
| `capabilities.default_pipeline_id` | 迁到 `im_triggers.pipeline_id` |
| `capabilities.needs_approval`（已废）/ `approval_rules` | `im_triggers.default_approval_rule_id`（入口）+ pipeline 内部 `approval` 节点 |
| `product_line_capabilities` | 重命名为 `product_line_im_triggers`，外键改指 im_triggers |
| `capabilities` 现 6 处硬编码字典 | `im_triggers.examples / failure_messages` + `capabilities.max_turns / timeout_ms / requires_worktree / requires_deploy_lock` |
| `capabilities.toolNames / systemPrompt` | 保留（LLM agent 配置） |
| `pipeline.stages[].stageType` | 不再硬编码 5 种 enum，而是引用 `pipeline_node_types.key` |

---

## 3. 数据模型变更

### 3.1 新表：`im_triggers`（IM 入口元数据）

```sql
CREATE TABLE IF NOT EXISTS im_triggers (
  id                       SERIAL PRIMARY KEY,
  key                      TEXT NOT NULL UNIQUE,
  display_name             TEXT NOT NULL,
  description              TEXT NOT NULL DEFAULT '',
  pipeline_id              INTEGER NOT NULL REFERENCES test_pipelines(id) ON DELETE RESTRICT,
  intent_hints             TEXT NOT NULL DEFAULT '',
  examples                 JSONB NOT NULL DEFAULT '[]',
  failure_messages         JSONB NOT NULL DEFAULT '{}',
  default_approval_rule_id INTEGER REFERENCES approval_rules(id) ON DELETE SET NULL,
  is_system                BOOLEAN NOT NULL DEFAULT FALSE,
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_im_triggers_pipeline ON im_triggers(pipeline_id);
```

字段语义：

- `key` —— detectIntent 输出空间的稳定 token，全局唯一
- `pipeline_id` —— NOT NULL，没有 pipeline 的 IM 触发器没意义
- `intent_hints` —— 给 detectIntent prompt 拼进去的额外语义提示（替代 [`claude-runner.ts:570`](../../../src/agent/claude-runner.ts) 写死的 `intentRules`）
- `examples` —— `["部署 ssh-proxy 到 dev", ...]` 给 greet 列表用
- `failure_messages` —— error_code → 中文文案，替代 `claude-runner.ts:39` 的 `FAILURE_MSGS`

### 3.2 新表：`product_line_im_triggers`（产线级开关）

```sql
CREATE TABLE IF NOT EXISTS product_line_im_triggers (
  product_line_id   INTEGER NOT NULL REFERENCES product_lines(id) ON DELETE CASCADE,
  im_trigger_key    TEXT NOT NULL REFERENCES im_triggers(key) ON UPDATE CASCADE ON DELETE CASCADE,
  env_name          TEXT NOT NULL DEFAULT '*',
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_roles     JSONB NOT NULL DEFAULT '["developer","ops","admin"]'::jsonb,
  trigger_sources   JSONB NOT NULL DEFAULT '["im","web"]'::jsonb,
  approval_rule_id  INTEGER REFERENCES approval_rules(id) ON DELETE SET NULL,
  PRIMARY KEY (product_line_id, im_trigger_key, env_name)
);
```

替代当前 `product_line_capabilities`，结构对齐保证迁移成本最小。

### 3.3 新表：`pipeline_node_types`（节点类型注册）

```sql
CREATE TABLE IF NOT EXISTS pipeline_node_types (
  key             TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  category        TEXT NOT NULL CHECK (category IN ('general','flow','llm','specialized')),
  param_schema    JSONB NOT NULL DEFAULT '{}',
  output_schema   JSONB NOT NULL DEFAULT '{}',
  is_system       BOOLEAN NOT NULL DEFAULT TRUE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

启动一致性检查：代码 `registerNodeType()` 的 key 必须跟 DB 表 enabled 行一致；漂移时启动报错。

### 3.4 `capabilities` 表改造

| 字段 | 处理 | 原因 |
|------|------|------|
| `key` / `display_name` / `description` | 保留 | LLM agent 标识 |
| `system_prompt` / `default_system_prompt` | 保留 | LLM agent 配置核心 |
| `tool_names` | 保留 | 工具白名单 |
| `is_system` / `created_at` / `updated_at` | 保留 | 元信息 |
| `default_pipeline_id` | **删除** | 路由职责迁到 `im_triggers.pipeline_id` |
| `needs_approval` | **删除**（已废） | 审批规则迁到 `im_triggers.default_approval_rule_id` 和 pipeline 内 approval 节点 |
| `category` | **删除** | query/action/admin 是入口路由用的，env_prep/verify/testing/result 是 2026-04-14 unified spec 残留 |
| `param_schema` / `playbook` | **删除** | 2026-04-14 unified spec 残留，本 spec 推翻该方向 |
| **新增** `max_turns INTEGER NOT NULL DEFAULT 30` | | 替代 `claude-runner.ts:199` 写死的 maxTurns |
| **新增** `timeout_ms INTEGER NOT NULL DEFAULT 1200000` | | 替代 `claude-runner.ts:197` 写死的 timeoutMs |
| **新增** `requires_worktree BOOLEAN NOT NULL DEFAULT FALSE` | | 替代 `claude-runner.ts:648` 的 `CODE_CAPABILITIES` 字典 |
| **新增** `requires_deploy_lock BOOLEAN NOT NULL DEFAULT FALSE` | | 替代 `claude-runner.ts:473` 的 `writeCapabilities` 字典 |

### 3.5 `test_pipelines` 表改造

`graph` / `stages` JSONB 内部结构变更（无 schema 变更）：

```typescript
// 旧
interface PipelineNode {
  id: string
  position: { x: number, y: number }
  stageType: 'script' | 'capability' | 'approval' | 'wait_webhook' | 'im_input'
  params: Record<string, unknown>
}

// 新
interface PipelineNode {
  id: string
  position: { x: number, y: number }
  nodeTypeKey: string                    // 引用 pipeline_node_types.key
  params: Record<string, unknown>        // 由 node_type.param_schema 约束
  retryCount?: number
  retryWhen?: string                     // 如 "output.error contains 'timeout'"
  retryDelayMs?: number
  fanOut?: { source: string, as: string, parallel: number, onItemFailure?: 'stop'|'continue'|'aggregate' }
}
```

`stageType: 'capability'` 重命名为 `nodeTypeKey: 'llm_agent'`，节点参数里有 `capabilityKey` 引用 capabilities 表。

### 3.6 迁移脚本要做的事

1. 创建 `im_triggers`、`product_line_im_triggers`、`pipeline_node_types` 三张表
2. 给 `capabilities` 表加 4 个新字段、删 5 个旧字段（**先 ADD 后 DROP，分两个 PR ship；中间一个 PR 把所有读旧字段的代码下线**）
3. 数据迁移：
   - 入口类 capability 行的 metadata（displayName / description / defaultPipelineId / `claude-runner.ts` 中硬编码的 examples + failure_messages 字典内容）写入 `im_triggers`
   - `product_line_capabilities` → `product_line_im_triggers`（同步复制，外键指向调整）
   - `test_pipelines.graph.nodes[].stageType` → `nodeTypeKey`（5 种 enum → 5 种 node_type_key，`capability` → `llm_agent`）
4. `pipeline_node_types` 种子数据：现有 5 种 + 新增 7 种（http / dm / db_update / sql_query / file_read / fan_out / template_render）
5. **不删** `product_line_capabilities` 表 —— capabilities 表保留下来的行是 LLM agent 配置（包括没有 IM 入口的 fix_bug_l* / ai_review_mr 等），它们的产线级 RBAC（哪个产线的哪些角色允许使用某 LLM agent）仍由 `product_line_capabilities` 承担，与 `product_line_im_triggers`（IM 触发器维度）正交

### 3.7 现有 trigger_sources 字段处理

`product_line_capabilities.trigger_sources`（schema-v22 加的）→ 复制到 `product_line_im_triggers.trigger_sources`，旧表上的字段保留（向后兼容期间）。

### 3.8 阶段 4 还会增加一张过渡表

阶段 4（handler 迁移）会增加一张 `internal_capability_pipelines` 表（详见 §6.5）作为 capability_key → pipeline_id 的映射，是 feature flag 双轨切换的过渡产物，全部迁移完成后可删。本节不展开，集中在 §6 与执行机制一起说明。

---

## 4. Pipeline DSL 增强

### 4.1 节点类型清单（v1）

`pipeline_node_types` 表 v1 上线 12 种类型：

| category | key | 用途 | 关键参数 | 输出 |
|---------|-----|------|---------|------|
| general | `script` | SSH 远程脚本（已有，保留） | `commands` / `script` / `targetServers` | `{exitCode, stdout, stderr}` |
| general | `http` | HTTP 调用（新增） | `method` / `url` / `headers` / `body` / `timeoutMs` | `{statusCode, headers, body}` |
| general | `dm` | IM 私聊发消息（新增） | `platform` / `userId` / `text` / `card` | `{messageId, deliveredAt}` |
| general | `db_update` | 业务 DB 写入（新增） | `sqlTemplate` / `params` | `{rowsAffected}` |
| general | `sql_query` | 业务 DB 查询（新增） | `sqlTemplate` / `params` | `{rows: [...]}` |
| general | `file_read` | 远程/本地文件读取（新增） | `target` / `path` / `maxBytes` | `{content, size}` |
| general | `template_render` | 字符串模板渲染（新增，给下游 description / sqlTemplate 等用） | `template` / `vars` | `{text}` |
| flow | `approval` | 人工审批（已有） | `approverResolver` / `description` / `cardType` / `timeoutBehavior` | `{decision, approver, comment}` |
| flow | `im_input` | IM 多轮参数采集（已有） | `prompts` / `paramSchema` | runtimeVars 增量 |
| flow | `wait_webhook` | 等外部 webhook（已有） | `webhookId` / `timeoutMs` | `{payload}` |
| flow | `fan_out` | 数组扇出并行（新增） | `source` / `as` / `parallel` / `onItemFailure` / `body` | `{items: [...], failed: [...]}` |
| llm | `llm_agent` | 跑某 capability 的 LLM agent（替代 `stageType: 'capability'`） | `capabilityKey` / `extraVars` / `maxTurnsOverride` | `{text, structuredOutput?}` |

### 4.2 变量插值语法

支持 `{{...}}` 模板，**仅点记法 + 字面量**，不引入完整表达式语言：

```
{{triggerParams.<name>}}           触发器参数（IM/Web/API 传入）
{{vars.<name>}}                    pipeline 静态变量 + runtimeVars
{{steps.<nodeId>.output}}          上游节点完整输出
{{steps.<nodeId>.output.<path>}}   子路径，path 用点记法（如 .body.data.items[0].id）
{{steps.<nodeId>.status}}          上游节点状态
{{server.host}} {{server.port}}    当前 stage 目标服务器
{{run.id}} {{run.startedAt}}       当前 run 元信息
{{<scope>.<field>}}                fan_out 注入的局部变量（见 4.4）
```

**JSONPath 子集**：`.field` / `.field.subfield` / `.array[0]` / `.array[*].field`。不支持 filter / map / 函数调用。

**内置过滤器**（仅以下几个）：`urlEncode` / `jsonStringify` / `lower` / `upper`。语法：`{{steps.x.output.path | urlEncode}}`。

**类型转换**：模板插值时按上下文类型转：字符串字段 → JSON.stringify；数字字段 → Number；布尔 → Boolean。

### 4.3 retry_when 表达式

节点级配置，决定失败后是否重试：

```typescript
interface PipelineNode {
  retryCount?: number               // 最大重试次数,默认 0
  retryWhen?: string                // 表达式,空 = 任意失败都重试
  retryDelayMs?: number             // 重试间隔,默认 1000
}
```

表达式形态：

```
status == 'failed'
output.error == 'timeout'
output.statusCode >= 500
output.error contains 'timeout'
output.statusCode != 404 && output.error != 'auth'
!output.permanent
```

支持运算符：`==` `!=` `<` `<=` `>` `>=` `&&` `||` `!` `contains`。
左操作数：当前节点的 `status` / `output` 子路径，或上游节点的 `steps.<id>.status` / `steps.<id>.output.<path>`。
右操作数：字面量（字符串 / 数字 / 布尔）。

**同一套表达式语法的复用范围**：

- 节点级 `retryWhen`（§4.3）—— 决定本节点失败是否重试
- 节点级 `shortCircuitWhen`（§6.2）—— 决定本节点输出后是否短路整条 pipeline（命中时 output 增加 `skipped: true` 标记）
- 边级 `when`（§4.4 fan_out 示例 / §6 各 DAG 示例）—— 决定该边是否激活
- 节点级 `onFailure: 'stop' | 'continue'`（已有）—— 跟 retryWhen 配合：retryWhen 不命中（不再重试）后看 onFailure

### 4.4 fan_out / map 节点

`fan_out` 节点把上游的数组扇出成多个并行子运行，子运行结束后再聚合：

```yaml
- id: identify_scopes
  nodeTypeKey: llm_agent
  params: { capabilityKey: identify_scopes }

- id: fix_each
  nodeTypeKey: fan_out
  params:
    source: "{{steps.identify_scopes.output.scopes}}"
    as: scope
    parallel: 3
    onItemFailure: continue
  body: [fix_one]

- id: fix_one
  nodeTypeKey: llm_agent
  params:
    capabilityKey: fix_bug_l2
    extraVars:
      scopePath: "{{scope.path}}"
```

输出聚合：`{{steps.fix_each.output}}` = `{ items: [...], failed: [...] }`。

约束：

- 子图必须是 DAG（v1 不允许 fan_out 嵌套 fan_out）
- 子图内的节点不能直接连出 fan_out 边界
- fan_out 节点本身不参与父级 retry_when —— 重试由子图节点各自配置

### 4.5 变量优先级

同名变量解析顺序（高 → 低）：

1. fan_out 注入的局部变量（最近作用域）
2. `steps.<nodeId>.output.<path>`
3. `vars.<name>` / runtimeVars
4. `triggerParams.<name>`
5. 解析失败 → 节点启动报错（不允许悄悄回退到字面量）

### 4.6 与现有 graph-validation 的关系

- 维持禁 cycle 校验（[`graph-validation.ts`](../../../src/pipeline/graph-validation.ts)）
- 新增校验：fan_out 节点必须有 `body` 字段且非空
- 新增校验：`retry_when` 表达式语法预解析（启动期）
- 新增校验：`{{steps.<id>.output.<path>}}` 中的 `<id>` 必须是上游节点（DFS 验证），`<path>` 不在启动期校验（运行时按 output_schema 软校验）

### 4.7 实现要点

- 表达式解析：手写 PEG / parser combinator（仅支持上述运算符），不引入 jsonpath / cel / expr-eval 等库
- 变量插值器：复用现有 [`src/pipeline/variables.ts`](../../../src/pipeline/variables.ts)，扩展 `resolvePath()` 支持点记法 + JSONPath 子集
- fan_out 执行：在 [`graph-runner.ts`](../../../src/pipeline/graph-runner.ts) 加一个并行子运行调度器，复用主图的 LangGraph state；子运行有独立 stageResults 命名空间，结束时 merge 回父图 `steps.<fanOut>.output.items[]`

---

## 5. 审批分层方案

### 5.1 双层审批的语义边界

| 层 | 在哪 | 决定什么 | 触发时机 |
|----|------|---------|---------|
| **入口审批** | IM 触发器层（pipeline 启动**前**） | "这个用户能不能发起这个意图" | 用户在 IM 群里说话后、pipeline 启动前 |
| **内部审批** | pipeline 内的 `approval` 节点（DAG 中显式画） | "DAG 跑到这一步具体要做某件事，要不要批" | pipeline 执行过程中，节点 interrupt |

核心约束：两层各管各的，不重复审批。

### 5.2 入口审批：依然由 `approval_rules` 路由

```sql
ALTER TABLE approval_rules
  RENAME COLUMN capability_key TO im_trigger_key;

ALTER TABLE approval_rules
  ADD CONSTRAINT approval_rules_im_trigger_fk
  FOREIGN KEY (im_trigger_key) REFERENCES im_triggers(key) ON UPDATE CASCADE;
```

路由优先级（高 → 低）：

1. `product_line_im_triggers.approval_rule_id`（产线级覆盖）
2. `im_triggers.default_approval_rule_id`（IM 触发器默认值）
3. `approval_rules` 表里 `im_trigger_key + env_name` 匹配
4. 都没命中 → 不审批，直接启动 pipeline

入口审批通过后，调 `runPipeline(pipeline_id, params, executionMode=true)`。

### 5.3 内部审批：`approval` 节点参数

```typescript
interface ApprovalNodeParams {
  approverResolver:
    | { kind: 'static', userIds: string[] }
    | { kind: 'role', role: 'admin' | 'ops' | 'product_owner' }
    | { kind: 'computed', resolverKey: string }
  description: string
  cardType: 'im_card' | 'web_button'
  timeoutMs: number
  timeoutBehavior: 'reject' | 'pass' | 'escalate'
  escalateTo?: ApprovalNodeParams['approverResolver']
}
```

节点行为：

- 启动 → 调 approverResolver 解析审批人 → 推 IM 卡片 / 写 Web 待审列表 → `interrupt()`
- 收到回调 → `resumeFromApproval(decision, approver, comment)`
- 节点 output：`{ decision: 'approved' | 'rejected' | 'timeout', approver: string, comment?: string }`
- 节点 status：approved → success；rejected/timeout → failed（下游可用 retry_when / onFailure 处理）

### 5.4 现有 approval 基础设施复用

- [`src/approval/gate.ts`](../../../src/approval/gate.ts)：保留，把 `capability_key` 字段改名为 `im_trigger_key` 并适配
- [`src/approval/router.ts`](../../../src/approval/router.ts)：保留，路由参数改名
- [`src/pipeline/approval-manager.ts`](../../../src/pipeline/approval-manager.ts)：扩展 —— 加 `approverResolver` 三种 kind 的解析；当前的 IM 卡片推送 + 回调链路保留
- [`src/agent/approval/resolvers.ts`](../../../src/agent/approval/resolvers.ts)：保留并按需扩展（如新增 `primary_repo_admin`）

---

## 6. Handler 迁移：从代码到 pipeline DAG

### 6.1 三个 handler 的复杂度对照

| Handler | 输入 | 关键步骤 | 复杂点 | 迁移难度 |
|---------|------|---------|--------|---------|
| `request_handover` | `reportId, reason` | 1. 幂等校验 → 2. GitLab 打 label → 3. 写 event → 4. 更新 report status | 4 步串行 | **L1** |
| `notify_bug` | `reportId` | 1. 决策 scenario kind → 2. 查 owners → 3. 装 DM 卡片 → 4. 发 DM | scenario 多分支 | **L2** |
| `create_mr` | `reportId` | 1. 查 primaryIssue → 2. 找 fix_attempt 成功 project → 3. 对每个 project 创 MR → 4. 主从仓库 description 不同 | 多 project fan_out + 主从分支 | **L3** |

按 L1 → L2 → L3 顺序迁移，每个独立 ship。

### 6.2 `request_handover` 迁移（L1 示范）

旧 handler 等价于 5 节点 DAG：

```yaml
pipeline_name: handover-internal
trigger_params:
  reportId: { type: integer, required: true }
  reason:   { type: string, required: true }
nodes:
  - id: idempotency_check
    nodeTypeKey: sql_query
    params:
      sqlTemplate: |
        SELECT 1 FROM bug_fix_events
        WHERE report_id = {{triggerParams.reportId}}
          AND code = 'handover' AND status = 'success' LIMIT 1
    onOutput:
      shortCircuitWhen: "output.rows.length > 0"

  - id: load_report
    nodeTypeKey: sql_query
    params:
      sqlTemplate: |
        SELECT issue_iid, primary_project_path FROM bug_analysis_reports
        WHERE id = {{triggerParams.reportId}}

  - id: gitlab_label
    nodeTypeKey: http
    params:
      method: POST
      url: "{{vars.gitlabUrl}}/api/v4/projects/{{steps.load_report.output.rows[0].primary_project_path | urlEncode}}/issues/{{steps.load_report.output.rows[0].issue_iid}}/labels"
      headers: { "PRIVATE-TOKEN": "{{vars.gitlabToken}}" }
      body: { labels: "needs-manual" }
    onFailure: continue

  - id: write_event
    nodeTypeKey: db_update
    params:
      sqlTemplate: |
        INSERT INTO bug_fix_events (report_id, code, status, project_path, data)
        VALUES ({{triggerParams.reportId}}, 'handover', 'success',
                {{steps.load_report.output.rows[0].primary_project_path}},
                {{triggerParams.reason}}::jsonb)

  - id: update_status
    nodeTypeKey: db_update
    params:
      sqlTemplate: |
        UPDATE bug_analysis_reports SET status = 'pending_manual', updated_at = NOW()
        WHERE id = {{triggerParams.reportId}}

edges:
  idempotency_check -> load_report     [when: "!steps.idempotency_check.output.skipped"]
  load_report      -> gitlab_label
  gitlab_label     -> write_event       [always]
  write_event      -> update_status
```

注意点：

- `shortCircuitWhen` 是节点级新参数，命中即整条 pipeline 早返（output.skipped=true）
- `urlEncode` 是 §4.2 提到的内置过滤器

### 6.3 `notify_bug` 迁移（L2 示范）

scenario 决策用 `sql_query` + 边的条件 expression 把 scenario 分支显式画出来：

```yaml
pipeline_name: notify-internal
trigger_params:
  reportId: { type: integer, required: true }
nodes:
  - id: load_state
    nodeTypeKey: sql_query
    params:
      sqlTemplate: |
        SELECT
          (SELECT level FROM bug_analysis_reports WHERE id = {{triggerParams.reportId}}) as level,
          EXISTS (...) as is_handover,
          EXISTS (...) as has_mr,
          ...

  - id: collect_owners
    nodeTypeKey: sql_query
    params:
      sqlTemplate: |
        SELECT DISTINCT p.owner_id, p.gitlab_path
        FROM bug_fix_events e
        JOIN projects p ON p.gitlab_path = e.project_path
        WHERE e.report_id = {{triggerParams.reportId}}
          AND e.code IN ('scope_identified','fix_attempt','create_mr')

  - id: dispatch_handover
    nodeTypeKey: fan_out
    params:
      source: "{{steps.collect_owners.output.rows}}"
      as: owner
      parallel: 5
    body: [send_handover_dm]
    when: "steps.load_state.output.rows[0].is_handover == true"

  - id: send_handover_dm
    nodeTypeKey: dm
    params:
      platform: dingtalk
      userId: "{{owner.owner_id}}"
      card:
        title: "Bug #{{triggerParams.reportId}} 转人工"
        body: "..."

  # ...8 种 scenario 各对应一个 dispatch_* fan_out 节点,when 条件互斥
```

### 6.4 `create_mr` 迁移（L3 示范）

```yaml
pipeline_name: create-mr-internal
trigger_params:
  reportId: { type: integer, required: true }
nodes:
  - id: load_primary_issue
    nodeTypeKey: sql_query
    params: { sqlTemplate: "SELECT ... FROM bug_fix_events WHERE code='create_issue' ..." }

  - id: find_success_projects
    nodeTypeKey: sql_query
    params:
      sqlTemplate: |
        SELECT DISTINCT project_path,
               (data->>'branch') as branch,
               (data->>'targetBranch') as targetBranch
        FROM bug_fix_events e1
        WHERE report_id = {{triggerParams.reportId}}
          AND code = 'fix_attempt' AND status = 'success'
          AND NOT EXISTS (
            SELECT 1 FROM bug_fix_events e2
            WHERE e2.report_id = e1.report_id AND e2.code = 'create_mr'
              AND e2.project_path = e1.project_path AND e2.status = 'success'
          )

  - id: create_each_mr
    nodeTypeKey: fan_out
    params:
      source: "{{steps.find_success_projects.output.rows}}"
      as: proj
      parallel: 3
      onItemFailure: aggregate
    body: [build_description, create_mr_call, write_mr_event]

  - id: build_description
    nodeTypeKey: template_render
    params:
      template: |
        {{# proj.is_primary ? primary : secondary }}
        Closes #{{steps.load_primary_issue.output.rows[0].issue_iid}}
      vars:
        is_primary: "{{proj.project_path == steps.load_primary_issue.output.rows[0].project_path}}"

  - id: create_mr_call
    nodeTypeKey: http
    params:
      method: POST
      url: "{{vars.gitlabUrl}}/api/v4/projects/{{proj.project_path | urlEncode}}/merge_requests"
      headers: { "PRIVATE-TOKEN": "{{vars.gitlabToken}}" }
      body:
        source_branch: "{{proj.branch}}"
        target_branch: "{{proj.targetBranch}}"
        title: "Fix #{{steps.load_primary_issue.output.rows[0].issue_iid}}"
        description: "{{steps.build_description.output.text}}"
    retryCount: 3
    retryWhen: "output.statusCode >= 500 || output.error contains 'timeout'"

  - id: write_mr_event
    nodeTypeKey: db_update
    params:
      sqlTemplate: |
        INSERT INTO bug_fix_events (...) VALUES (...)
```

### 6.5 Feature Flag 双轨机制

[`coordinator.triggerCapability`](../../../src/agent/coordinator.ts) 加 flag 检查：

```typescript
const PIPELINE_DAG_HANDLERS = (process.env.PIPELINE_DAG_HANDLERS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)

export async function triggerCapability(opts: TriggerOptions): Promise<TriggerResult> {
  const { capabilityKey } = opts

  if (PIPELINE_DAG_HANDLERS.includes(capabilityKey)) {
    const pipelineId = await resolveInternalPipelineId(capabilityKey)
    return await runPipelineAsCapability(pipelineId, opts)
  }

  return await invokeHandler(capabilityKey, opts)
}
```

`resolveInternalPipelineId(key)` 查新表 `internal_capability_pipelines`：

```sql
CREATE TABLE internal_capability_pipelines (
  capability_key    TEXT PRIMARY KEY,
  pipeline_id       INTEGER NOT NULL REFERENCES test_pipelines(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

这张表是过渡产物，全部迁移完成后可删。

### 6.6 切换路径与回滚

| 步骤 | 操作 | flag 状态 |
|------|------|----------|
| 1. 准备 | spec 通过、迁移代码 ship、`internal_capability_pipelines` 表创建 + 三条 pipeline 插入 | `PIPELINE_DAG_HANDLERS=""` |
| 2. 灰度 L1 | `request_handover` | `PIPELINE_DAG_HANDLERS="request_handover"` |
| 3. 灰度 L2 | + `notify_bug` | `"request_handover,notify_bug"` |
| 4. 灰度 L3 | + `create_mr` | `"request_handover,notify_bug,create_mr"` |
| 5. 旧 handler 拆除 | 全量稳定 1-2 周后，删除 `mr-handler.ts` / `notify-handler.ts` / `request-handover-handler.ts` | 删除 flag |

任意一步异常 → 把 capability key 从 flag 中移除即回滚到 handler 路径，**不需要回滚数据库**。

### 6.7 验证策略

每个 handler 迁移单独验证：

1. **行为对等测试**：构造若干 reportId 测试 case，分别用 handler 路径和 pipeline 路径跑，对比 bug_fix_events 表的写入、GitLab API outbound calls（用 nock 拦截）、DM 发送内容
2. **冒烟脚本**：写 `docs/smoke-handler-migration-{handover,notify,mr}.md`，跟现有 `smoke-im-pipeline.md` 同 pattern
3. **生产灰度**：在 L1 已切的产线上跑 24 小时，对比新旧 path 的成功率 / 失败 reason 分布

---

## 7. 前端 UI 变更

### 7.1 P0 改动：现有页面适配新数据模型

#### 7.1.1 拆分 `CapabilitiesPage.tsx` → 两个页面

```
旧: /admin/capabilities       能力管理(混在一起)
新: /admin/im-triggers        IM 触发器管理(im_triggers 表)
新: /admin/capabilities       能力库(capabilities 表,纯 LLM agent 配置)
```

`/admin/im-triggers`（新页面）：

- 表格列：key / displayName / pipeline / enabled / 入口审批 / 触发源 / examples 数量
- 编辑表单字段：key（创建后只读）、displayName、description、pipeline_id（下拉选 pipeline）、intent_hints（textarea）、examples（tags input）、failure_messages（key-value 编辑器）、default_approval_rule_id（下拉选 approval_rule）

`/admin/capabilities`（重构）：

- 移除字段：default_pipeline_id、needs_approval、category、param_schema、playbook
- 保留字段：key、displayName、description、systemPrompt、toolNames
- 新增字段：max_turns、timeout_ms、requires_worktree、requires_deploy_lock
- 不再显示 IM 入口相关元素

#### 7.1.2 `ProductLineDetailPage.tsx` 能力管理 Tab

- Tab 名称：`能力管理` → `IM 触发器`
- 关联表从 `product_line_capabilities` 改为 `product_line_im_triggers`
- 列表数据源从 capability 列表改为 im_trigger 列表

#### 7.1.3 `ApprovalRulesPage.tsx`

- `action` / `capability` 字段改名为 `im_trigger`
- 下拉源换成 im_triggers API（含通配符 `*`）
- 已有的"stale 兼容"逻辑保留（refer CLAUDE.md 的"前端表单：枚举字段下拉规范"）

#### 7.1.4 `ToolsPage.tsx`（最近 commit 新建）

- 工具反查"被哪些能力引用"逻辑保留
- 增加一列"被哪些 pipeline_node_types 引用"——遍历 node_type.param_schema 里有 `toolNames` 字段的类型（主要是 `llm_agent`）

### 7.2 P1 改动：pipeline 画布增强

#### 7.2.1 节点选择器数据源切换

[`pipeline-canvas/panels/NodeInspector.tsx`](../../../web/src/pipeline-canvas/panels/NodeInspector.tsx) 当前硬编码 5 种 stageType；改为启动时调 `GET /admin/pipeline-node-types`，按 category 分组渲染节点类型选择器。

#### 7.2.2 节点参数表单：JSON Schema 驱动

切到任意节点时，从 `pipeline_node_types[key].param_schema` 拉 schema，按字段类型映射动态渲染：

| JSON Schema | Ant Design 组件 |
|------------|----------------|
| `string` | Input |
| `string` (format: textarea) | Input.TextArea |
| `string` (enum) | Select |
| `string` (x-source: capabilities) | Select 数据源 = `GET /admin/capabilities` |
| `string` (x-source: pipelines) | Select 数据源 = `GET /admin/pipelines` |
| `number` | InputNumber |
| `boolean` | Switch |
| `array<string>` | Select mode="tags" |
| `object` | 嵌套子 form |

`x-source` 是 schema 扩展约定，让 schema 引用其他 admin API。`llm_agent` 节点的 `capabilityKey` 字段就用 `x-source: capabilities`。

#### 7.2.3 节点高级配置（retry / fan_out）

节点 inspector 添加折叠面板"重试与流程控制"：

- `retryCount` / `retryWhen` / `retryDelayMs` / `onFailure`

`fan_out` 节点专用 inspector：

- `source` / `as` / `parallel` / `onItemFailure` / `body`（节点 ID 多选或拖入子图框）

### 7.3 P2 改动：变量插值 IntelliSense

节点参数中的 textarea/Input 加变量提示：

- 输入 `{{` → 弹下拉，列出可用变量根命名空间：`triggerParams` / `vars` / `steps` / `server` / `run` / `<fanOut.as>`
- 选 `steps` → 二级下拉列出当前节点上游所有节点 id
- 选 `<id>` 后 → 三级下拉列出该节点 `output_schema` 里的字段

### 7.4 路由与菜单

```
admin 菜单(修订后)
  ├ 总览
  ├ 产品线
  ├ IM 触发器(新菜单项)         /admin/im-triggers
  ├ 能力库(重命名)              /admin/capabilities  ← 原"能力管理"
  ├ Pipelines                  /admin/test-pipelines
  ├ 节点类型(新菜单项,只读)      /admin/pipeline-node-types
  ├ 工具                       /admin/tools
  ├ 审批规则                   /admin/approval-rules
  └ 系统配置
```

### 7.5 i18n 与术语

| UI 术语 | DB 表 | 含义 |
|---------|-------|------|
| **IM 触发器**（IM Trigger） | `im_triggers` | IM 群里说的话能触发什么 |
| **能力**（Capability） | `capabilities` | LLM agent 配置（prompt + 工具白名单） |
| **节点类型**（Node Type） | `pipeline_node_types` | pipeline 节点的执行单元 |
| **流水线**（Pipeline） | `test_pipelines` | DAG 编排 |

---

## 8. 测试与迁移策略

### 8.1 实施顺序（4 阶段，每阶段独立可 ship）

```
阶段 0: node_type 注册基础设施 (1-2 周)
   └ 新增 pipeline_node_types 表 + registry + 现有 5 种 stage type 迁入注册制
   └ 验证: 现有 pipeline 跑通,前端节点选择器从 API 取

阶段 1: capabilities 表瘦身 + 6 处硬编码清理 (3-5 天)
   └ ALTER capabilities: 加 4 字段、(分两个 PR) 删 5 字段
   └ 把 FAILURE_MSGS / CAP_NAMES / HANDLER_CAPABILITIES / writeCapabilities /
     CODE_CAPABILITIES / examples 字典改为读 DB
   └ 验证: 现有 IM 触发行为零回归

阶段 2: im_triggers 表 + 路由层重构 (1-2 周)
   └ 新建 im_triggers / product_line_im_triggers 表
   └ 数据迁移
   └ ClaudeRunner.run() 路由层改读 im_triggers
   └ approval_rules.capability_key → im_trigger_key 改名
   └ 前端拆 CapabilitiesPage、改 ProductLineDetailPage、改 ApprovalRulesPage
   └ 验证: IM 触发 + 入口审批 + greet 列表零回归

阶段 3: pipeline DSL 增强 (2-3 周)
   └ 7 个新节点类型注册 (http/dm/db_update/sql_query/file_read/fan_out/template_render)
   └ 变量插值器扩展 (点记法子路径 + 内置过滤器)
   └ retry_when 表达式解析器
   └ fan_out 子运行调度器
   └ 前端节点 inspector 动态参数表单 + retry/fan_out 配置 UI
   └ 验证: 写 demo pipeline 串新节点跑通

阶段 4: handler 迁移 (3-4 周,分 L1→L2→L3 三波)
   └ internal_capability_pipelines 表 + 三条内部 pipeline 种子
   └ coordinator.triggerCapability 加 PIPELINE_DAG_HANDLERS feature flag
   └ L1 (request_handover) 上线 → 一周灰度
   └ L2 (notify_bug) 上线 → 一周灰度
   └ L3 (create_mr) 上线 → 一周灰度
   └ 全量稳定 1-2 周后删旧 handler
```

总周期 8-12 周。

### 8.2 测试矩阵

| 层 | 范围 | 工具 | 在哪个阶段补 |
|----|------|------|-------------|
| 单元 | 节点 executor 各自的纯函数行为（含错误分支） | Vitest | 阶段 0/3 |
| 单元 | 变量插值器 / 表达式解析器 | Vitest | 阶段 3 |
| 单元 | 数据迁移脚本（schema-vN.sql 转换函数） | Vitest + 临时 schema | 阶段 1/2 |
| 集成 | 每条 pipeline 用 fixture 跑 end-to-end | Vitest + pg-mem 或临时 DB | 阶段 4 |
| 集成 | IM 触发链路 from 群消息 to pipeline 启动 | `_e2e/im/simulate` 路由（已有） | 阶段 2 |
| 行为对等 | handler 路径 vs pipeline 路径同输入对比 outbound | 双跑 + diff | 阶段 4 |
| 冒烟 | 每个阶段一份 docs/smoke-*.md | Markdown 手动脚本 | 全程 |

### 8.3 数据迁移正确性保障

阶段 1 / 阶段 2 各自有数据迁移，需要：

1. **迁移前 dump**：在迁移脚本前 `SELECT ... INTO TEMP ...` 备份关键行
2. **迁移后 verify**：迁移末尾 `RAISE EXCEPTION` 在断言失败时
3. **回滚 SQL**：每个 schema-vN.sql 同步 commit 一份 `schema-vN-rollback.sql`
4. **生产前 dry-run**：迁移脚本在 staging 跑两次

### 8.4 启动一致性检查

`pipeline_node_types` 表的 enabled 行 ↔ 代码 `registerNodeType()` 调用必须一致：

```typescript
const dbTypes = await listEnabledNodeTypes()
const registeredTypes = getRegisteredNodeTypeKeys()

const dbOnly = dbTypes.filter(k => !registeredTypes.has(k))
const codeOnly = [...registeredTypes].filter(k => !dbTypes.includes(k))

if (dbOnly.length || codeOnly.length) {
  throw new Error(
    `Node type registry mismatch:\n` +
    `  DB only: ${dbOnly.join(', ')}\n` +
    `  Code only: ${codeOnly.join(', ')}`
  )
}
```

### 8.5 回滚机制

| 阶段 | 出问题怎么回滚 |
|------|--------------|
| 0 | 节点类型注册表纯增量。回滚：revert 代码 + `DROP TABLE pipeline_node_types` |
| 1 | capabilities 字段加加减减。回滚：revert 代码 + `schema-vN-rollback.sql` 反向 ALTER。删字段挪到 cleanup PR 单独 ship |
| 2 | im_triggers 表新增，product_line_capabilities 保留。回滚：revert 路由代码 |
| 3 | 新节点类型纯增量。回滚：feature flag 关闭新节点的画布选项 |
| 4 | feature flag 双轨。回滚：`PIPELINE_DAG_HANDLERS=""` 即回到 handler 路径 |

重要原则：阶段 1 / 2 的"删字段"动作必须**最后一步**——所有读取该字段的代码确认下线后再 ship 删字段的 PR。

### 8.6 风险清单

| 风险 | 等级 | 缓解 |
|------|------|------|
| 阶段 2 数据迁移把入口类 capability 漏一个 → IM 触发不到 | 高 | 迁移末尾断言行数 ≥ 入口类 capability 数量 |
| 阶段 4 pipeline 实现跟 handler 的边界 case 不对等 | 高 | 行为对等测试覆盖每个 handler 的所有路径；灰度期对比生产数据 |
| 节点类型 registry 漂移 | 中 | 启动一致性检查（§8.4） |
| pipeline DSL 表达式解析器 bug | 中 | 解析器单元测试覆盖所有运算符 + 关键边界 |
| 前端 P0 改造期间产线-IM 触发器映射页空白 | 低 | API 上线后再拆页面；过渡期保留旧路由作为重定向 |
| 阶段 1 删除 capabilities.category 影响下游 | 中 | 灰度删除：先标 deprecated 不读、灰度 1 周、再 DROP COLUMN |

### 8.7 文档与术语

- **CLAUDE.md**：把"capability"统一改成精确术语（IM 触发器 / 能力 / 节点类型 / 流水线 四个词各管各的）
- **docs/chatops.md**：架构图按 §2 修订版重画
- **docs/smoke-***：新增 4 份对应阶段
- **memory**：记录"capability 不再持有 IM 入口职责"，方便后续 session 不再走老路

### 8.8 Definition of Done（每阶段）

阶段 N 完成的判定：

1. ✓ 单元测试 + 集成测试 ≥90% 通过率
2. ✓ 对应冒烟手册执行通过
3. ✓ 生产环境跑 ≥7 天，无相关错误日志（或回滚到 N-1）
4. ✓ 前端改动通过浏览器手测
5. ✓ 文档 PR 合并

---

## 附录 A：与历史 spec 的关系

- **2026-04-14-unified-capability-pipeline-design.md**（unified spec）：本 spec 推翻该 spec 的"capability 吃 pipeline + Claude 当统一执行引擎"方向。已部分落地的 capabilities.param_schema / playbook 字段在阶段 1 删除；6 个基础设施工具（ssh_exec / file_transfer / http_probe / http_download / docker_op / file_read）的影子在 pipeline_node_types 注册表里以新节点类型方式重新表达
- **2026-04-22-im-trigger-toggle-design.md**：本 spec 把已实施的 product_line_capabilities.trigger_sources 字段在阶段 2 迁到 product_line_im_triggers 表，UX 不变
- **2026-04-21-pipeline-canvas-design.md** / **2026-04-22-pipeline-canvas-inspector-dropdown-design.md**：本 spec 的前端 §7.2 在画布上扩展节点选择器和参数表单 schema 驱动渲染，与画布主体设计兼容
