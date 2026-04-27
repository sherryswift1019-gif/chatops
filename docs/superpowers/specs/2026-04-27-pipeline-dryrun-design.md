# Pipeline 试运行（单步执行 + 真实数据）设计

**日期**：2026-04-27
**状态**：spec 待 review → implementation
**上游讨论**：用户希望流水线编辑时单步执行、利用真实数据逐步配置；同时考虑外部 webhook（GitLab/DingTalk/Feishu）触发场景

## 1. 目标

在画布编辑流水线时新增「试运行」能力：用户点节点上的 ▶ 按钮 → 后端按当前 graph 从入口跑到该节点 → 结果（每节点真实输出）持久存盘 → Inspector 侧边「上游字段」Tab 渲染成 JSON Tree → 用户点字段一键插入 `{{steps.<id>.output.<field>}}` 到下游节点参数。

**核心使用场景**：
- 用户配 LLM 节点 → 试跑一次 → 看到真实 LLM JSON 产出 → 配下游 switch / template_render 时直接从树里点字段
- 流水线由 GitLab webhook 触发：用户从 test_runs 历史选一条真 webhook payload 作为试跑 triggerParams，跟生产链路同款

**非目标（v1 不做）**：
- 单节点独立试跑（不重跑上游）
- LLM `outputFormat='json'` 时用户在节点 params 里自定义 outputSchema（P2 议题）
- 试跑取消按钮（用户离开 → 后端继续跑到 done）
- 并发试跑同一 pipeline（后端 advisory lock 拒绝）
- 试跑结果作为审计/回放用途（snapshot 仅供配置阶段消费）

## 2. 关键决策摘要

| # | 决策点 | 选定方案 |
|---|--------|---------|
| 2.1 | 试运行用哪份 graph | **强制先保存再试运行**（dirty 拒绝） |
| 2.2 | 副作用节点处理 | **逐节点 prompt**（dm/db_update/script/approval/http 弹决策框；wait_webhook/im_input 真等外部触发） |
| 2.3 | 快照存储位置 | **DB 持久化**：新表 `pipeline_dryrun_snapshots`，独立于 test_runs |
| 2.4 | 试运行起点 | **从入口跑到当前节点**（重跑全部上游） |
| 2.5 | Stub 内容生成 | **A：从 `pipeline_node_types.output_schema` 递归生成空值** |
| 2.6 | 触发参数来源 | **B + 历史回放 + 自定义 JSON 三选**（覆盖 webhook 场景） |
| 2.7 | 实施分期 | **不分期，一次做完** |
| 2.8 | 手填输出 UI | **Schema 模板 + 自由编辑**（Monaco/textarea 预填模板） |
| 2.9 | 过期检测 | **Hash 上游 params**（保存时算每节点 hash，读快照时对比） |
| 2.10 | 决策记忆 | **记忆上次决策**（next time 弹框预选 + 预填手填值） |
| 2.11 | 上游字段树 UI | **Inspector 侧边 Tab + JSON Tree**（点 leaf 复制/插入路径） |
| 2.12 | 取消支持 | **不支持取消**（后端继续跑完 → done） |
| 2.13 | wait_webhook/im_input | **不 stub，让用户外部真触发**（沿用现有 langgraph interrupt 模式） |
| 2.14 | Runner 架构 | **Wrapper 模式**：复用 `buildGraphFromPipeline` + 注入 dryRunFlavor hooks，副作用节点套 interrupt wrapper |

## 3. 数据模型

### 3.1 schema-v45：`pipeline_dryrun_snapshots` 表

```sql
CREATE TABLE pipeline_dryrun_snapshots (
  pipeline_id           INT NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  node_id               TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('success','failed','skipped')),
  output                JSONB NOT NULL DEFAULT '{}',     -- 写入 stepOutputs[node_id].output 的内容
  source                TEXT NOT NULL CHECK (source IN ('real','stub','manual')),
  upstream_params_hash  TEXT NOT NULL,                    -- SHA256({上游可达节点 params 排序}) 过期检测
  last_decision         TEXT,                             -- 决策记忆：real/stub/manual；下次默认值
  last_manual_input     JSONB,                            -- 如果 last_decision='manual'，上次手填的 JSON（下次预填）
  duration_ms           INT,
  error                 TEXT,
  ran_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pipeline_id, node_id)
);

CREATE INDEX idx_dryrun_snapshots_pipeline ON pipeline_dryrun_snapshots(pipeline_id);
```

**设计要点**：
- **覆盖式**：PRIMARY KEY = (pipeline_id, node_id) → 一个节点一个最新快照，UPSERT 覆盖
- **解耦 graph 结构**：删节点不级联删 snapshot（snapshot 只看 pipeline_id），保留以备恢复；UI 通过 graph 上下文判定是否显示
- **不复用 test_runs**：dryrun 与 prod runs 语义不同（前者无 trigger 链路、无 logs 持久化、副作用决策不属于 test_run 概念）

### 3.2 `pipeline_dryrun_sessions` —— 内存 Map（不持久化）

```ts
Map<sessionId, {
  pipelineId: number
  threadId: string                                  // langgraph thread_id = 'dryrun-<sessionId>'
  decisionWaiters: Map<nodeId, (decision) => void>  // SSE wait → /decide resolve
  startedAt: Date                                   // 30min 后强制 cleanup
}>
```

会话生命周期：done / error / **会话创建后 30 分钟硬超时** → 从 Map 删 + 清 langgraph checkpointer 的 thread。

## 4. Dry-run Runner（Wrapper 模式）

落点：新建 [`src/pipeline/dryrun-runner.ts`](../../src/pipeline/dryrun-runner.ts)。

### 4.1 整体流程

```
POST /admin/test-pipelines/:id/dry-run/run-to/:nodeId
  ↓ 校验 graph 已保存（前端传的 hash 与 DB 一致），dirty 拒绝
  ↓ pg_try_advisory_lock(pipeline_id)；并发 → 409
  ↓ 计算每节点 upstream_params_hash
  ↓ buildGraphFromPipeline({graph: 截到 :nodeId 之前, hooks: dryRunHooks, ...})
  ↓ app.compile({ checkpointer: PostgresSaver(threadId='dryrun-<sessionId>') })
  ↓ 启动 SSE stream
       ├─ 节点开始/完成 → 'progress' chunk
       ├─ 副作用节点（dm/db_update/script/approval/http）
       │    → interrupt('dryrun-decision', {nodeId, params, lastDecision, schemaTemplate})
       │    → SSE 'decision-needed' chunk
       │    → 等前端 POST /decide
       │    → resume(Command({decision, manualOutput}))
       │    → 按 decision 执行：real/stub/manual → 写 snapshot
       ├─ wait_webhook / im_input → 沿用现有 interrupt（不 wrap）
       │    → SSE 'waiting-external' chunk（含 webhookTag/imPrompt）
       │    → 用户外部真触发 → graph 自然 resume
       ├─ 普通节点（sql_query/file_read/llm_agent/template_render/switch/fan_out）→ 直接真跑
       └─ 节点完成 → UPSERT pipeline_dryrun_snapshots → 'snapshot' chunk
  ↓ 完成 → 'done' chunk + 关闭 SSE + 清 session + 释放 advisory lock
```

### 4.2 hooks 扩展

[`src/pipeline/graph-builder.ts`](../../src/pipeline/graph-builder.ts) `StageHooks` 接口加可选 `dryRunFlavor`：

```ts
interface DryRunFlavor {
  // 副作用节点执行前调用，由调用方决定走 real/stub/manual
  beforeSideEffect: (
    nodeId: string,
    nodeType: string,
    params: unknown,
  ) => Promise<{ decision: 'real' | 'stub' | 'manual'; output?: Record<string, unknown> }>

  // 写快照
  recordSnapshot: (nodeId: string, snapshot: {
    status: 'success' | 'failed' | 'skipped'
    output: Record<string, unknown>
    source: 'real' | 'stub' | 'manual'
    durationMs: number
    error?: string
  }) => Promise<void>

  // 上游 hash 计算结果，写快照时一并落
  upstreamHashOf: (nodeId: string) => string
}

interface StageHooks {
  // ... 现有字段
  dryRunFlavor?: DryRunFlavor
}
```

### 4.3 节点处理矩阵

| 节点类型 | dry-run 行为 |
|---|---|
| `dm` / `db_update` / `script` / `approval` / `http` | **wrapper**：先 `interrupt('dryrun-decision')` → resume 后按 decision 走 |
| `wait_webhook` / `im_input` | **不 wrap**，沿用现有 interrupt → SSE 推 `waiting-external` → 用户外部真触发 |
| `sql_query` / `file_read` / `llm_agent` / `template_render` / `switch` / `fan_out` | **不 wrap**，直接真跑 |

**关键决策**：
- **`http` 一律弹**（不区分 GET/POST/DELETE，保守）
- **`fan_out` 内部副作用节点**：fan_out 自身不 wrap，但其子图执行时碰到副作用节点是否自动触发 wrapper **取决于 fan_out executor 是否经 graph-builder 调度子节点**——**plan 阶段需探索 [`src/pipeline/node-types/fan-out.ts`](../../src/pipeline/node-types/fan-out.ts) 实际实现**：若直接调 NodeExecutor.execute() 不经 graph-builder dispatcher，则 wrapper 不会自动覆盖，需对 fan_out 子节点单独处理（v1 可保守：fan_out 内部所有节点强制走 stub）
- **checkpointer 用 PostgresSaver + 独立 thread_id `dryrun-<sessionId>`**：与 prod test_runs 物理隔离

### 4.4 wrapper 实现要点

```ts
// 在 buildGraphFromPipeline switch 节点 dispatcher 内：
case 'dm':
case 'db_update':
case 'script':
case 'approval':
case 'http': {
  const realNode = buildExecutorNode(node, i, stageContext, triggerParams)  // 现有
  if (hooks.dryRunFlavor) {
    builder = builder.addNode(name, async (state) => {
      const decision = await hooks.dryRunFlavor.beforeSideEffect(node.id, node.stageType, node.params)
      if (decision.decision === 'real') {
        const startedAt = Date.now()
        const result = await realNode(state)
        await hooks.dryRunFlavor.recordSnapshot(node.id, { ...result, source: 'real', durationMs: Date.now() - startedAt })
        return result
      }
      // stub / manual：直接构造 stepOutputs，跳过 real 执行
      const output = decision.output!
      await hooks.dryRunFlavor.recordSnapshot(node.id, { status: 'success', output, source: decision.decision, durationMs: 0 })
      return {
        currentStageIndex: i,
        stageResults: { name: node.name, status: 'success', output: JSON.stringify(output), startedAt: ..., durationMs: 0 },
        stepOutputs: { [node.id]: { status: 'success', output } },
      }
    })
    break
  }
  builder = builder.addNode(name, realNode)
  break
}
```

非副作用节点的 wrapper：仅在 realNode 完成后调 `recordSnapshot({source: 'real'})`，无 interrupt。

## 5. 副作用节点决策协议

### 5.1 类型 A：决策框（dm / db_update / script / approval / http）

SSE chunk：
```json
{
  "type": "decision-needed",
  "sessionId": "...",
  "nodeId": "n3",
  "nodeName": "send-im",
  "stageType": "dm",
  "params": { "target": "...", "text": "..." },
  "lastDecision": "stub",
  "lastManualOutput": { "messageId": "fake-123" },
  "schemaTemplate": { "messageId": "", "deliveredAt": "" }
}
```

前端弹 Modal 三 Tab，根据 `lastDecision` 默认选中：

| Tab | 行为 |
|---|---|
| **真跑** | 真调实际 hooks（IM API / DB / SSH）。点确认 → POST `/decide` body `{decision:'real'}` |
| **Stub** | 显示 schemaTemplate（只读 JSON 预览）。点确认 → POST `{decision:'stub'}` |
| **手填** | Monaco/textarea 预填 schemaTemplate 或 lastManualOutput → 用户编辑 → POST `{decision:'manual', manualOutput: {...}}` |

底部「✓ 记住此节点的选择」复选框：勾 → 写 `last_decision` + `last_manual_input`；不勾 → 仅本次。

### 5.2 类型 B：等待框（wait_webhook / im_input）

SSE chunk（不需 decide）：
```json
{
  "type": "waiting-external",
  "sessionId": "...",
  "nodeId": "n4",
  "stageType": "wait_webhook",
  "hint": {
    "webhookTag": "deploy",
    "webhookUrl": "http://localhost:3000/webhook/generic?tag=deploy&runId=<dryrun-runId>",
    "imGroupId": "...",
    "imPrompt": "请回复包名..."
  }
}
```

前端：画布上对应节点添加「等待中」状态（黄色脉动边框），侧边面板显示 hint（webhook URL 可一键复制 + IM 提示文案）。用户外部触发 → 现有 graph-runner webhook/im 路由自然 resume → SSE 接到下个 progress chunk。

**关键问题**：dry-run thread_id 与 prod 不同（`dryrun-<sessionId>` vs `<runId>`），现有 webhook 路由查 thread_id 怎么找到 dry-run session？
- **方案**：dry-run runner 启动时，给 webhook router 注册临时映射 `webhookTag → thread_id`（含 dry-run 前缀）。session 结束时解注册。具体扩展点：[`src/pipeline/im-router.ts`](../../src/pipeline/im-router.ts) 与 webhook router 加 dry-run 命名空间。
- 实施 Task 时单独探索现有 webhook 路由实现，spec 阶段标记此为已知风险点。

### 5.3 决策一致性

- **会话级缓存**：同一次试跑会话内不重复弹（Map<nodeId, decision>）
- **跨会话默认值**：从 DB `last_decision` / `last_manual_input` 读
- **「记住」勾选**：写回 DB

## 6. Stub 自动生成

落点：[`src/pipeline/dryrun-stub.ts`](../../src/pipeline/dryrun-stub.ts)（新文件）。

```ts
export function generateStubFromSchema(schema: JsonSchema): unknown {
  if (schema.enum) return schema.enum[0]
  const type = Array.isArray(schema.type)
    ? schema.type.find(t => t !== 'null') ?? schema.type[0]
    : schema.type
  switch (type) {
    case 'string': return ''
    case 'number': case 'integer': return 0
    case 'boolean': return false
    case 'null': return null
    case 'array': return []
    case 'object': {
      const out: Record<string, unknown> = {}
      const props = schema.properties ?? {}
      for (const [k, sub] of Object.entries(props)) {
        out[k] = generateStubFromSchema(sub as JsonSchema)
      }
      return out
    }
    default: return null
  }
}
```

**13 种节点的预期 stub**：
| 节点 | Stub 输出 |
|---|---|
| `script` | `{stdout: '', stderr: '', exitCode: 0}` |
| `dm` | `{messageId: '', deliveredAt: ''}` |
| `db_update` | `{rowsAffected: 0}` |
| `http` | `{statusCode: 0, body: {}, headers: {}}` |
| `approval` | `{decision: 'approved', approver: '', comment: ''}` |
| `sql_query` | `{rows: []}` |
| `llm_agent`（output_schema 仅 `{text: string}`）| `{text: ''}` —— **v1 已知不足**：`outputFormat='json'` 时 schema 不够，用户需手填 |

## 7. 试运行启动对话框

落点：[`web/src/pipeline-canvas/panels/DryRunStartModal.tsx`](../../web/src/pipeline-canvas/panels/DryRunStartModal.tsx)（新文件）。

### 7.1 三 Tab 结构

| Tab | 数据源 | 主用途 |
|---|---|---|
| **默认** | `pipeline.triggerParams` | 已配过默认值的 pipeline |
| **历史回放** | `GET /admin/test-pipelines/:id/recent-trigger-params?limit=20` | **GitLab/DingTalk/Feishu webhook 场景主路径** |
| **自定义 JSON** | Monaco editor 空白起步 | 新流水线无历史 |

### 7.2 历史回放 API

```
GET /admin/test-pipelines/:id/recent-trigger-params?limit=20
→ [
  { runId, triggerType, triggeredBy, triggerParams, startedAt, status },
  ...
]
```

后端从 `test_runs` 查最近 N 条，前端列表渲染：
```
[2026-04-26 14:02] gitlab_webhook by webhook       success   {ref:"main", project:{...}, ...}
[2026-04-26 11:18] dingtalk by zhangsan            success   {action:"deploy", env:"prod"}
[2026-04-25 18:30] manual by yan                   failed    {pipelineId:42}
```

每行有「使用此参数」按钮 → 选定 → 预览 JSON → 确认。

### 7.3 提交

POST `/admin/test-pipelines/:id/dry-run/run-to/:nodeId`，body：
```json
{
  "triggerParams": { ... },
  "triggerType": "gitlab" | "dingtalk" | "feishu" | "manual",
  "triggeredBy": "<current-user>"
}
```

后端用以构造 `stageContext` —— `pipeline.id`、`run.triggeredBy`、`run.triggerType` 等内置变量与 prod 一致。

### 7.4 触发位置

- **节点级**：每个节点视觉右上角「▶」按钮 → 试跑到（不含）此节点
- **整图级**：toolbar 加「▶ 试运行整图」按钮 → 试跑到所有终端节点

## 8. Inspector 上游字段树 UI

落点：[`web/src/pipeline-canvas/panels/UpstreamFieldsTab.tsx`](../../web/src/pipeline-canvas/panels/UpstreamFieldsTab.tsx)（新文件），挂在 NodeInspector Drawer 里。

### 8.1 Tab 结构

NodeInspector 改用 antd `Tabs`：
- **「参数」**（默认） — 现有所有 Form.Item
- **「上游字段」** — 新 Tab（仅当当前节点 ancestors 非空时显示）

### 8.2 数据加载

进 Tab → `GET /admin/test-pipelines/:id/dry-run/snapshots` → 用现有 `computeAncestors`（[graph-validation.ts:112](../../src/pipeline/graph-validation.ts#L112)）过滤当前节点的可达上游 → 仅渲染对应 snapshots。

### 8.3 渲染（antd Tree）

按上游节点分组，每组节点头标 source（`真跑`绿/`Stub`黄/`手填`蓝）+ 时间戳 + 是否 stale ⚠：

```
▼ classify (llm_agent)         [真跑 14:02]
   ├─ intent: "rollback"         💡 点击插入
   ├─ score: 90                  💡
   └─ ▼ details
        └─ commit_sha: "abc123"  💡

▼ query (sql_query)            ⚠ 上游已变（[重跑]）
   └─ rows: [3 items]
```

### 8.4 路径生成 + 插入

点 leaf：
- 路径生成：`{{steps.classify.output.intent}}` / `{{steps.q.output.rows[0].id}}`
- 写入剪贴板 + Toast 提示
- **如果当前 Form 有 focus 中的 Input**：直接 insert 到光标位置

### 8.5 没有 snapshot 的上游

显示节点头但 body 写「未试跑，[▶ 试跑此节点]」按钮。

## 9. 上游过期检测

### 9.1 hash 算法

```ts
function computeUpstreamHash(graph: PipelineGraph, targetNodeId: string): string {
  const ancestors = computeAncestors(graph, targetNodeId)  // 现有 graph-validation.ts:112
  const sorted = [...ancestors].sort()
  const fingerprint = sorted.map(id => {
    const n = graph.nodes.find(x => x.id === id)!
    return {
      id: n.id,
      stageType: n.stageType,
      params: n.params,
      capabilityKey: (n as any).capabilityKey,
      outputFormat: (n as any).outputFormat,
      script: (n as any).script,
    }
  })
  const upstreamEdges = graph.edges
    .filter(e => ancestors.has(e.source) && ancestors.has(e.target))
    .map(e => ({ source: e.source, target: e.target, condition: e.condition }))
    .sort((a, b) => `${a.source}->${a.target}`.localeCompare(`${b.source}->${b.target}`))
  return sha256(JSON.stringify({ nodes: fingerprint, edges: upstreamEdges }))
}
```

**进 hash 的字段**：影响节点输出值/schema 的 — params/script/capabilityKey/outputFormat/stageType + 上游边
**不进 hash**：position、displayName、retryCount、timeoutSeconds、onFailure（这些不影响输出值）

### 9.2 比较时机

- **后端 `GET /dry-run/snapshots`**：返回每条 snapshot 时附 `stale: bool`（实时计算当前 hash 比对 stored hash）
- **前端「上游字段」Tab**：`stale=true` 节点头标 ⚠ +「重跑」按钮
- **dry-run 启动时**：检查目标节点所有上游 snapshots → 如有 stale → SSE 推 `stale-warning` → 前端弹「以下上游已变，建议先重跑：xxx, yyy」「[继续用旧快照] [先重跑上游]」

### 9.3 边缘情况

| 场景 | 行为 |
|---|---|
| 上游节点删除 | snapshot 残留（PRIMARY KEY 解耦），UI 不显示，无 stale 计算 |
| 上游加新节点 | ancestors 集合变 → hash 变 → stale |
| 改 retryCount/timeoutSeconds | 不进 hash，不算 stale |
| 改 position | 不进 hash |

## 10. SSE API + 错误处理

### 10.1 端点清单

| 端点 | 用途 |
|---|---|
| `GET /admin/test-pipelines/:id/recent-trigger-params?limit=20` | Tab 2 历史回放数据源 |
| `GET /admin/test-pipelines/:id/dry-run/snapshots` | 拉所有节点最新 snapshot（含 stale 标） |
| `DELETE /admin/test-pipelines/:id/dry-run/snapshots` | 清所有 snapshot |
| `DELETE /admin/test-pipelines/:id/dry-run/snapshots/:nodeId` | 清单个节点缓存 |
| `POST /admin/test-pipelines/:id/dry-run/run-to/:nodeId` | **SSE 流**，启动试跑（`nodeId='*'` = 整图） |
| `POST /admin/test-pipelines/:id/dry-run/sessions/:sessionId/decide` | 提交副作用决策 |

### 10.2 SSE chunk 协议

```
event: progress
data: {"nodeId":"q","status":"running"}

event: stale-warning            # 仅启动时若有 stale 上游
data: {"staleNodeIds":["q"]}

event: snapshot
data: {"nodeId":"q","status":"success","source":"real","output":{...}}

event: decision-needed          # 副作用节点，等 /decide
data: {"sessionId":"...","nodeId":"send_dm","stageType":"dm","params":{...},"lastDecision":"stub","schemaTemplate":{...}}

event: waiting-external         # wait_webhook / im_input
data: {"nodeId":"wait1","stageType":"wait_webhook","hint":{"webhookTag":"deploy","webhookUrl":"..."}}

event: error
data: {"nodeId":"q","error":"...","fatal":true}

event: done
data: {"sessionId":"...","reachedNodeId":"sw","durationMs":1200}
```

### 10.3 错误处理矩阵

| 错误 | 处理 |
|---|---|
| graph dirty | 后端 400「先保存再试运行」 |
| graph 校验失败 | 后端 400「graph 不合法：详情」 |
| 节点执行抛错（非副作用） | snapshot status='failed' + error → SSE `snapshot` chunk → 终止下游 → SSE `done` |
| 副作用节点真跑失败 | 同上 |
| 用户离开页面 / SSE 断开 | 后端继续跑到 done（snapshot 仍写入），下次进画布看到结果 |
| 30 分钟硬超时 | SSE error event + `fatal:true`，关闭 stream |
| 同一 pipeline 并发 dry-run | `pg_try_advisory_lock(pipeline_id)` → 409 |
| `wait_webhook` 真等超时 | 沿用现有 wait_webhook stage 的 timeoutSeconds |

### 10.4 权限

仅 admin 角色（沿用 `/admin/*` 鉴权），不引入新权限。

## 11. 实施次序建议

写 plan 时拆分参考（最终以 writing-plans 输出为准）：

1. **后端基础**：schema-v45 migration + repository（`pipeline_dryrun_snapshots` CRUD）
2. **Hash 算法**：`computeUpstreamHash` + 单测
3. **Stub 生成**：`generateStubFromSchema` + 单测（13 种节点 schema）
4. **Dry-run runner Wrapper**：`dryRunFlavor` hooks 接口 + graph-builder 注入 wrapper + 单测
5. **SSE 路由**：6 个 API endpoint（含 advisory lock + session map）
6. **Webhook 路由扩展**：dry-run 命名空间映射（im-router + webhook-router）
7. **前端 DryRunStartModal**：3 Tab + 历史回放 API 客户端
8. **前端 SSE 客户端**：EventSource 接 chunk + 状态机
9. **前端决策 Modal**：3 Tab（real/stub/manual）+ Monaco 编辑器
10. **前端 waiting-external 状态**：画布节点黄边 + 侧栏 hint
11. **前端 UpstreamFieldsTab**：antd Tree + 点 leaf 插入
12. **前端节点 ▶ 按钮 + toolbar 整图按钮**
13. **集成测试**：端到端 mock + e2e

## 12. 未来工作（明确不在本次范围）

- **LLM 节点 outputSchema 字段**（让用户在 params 里声明 JSON 产出 schema）：解决 `outputFormat='json'` 时 stub 不够用的问题
- **试跑取消按钮**：当前不支持，用户离开则继续跑到 done
- **并发试跑**：v1 advisory lock 拒绝；如有需求未来改 session 隔离
- **快照保留策略**：v1 永远覆盖最新；如需历史多版本，加 `version` 列改主键
- **变量类型推断**：上游字段树仅显示当前实际值类型；如要显示"基于 schema 推断的可能值范围"，需要静态分析
