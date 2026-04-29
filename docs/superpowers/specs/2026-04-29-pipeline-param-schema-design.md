# Pipeline 触发参数统一采集设计

**日期：** 2026-04-29  
**状态：** 已批准

## 背景与问题

现有 `im_input` 节点类型将"参数声明"与"IM 采集渠道"耦合在一起，作为流水线图的一个节点通过 LangGraph interrupt/resume 实现。这导致：

1. **Webhook / Schedule / Manual 触发时逻辑错误**：im_input 节点调用 `interrupt()`，但 `platform`/`groupId` 为空，无法发送 IM 提示，流水线挂起直至超时。
2. **语义混乱**：节点名暗示只能 IM 触发，但参数声明本应与触发渠道无关。
3. **Schedule 功能残缺**：`test_pipelines.schedule` 列存在但未被任何调度器读取。

## 目标

- 删除 `im_input` 节点类型
- 将 `paramSchema` 提升到 pipeline 定义层
- 四种触发方式各自在调用 `runPipeline` 之前完成参数采集/校验
- 新建 `pipeline_schedules` 表支持每条 pipeline 多条定时规则，各带独立预设参数

## 数据层变更

### `test_pipelines` 新增列

```sql
ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS param_schema JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS im_prompt    TEXT  DEFAULT NULL;
```

- `param_schema`：标准 JSON Schema（`properties` + `required`），`NULL` 表示该流水线无需参数采集
- `im_prompt`：可选自定义 IM 引导语。`NULL` 时 `im-param-collector` 根据 `param_schema` 自动生成（列举字段名、枚举值等）

### 新增 `pipeline_schedules` 表

```sql
CREATE TABLE pipeline_schedules (
  id            SERIAL PRIMARY KEY,
  pipeline_id   INT  NOT NULL REFERENCES test_pipelines(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  cron_expr     TEXT NOT NULL,
  preset_params JSONB NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON pipeline_schedules(pipeline_id);
```

`preset_params` 必须满足对应 pipeline 的 `param_schema`（在写入时校验）。

### 废弃字段

- `test_pipelines.schedule`：保留列但不再读写（历史数据留存）
- `StageDefinition.stageType` 中的 `'im_input'`：从 TS 类型联合中移除
- `StageDefinition.imInputConfig`：字段删除
- `pipeline_node_types` 表中 `im_input` 记录：标记为 deprecated 或直接删除

## 后端架构

### 整体数据流

```
IM 消息   → Agent → coordinator → im-param-collector（多轮采集）→ runPipeline（参数已就绪）
Webhook   → entry 校验 params ─────────────────────────────────→ runPipeline
Schedule  → scheduler 读 preset_params ────────────────────────→ runPipeline
Manual    → 前端弹窗收参，API 校验 ─────────────────────────────→ runPipeline
```

### 新模块：`src/pipeline/im-param-collector.ts`

```typescript
export async function collectImParams(
  platform: string,
  groupId: string,
  userId: string,
  paramSchema: Record<string, unknown>,
  imPrompt?: string,
): Promise<Record<string, unknown>>
```

内部流程：
1. 生成引导语（优先 `imPrompt`，否则从 `paramSchema.properties` 自动生成）
2. `notifyImGroup(platform, groupId, prompt)`
3. 注册 `ParamCollectWaiter`（见下）
4. 等待用户 IM 回复（Promise）
5. 调用 `consultImInputAgent`（复用现有逻辑）解析参数
6. 参数不全 → 追问 → 继续等待
7. 参数齐全 → resolve 返回 `collectedParams`
8. 超时（固定 300s）→ reject

### `src/pipeline/im-router.ts` 扩展

新增 `ParamCollectWaiter` 类型与现有 `ImWaiter`（graph interrupt）平行：

```typescript
type WaiterKind = 'graph_interrupt' | 'param_collect'

interface ParamCollectWaiter {
  kind: 'param_collect'
  platform: string
  groupId: string
  resolve: (message: string) => void
}
```

`SessionManager.handleMessage` 路由优先级：
1. `findParamCollectWaiter(platform, groupId)` 命中 → 转发给 im-param-collector
2. 无 waiter → 进 Agent 队列

（原 `findImInputWaiter` graph resume 路径随 `im_input` 节点一并删除）

### `src/pipeline/executor.ts` 前置校验

新增辅助函数：

```typescript
function validateTriggerParams(
  paramSchema: Record<string, unknown> | null,
  params: Record<string, unknown>,
): { valid: boolean; missingFields: string[] }
```

`runPipeline` 入口逻辑：
- `paramSchema` 为 null → 跳过校验
- `type === 'im'` → 参数已由 `im-param-collector` 收齐，直接校验（理论上不会失败）
- `type === 'api'` → 校验失败时 throw，调用方（webhook-router）捕获返回 400
- `type === 'scheduled'` → 校验失败时 throw，scheduler 记录错误日志
- `type === 'manual'` → 校验失败时 throw，调用方返回 400

### 新文件：`src/pipeline/scheduler.ts`

- 进程启动时由 `server.ts` 调用 `startPipelineScheduler()`
- 读取所有 `enabled=true` 的 `pipeline_schedules`，按 `cron_expr` 用 `node-cron` 注册
- 定时触发：`runPipeline(pipelineId, {}, scheduledTrigger({ triggeredBy: 'scheduler', params: preset_params }))`
- Schedule API 写入/删除/toggle 后主动调用 `reloadSchedules()`，重新注册所有定时任务

### Admin API 新增端点

```
GET    /admin/pipelines/:id/schedules          列出该 pipeline 的所有定时规则
POST   /admin/pipelines/:id/schedules          新增规则（校验 preset_params 满足 param_schema）
PUT    /admin/pipelines/:id/schedules/:sid     修改规则
DELETE /admin/pipelines/:id/schedules/:sid     删除规则
PATCH  /admin/pipelines/:id/schedules/:sid/toggle  启停
```

`PATCH /admin/pipelines/:id`：新增 `paramSchema`、`imPrompt` 字段的读写。

## 前端变更

### 画布 `PipelineSettingsPanel.tsx`：新增「触发参数」Tab

- JSON Schema 编辑器（复用现有 `imInputConfig.paramSchema` 的 UI）
- IM 引导语文本框（可选，placeholder 实时预览自动生成效果）

### 手动触发 Modal（改造现有 `DryRunStartModal`）

- 读取 `pipeline.param_schema`
- `param_schema` 为 null → 跳过参数步骤，直接触发
- 非 null → 根据 schema 动态渲染 Ant Design Form：
  - `string` → Input
  - `enum` → Select
  - `boolean` → Switch
  - `number` → InputNumber
- 校验通过后将 `params` 传入 `triggerTestRun`

### Schedule 管理（新 Tab 在 PipelineSettingsPanel 内）

- 展示 `pipeline_schedules` 列表
- 每条规则：名称 / Cron 表达式 / 预设参数表单（按 `param_schema` 渲染）/ 启用开关
- 增删改操作调对应 Admin API

### 移除

| 位置 | 内容 |
|------|------|
| `PipelineCanvasPage.tsx` | `im_input` 节点创建逻辑 |
| `types.ts` | `'im_input'` StageType、`ImInputConfig` 接口 |
| `NodeInspector.tsx` | `im_input` 配置面板分支 |
| `graph-validation.ts` | `im_input` 校验分支 |
| `pruneStageFields.ts` | `im_input` case |
| 节点类型选择器 | `im_input` 选项 |

## 后端删除清单

| 文件 / 位置 | 处理 |
|------------|------|
| `src/pipeline/im-input-agent.ts` | 整体迁移逻辑到 `im-param-collector.ts` 后删除 |
| `graph-builder.ts:buildImInputNode` | 删除 |
| `graph-builder.ts:buildImInputDryRunNode` | 删除（dry-run 直接从 `triggerParams` 读，无需专用节点） |
| `graph-builder.ts` case `'im_input'` | 删除 |
| `graph-runner.ts` `IM_INPUT_INTERRUPT` 分支 | 删除 |
| `graph-builder.ts` `IM_INPUT_INTERRUPT` 常量及相关类型 | 删除 |
| `types.ts` `ImInputConfig` / `'im_input'` | 删除 |
| `src/pipeline/im-router.ts` 现有 `ImWaiter` | 重构为支持 `graph_interrupt` 和 `param_collect` 两种类型 |

## Dry-Run 处理

Dry-run 流程中，`im_input` 节点消失后不再需要 `buildImInputDryRunNode`。Dry-run 启动时，`DryRunStartModal` 已经要求用户填写触发参数（通过 `param_schema` 渲染的表单），这些参数作为 `triggerParams` 传入，后续节点中 `{{triggerParams.xxx}}` 插值正常工作，无需特殊处理。

## 错误处理

| 场景 | 行为 |
|------|------|
| Webhook payload 缺少必填参数 | 400 + 列出缺少的字段名 |
| Schedule preset_params 不满足 schema | 保存时 400 拒绝；调度时跳过并记录 error 日志 |
| IM 采集超时（300s）| 回复超时提示到群，pipeline 不启动 |
| IM 采集用户取消 | 回复取消确认到群，pipeline 不启动 |
| Manual 前端校验失败 | 表单 inline 报错，不提交 |

## 测试要点

- `validateTriggerParams`：unit test，覆盖 required 缺失、enum 不匹配、null schema 跳过
- `im-param-collector`：mock `notifyImGroup` 和 `consultImInputAgent`，验证多轮追问和超时逻辑
- `scheduler.ts`：mock `node-cron`，验证 preset_params 被正确透传
- webhook-router：集成测试，payload 缺字段返回 400
- 画布手动触发 Modal：schema 渲染正确，校验通过后参数透传
