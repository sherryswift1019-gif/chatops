# Pipeline Webhook Trigger 设计

**日期**：2026-04-28
**状态**：Draft（待用户审阅）
**关联**：`src/pipeline/trigger.ts`（已预留 `apiTrigger`）、`src/db/schema-v45.sql`（已预留 `test_runs.trigger_params`）

## 1 · 背景与目标

ChatOps 现有 4 种 pipeline 触发源：IM 群聊、管理后台手动按钮、内部 API（带 session）、cron 调度。

外部系统（CI、告警、第三方 webhook）无法触发 pipeline——管理后台 API 走 session cookie，对外暴露不合理。

本设计补齐第 5 种触发：**外部系统通过 URL + token 推一个 JSON payload 即可启动指定 pipeline**。

非目标（v1 不做）：
- HMAC 签名验证（仅 token）
- 多副本一致的限流（v1 进程内）
- per-pipeline RBAC
- 内置幂等去重（要去重让调用方在 payload 里带 `idempotencyKey`，stage 自行判断）
- payload schema 校验（原样存进 trigger context）

## 2 · 决策摘要

| 决策点 | 选择 | 备选（已否决） |
|--------|------|---------------|
| URL/鉴权 | per-pipeline 独立 URL，token 在 path 里 | 全局 Bearer Token；URL token + Bearer 双轨 |
| Token 存储 | 新表 `pipeline_webhooks`，一 pipeline N webhook | 在 `test_pipelines` 加 2 列；复用 `pipeline_bindings` |
| Payload 映射 | 整个 body 原样存进 `state.triggerParams`，`{{triggerParams.x.y}}` 取值 | JSONPath mapping → 平铺 vars |
| Server 分配 | body `_servers` > webhook `default_servers` > pipeline 默认 | 必须 serverless |
| 响应语义 | 立即 202 + `{runId, statusUrl}`，异步执行 | `?wait=1` 同步；SSE 流 |
| 鉴权强度 | 仅 URL token | 可选 HMAC；强制 secret |
| Rotate 策略 | 立即生效，不灰度并存（要灰度 = 新建第二条 webhook） | 双 token 共存窗口 |

## 3 · 架构总览

### 3.1 公开端点路径

- 公开触发：`POST /webhook/pipeline/:token`（注册在 `src/server.ts`，与 `/webhook/feishu`、`/webhook/gitlab` 同级）
- 管理 CRUD：`/admin/api/pipelines/:pipelineId/webhooks/*`（注册在 `src/admin/routes/pipeline-webhooks.ts`，走现有 admin session）

公开端点不挂在 /admin 前缀下，避免和 `requireAuth` 白名单逻辑耦合。

```
外部系统
  │ POST /webhook/pipeline/:token   Body: { ...JSON, "_servers"? }
  ▼
webhook-router (公开,无 session)
  ├─ 解析 token → pipeline_webhooks 表（含 enabled）
  ├─ 限流 / 审计 / 写 last_used_at + trigger_count
  ├─ 拆 _servers vs payload
  └─ 调 runPipeline(pid, servers, apiTrigger({
       triggeredBy: `webhook:${id}:${name}`,
       params: payload,   ← 复用现有 triggerParams 通路
     }))
  ▼
runPipeline → graph-runner → state.triggerParams = payload
  ├─ capability 节点：{{triggerParams.commits[0].id}}（已支持）
  └─ script / approval / im_input 等：{{triggerParams.xxx}}（本期补 script）
```

**改动面**
- 新表 `pipeline_webhooks` + schema-v46
- 公开路由 `src/admin/routes/webhooks.ts`（无 session 守卫）
- 管理路由 `src/admin/routes/pipeline-webhooks.ts`（带 session）
- 前端 pipeline 详情页加「Webhook 触发器」面板
- 小扩展：`VariableContext` 增 `triggerParams?` 字段，让 script 节点也能 `{{triggerParams.*}}`

## 4 · 数据模型

新增 `src/db/schema-v46.sql`：

```sql
CREATE TABLE IF NOT EXISTS pipeline_webhooks (
  id              SERIAL PRIMARY KEY,
  pipeline_id     INT NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  token           TEXT NOT NULL UNIQUE,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  default_servers JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT NOT NULL DEFAULT '',
  last_used_at    TIMESTAMPTZ,
  last_run_id     INT,
  trigger_count   INT NOT NULL DEFAULT 0,
  UNIQUE (pipeline_id, name)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_webhooks_pipeline
  ON pipeline_webhooks(pipeline_id);
```

字段说明：
- `name`：UI 显示 + 同 pipeline 内唯一；rotate / 多上游接入时用
- `token`：`crypto.randomBytes(32)` → url-safe base64（43 字符）
- `default_servers`（jsonb，nullable）：覆盖 pipeline 默认 server_assignment，形如 `{"deploy": ["server-A"]}`
- `last_used_at` / `last_run_id` / `trigger_count`：UI 上的活跃度指标
- 不放 secret 列（用户选了仅 token 鉴权）
- 不放 rate_limit 列（先用全局默认 60/min/token）

### 4.1 与 `test_runs` 的关联

不在 `test_runs` 加列。webhook 触发时调 `runPipeline()` 走 `apiTrigger`，`triggered_by` 写 `webhook:<webhookId>:<name>`：
- 既能从 run 反查 webhook 来源
- 沿用现有 string 列，零迁移
- `test_runs.trigger_params`（v45 已加）继续装 payload 完整快照

### 4.2 SCHEMA_FILES 维护

按 [CLAUDE.md "Schema 编号顺序"](../../../CLAUDE.md) 约定，v46 同时追加到：
- `src/db/migrate.ts:SCHEMA_FILES`
- `src/__tests__/helpers/db.ts:SCHEMA_FILES`（确认无 seed 污染再加）

## 5 · HTTP 接口

### 5.1 公开触发端点（无 session）

```
POST /webhook/pipeline/:token
Content-Type: application/json
```

挂在根路径 `/webhook/*` 下（与现有 `/webhook/feishu`、`/webhook/gitlab` 同前缀），由 `src/server.ts` 直接注册，不经过 `adminPlugin.requireAuth`。SPA fallback 已排除 `/webhook` 前缀。

请求 body：必须是 JSON object（顶层），任意键值对。

特殊保留键（顶层）：
- `_servers`：`Record<string, string[]>`，覆盖 webhook 默认 servers。在传给 pipeline 前从 payload 删除，**不污染** `triggerParams`。

响应表：

| HTTP | 含义 | body |
|------|------|------|
| 202 | 已接受、异步执行 | `{ runId: number, statusUrl: string, triggeredAt: string (ISO 8601) }` |
| 400 | body 不是 JSON object / `_servers` 形状不对 | `{ error: "..." }` |
| 401 | token 不存在或已禁用（**不区分**，防探测） | `{ error: "invalid webhook token" }` |
| 404 | token 通过认证但 pipeline 已删 / `enabled=FALSE` | `{ error: "pipeline not found or disabled" }` |
| 413 | body > 1MB | `{ error: "payload too large" }` |
| 429 | 限流 | `{ error: "rate limited", retryAfter }` + `Retry-After` header |
| 500 | 服务器异常 | `{ error: "..." }` |

认证语义：
- token 仅在 URL path，不看 header
- DB UNIQUE 索引查询天然恒定时间，无需应用层 timing-safe 比较
- 401 永远返回固定字符串 `invalid webhook token`，不暴露原因

### 5.2 管理端点（带 session）

```
GET    /admin/api/pipelines/:pipelineId/webhooks
       → 列表，每行 token 字段为前 8 字符 + "…"

POST   /admin/api/pipelines/:pipelineId/webhooks
       Body: { name, defaultServers? }
       → { id, name, token, url } —— 完整 token 仅此一次返回

POST   /admin/api/pipelines/:pipelineId/webhooks/:id/rotate
       → 完整新 token + url，仅此一次返回；旧 token 立即失效

PATCH  /admin/api/pipelines/:pipelineId/webhooks/:id
       Body: { name?, enabled?, defaultServers? }

DELETE /admin/api/pipelines/:pipelineId/webhooks/:id
```

Token 显示约定：
- 完整 token 只在 create / rotate 响应里出现一次
- 后续查询永远只返回前 8 字符 + 省略号
- 前端 create / rotate 后弹「请保存」对话框

## 6 · 数据流

### 6.1 触发时序

1. Fastify pre-parse 1MB 体积保护（>1MB → 413）
2. 解析 `:token` → `SELECT FROM pipeline_webhooks WHERE token=$1 AND enabled=TRUE`
   - 未命中或 disabled → 401
3. 限流（per-token 内存 sliding-window，60/min；超出 → 429 + `Retry-After`）
4. 加载 `pipeline`：不存在 / `enabled=FALSE` → 404
5. 校验 payload：必须 JSON object；`_servers` 若有必须 `Record<string, string[]>`，否则 400
6. 拆 `_servers`，构造 `effectiveServers`：
   ```
   body._servers > webhook.default_servers > pipeline.serverRoles ?? {}
   ```
7. 调 `runPipeline(pipelineId, effectiveServers, apiTrigger({ triggeredBy, params: payloadWithoutUnderscoreKeys }))` 拿到 `runId`（fire-and-forget；`runPipeline` 返回 `runId` 后异步推进，不等 pipeline 完成）
8. 同步 `UPDATE pipeline_webhooks SET last_used_at=NOW(), last_run_id=runId, trigger_count = trigger_count + 1`（语义是"最近一次触发"，不是"最近一次成功"）
9. 写 audit_log（详见 6.4）
10. 返回 202 + `{ runId, statusUrl, triggeredAt }`

`runPipeline` 现有契约本来就是"返回 runId 后异步推进"，webhook router 直接 await 即可，无需新队列。

### 6.2 `triggerParams` 在 stage 里的可用性

| Stage 类型 | 现状 | 本期改动 |
|-----------|------|--------|
| capability | 已支持 `{{triggerParams.xxx}}`（嵌套 + JSONPath 索引） | 无 |
| script | **不支持**（VariableContext 只有 vars/steps/server 等） | `VariableContext` 加可选 `triggerParams: Record<string, unknown>`；graph-runner 传值；`resolveVariables` 复用现有 `resolvePath`（已支持点记法 + `[N]`） |
| approval | 已支持（approverIdsResolver / approvalDescription 模板展开） | 无 |
| im_input | dry-run 已用；正式运行不依赖 | 无 |
| http / db_update / dm 等 paramSchema 节点 | 已经看到 triggerParams（v45 dry-run 已确认） | 无 |

示例（GitHub push payload）：
```
{{triggerParams.head_commit.id}}
{{triggerParams.commits[0].author.name}}
{{triggerParams.repository.full_name}}
```

### 6.3 `_servers` 解析与失败回退

```ts
// 概念伪代码
const servers =
  isPlainObject(body._servers) ? body._servers :
  isPlainObject(webhook.defaultServers) ? webhook.defaultServers :
  pipeline.serverRoles ?? {}
```

- `effectiveServers === {}` → 走 serverless 路径（`runPipeline` 已支持）
- `_servers` 引用了不存在的 server name → `runPipeline` 内部 throw → catch 后把错写入 `test_runs.error_message` 且 `status='failed'`；HTTP 仍 202
- `_servers` 形状本身就错（如 `_servers: "foo"`）→ 步骤 5 同步阶段 400

### 6.4 审计

成功创建 run 的请求**天然有迹可循**，无需额外审计表：
- `test_runs.triggered_by` = `webhook:<webhookId>:<name>`（含来源 webhook id 与名称）
- `test_runs.trigger_params` 装完整 payload 快照（v45 已存）
- `test_runs.created_at` 是触发时间戳
- `pipeline_webhooks.last_used_at` / `last_run_id` / `trigger_count` 提供 per-webhook 活跃度

未到 run 阶段的失败（401/429/404/400/413）**v1 不持久化**——会出现在 Fastify 请求日志里供运维查（pino + structured logging），但不进 DB。原因：
- 现有项目没有独立 audit_log 表（`/audit-log` 是 tasks/approval_requests/bug_analysis_reports 三表 UNION 视图）
- 401/429 大量出现就是被刷探测，落库会被刷爆
- 一旦未来要把这些纳入审计，建独立 `audit_events` 表是另一个 spec

webhook-router 的请求日志（`req.log.info`）字段：
```
{ webhookId?, webhookName?, runId?, payloadSize, ipHash, decision: 'accepted'|'rejected', reason }
```
其中 `ipHash = sha256(remoteAddr).slice(0, 16)`，避免明文存 IP。

### 6.5 限流

- v1 进程内 sliding-window，per-token 60/min
- 实现：webhook-router 顶部一个 `Map<token, { count, windowStart }>`
- 多副本部署不严格——v1 有意简化；下版引 Redis 时升级
- 超限 → 429 + `Retry-After: <seconds>` header

## 7 · 错误处理

### 7.1 错误响应表

| 场景 | 时机 | HTTP | 写 test_runs? | 持久化审计? |
|------|------|------|--------------|------------|
| body 不是 JSON / 不是 object | 同步 | 400 | 否 | 否（仅 req.log） |
| body > 1MB | Fastify pre-parse | 413 | 否 | 否（仅 req.log） |
| token 不存在 / 禁用 | 同步 | 401 | 否 | 否（仅 req.log） |
| 限流 | 同步 | 429 + Retry-After | 否 | 否（仅 req.log） |
| pipeline 不存在 / 禁用 | 同步 | 404 | 否 | 否（仅 req.log） |
| `_servers` 字段类型错 | 同步 | 400 | 否 | 否（仅 req.log） |
| `_servers` 引用未知 server | 异步 | 202（已发） | 是（failed + error_message） | 是（test_runs 自身） |
| 制品输入解析失败 | 异步 | 202（已发） | 是 | 是（test_runs 自身） |
| stage 失败 | 异步 | 202（已发） | 是 | 是（test_runs 自身） |
| webhook-router 自身崩溃 | 同步 | 500 | 否 | 否（仅 req.log） |

原则：v1 没有独立 audit_log 表，所有"未到 run 阶段"的请求只通过 Fastify 结构化日志（pino）留痕；成功创建 run 的请求由 `test_runs` 行自身完成审计。

### 7.2 并发与竞争

- 同一 webhook 高并发触发：不去重，N 个独立 run；要去重让调用方在 payload 带 `idempotencyKey`，stage 自行判断
- 创建 webhook token 撞库：DB UNIQUE 兜底 + service 层 catch 后重生成（防御性；32 字节熵下生日碰撞概率可忽略）
- rotate 期间旧 token 请求：rotate 一次 UPDATE 立即失效，无双 token 灰度窗口；要灰度的人新建第二条 webhook，等上游切完再删旧的

### 7.3 安全

- token 生成：`crypto.randomBytes(32)` → url-safe base64（去 padding，43 字符）
- token 比较：DB UNIQUE 索引（hash index 常数时间）
- 401 永远返回固定字符串
- 请求日志屏蔽 path 末段：`/admin/api/webhooks/pipeline/<redacted>`
- 创建 / rotate / 删除 webhook 需 session 登录（沿用现有 admin auth）
- v1 不做 RBAC——能登后台即能管所有 pipeline webhook，与现有 admin 风格一致

## 8 · 前端

pipeline 详情页加「Webhook 触发器」Tab（Card），位于「基本信息 / 节点画布 / 执行历史 / 变量」相邻处。

列表列：
- name
- token 前 8 字符 + 省略号
- enabled 开关
- 最近触发时间
- 累计触发次数
- 操作（rotate / 删除）

交互：
- 新建 / rotate 后弹模态框显示完整 URL，提供「复制」按钮 + 「我已保存」确认才能关闭
- `defaultServers` 编辑复用现有 `ServerAssignmentEditor`（与手动运行一致）
- 列表上方放一个「测试」按钮，弹出 curl 模板：
  ```
  curl -X POST <url> \
    -H 'Content-Type: application/json' \
    -d '{"hello": "world"}'
  ```

## 9 · 测试策略

### 9.1 单元测试

| 文件 | 覆盖 |
|------|------|
| `src/__tests__/unit/webhook-token.test.ts` | token 生成长度/字符集/url-safe；撞库重试 |
| `src/__tests__/unit/webhook-payload-parsing.test.ts` | `_servers` 拆分 + 优先级三层回退 |
| `src/__tests__/unit/webhook-rate-limit.test.ts` | 60/min sliding window 边界 + Retry-After |
| `src/__tests__/unit/variables-trigger-params.test.ts` | script 节点 `{{triggerParams.x.y[0].z}}` |

### 9.2 集成测试（Fastify inject + DB）

| 文件 | 覆盖 |
|------|------|
| `src/__tests__/integration/webhook-create.test.ts` | CRUD + token 仅 create / rotate 返回完整值；列表只回前 8 字符 |
| `src/__tests__/integration/webhook-trigger.test.ts` | happy path：POST → 202 + runId → run 跑完 → triggerParams 落 test_runs |
| `src/__tests__/integration/webhook-error-table.test.ts` | §7.1 每一行：400/401/404/413/429 + 异步失败的 error_message |
| `src/__tests__/integration/webhook-disabled.test.ts` | webhook 禁用 / pipeline 禁用 各自的响应 + audit 行为 |

### 9.3 端到端

复用 `src/__tests__/level/` fixture，加 `level-webhook.test.ts`：真实 pipeline → POST webhook → 等 run 完成 → 断言报告生成。

### 9.4 不写测试的部分（明确）

- 真实 HTTPS / 反代行为（部署环境相关）
- 多副本限流一致性（v1 故意单进程，§6.5 已声明）
- 长压测 / 性能基准（v1 不做）

### 9.5 手工冒烟

新增 `docs/smoke-webhook-trigger.md`：
1. 管理页创建 webhook，复制 URL
2. `curl -X POST -d '{"foo":"bar"}'` 触发
3. test-runs 列表看到新 run，`triggered_by` 显示 `webhook:N:name`
4. run 详情看 `trigger_params` 完整
5. rotate token 后旧 URL 立刻 401
6. `enabled=false` 后 URL 401
7. 删除后 URL 401

## 10 · 实现阶段（粗粒度）

| 阶段 | 内容 |
|------|------|
| 1 | schema-v46 + repository (`src/db/repositories/pipeline-webhooks.ts`) |
| 2 | 管理路由 `pipeline-webhooks.ts`（CRUD + rotate） |
| 3 | 公开路由 `webhooks.ts`（解析 token、限流、调 runPipeline） |
| 4 | `VariableContext` 加 `triggerParams`，graph-runner 传值，script 节点测试 |
| 5 | 前端「Webhook 触发器」Tab + 全部交互 |
| 6 | 集成测试 + 冒烟手册 |

阶段间无强依赖（除了 1 是其他的前置），可以子代理并行。

## 11 · 已明确不在本期范围

- HMAC 签名（仅 token）
- 多副本一致限流
- per-pipeline RBAC
- 内置幂等去重（payload 自带 idempotencyKey + stage 判断）
- payload schema 校验
- IP 白名单 / 地理围栏
- per-token 限流配置
- 双 token 灰度窗口（用多 webhook 行替代）
- 独立 audit_events 表（依靠 test_runs 自身留痕 + Fastify 请求日志）

未来若要加任何一项，对应 ALTER TABLE / 新表即可，不需要重构。
