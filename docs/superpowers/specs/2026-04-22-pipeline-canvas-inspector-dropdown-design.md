# 画布节点配置面板下拉化与数据流打通 — 设计

- 日期：2026-04-22
- 范围：`web/src/pipeline-canvas/panels/NodeInspector.tsx` 相关 UI + `src/pipeline/` 后端数据流 + `src/pipeline/graph-validation.ts` 校验
- 不动：canvas 渲染、edge 条件、auto-layout、executor 调度路径、schema migration、VariablesPanel 布局

## 背景

当前画布节点配置面板（`NodeInspector.tsx`）存在若干 UX 缺陷：
1. `capability.capabilityKey` 与 `im_input.imInputConfig.capabilityKey` 都是纯文本输入，拼写错误只能等运行时 `capability not found` 报错
2. `targetRoles` 对所有 stageType 统一显示，但仅 `script` 真正消费该字段
3. 切换 `stageType` 不清理旧类型独有字段，导致 graph 沉淀无效数据
4. `capability` 类型没有 `capabilityParams` 的 UI 入口，用户无法从画布传参
5. `capabilityKey`、`webhookTag`、`imInputConfig.prompt` 空值能保存，运行期才报错
6. （数据流缺口）capability 节点的 `resolveCapabilityParams` 只识别 `{{triggerParams.xxx}}`，不识别 `{{vars.xxx}}`，也读不到 `state.runtimeVars`；因此上游 `im_input` / `wait_webhook` 采集到的值无法喂给下游 capability

本设计一次性修复以上 6 点。

## 总体思路

- 前端：在 Inspector 引入基于 `/capabilities` 的下拉选择、paramSchema 驱动的动态表单、stageType 切换的清理确认、保存前必填校验
- 后端：`buildCapabilityNode` 从 state 读 `runtimeVars` 并传入 hook；`resolveCapabilityParams` 新增 `{{vars.xxx}}` 解析；`graph-validation.ts` 新增 stageType 必填校验
- 不引入依赖关系静态追溯（方案 B，非 C）—— 运行时缺失变量 fallback 为字面字符串，交由 capability coordinator 处理

## 设计

### 1. 数据加载（前端）

`PipelineCanvasPage.tsx` 初始 `Promise.all` 增加 `getCapabilities()`，结果通过 prop 传给 `NodeInspector`。

传给 Inspector 的字段精简为：

```ts
interface CapabilityOption {
  key: string
  displayName: string
  category: 'query' | 'action' | 'admin' | 'env_prep' | 'verify' | 'testing' | 'result'
  paramSchema: Record<string, unknown>
}
```

Inspector 新增 prop `capabilities: CapabilityOption[]`。

### 2. capabilityKey 下拉

作用于两处：
- `stageType === 'capability'` 的 `capabilityKey`（必填）
- `stageType === 'im_input'` 的 `imInputConfig.capabilityKey`（可选）

实现：`antd Select`，`showSearch`，`filterOption` 按 `displayName` 和 `key` 匹配。

option 视觉（同一行显示）：
- 主标题：`displayName`
- 副标题（小字）：`key`
- 右侧：`<Tag>` 显示 `category`

**stale 兼容**：节点里保存的 `capabilityKey` 不在当前 `capabilities` 列表中时（capability 被删除），不清空值，Select 显示为 `{key}（不在能力列表中）` 并附黄色 warning 图标，允许用户继续保留或选择其它。

### 3. capabilityParams 动态表单

仅当 `stageType === 'capability'` 且 `capabilityKey` 已选中时出现（`capabilities.find(c => c.key === selected)?.paramSchema`）。

**渲染规则**：

| JSON Schema type | 控件 |
|---|---|
| `string`（无 `enum`） | `Input`，placeholder 用 `property.description` |
| `string`（有 `enum`） | `Select` options = enum |
| `number` / `integer` | `InputNumber`（min/max 用 `minimum` / `maximum`） |
| `boolean` | `Switch` |
| 数组 / 对象 / 其它 | 单独 `Input.TextArea` 接受 JSON，onBlur 解析 |
| 整个 schema 非 object | 整体 fallback：monospace JSON TextArea（同 im_input.paramSchema 当前体验） |

**其它规则**：
- `required` 字段加星号 + `rules: [{ required: true }]`
- 所有 string 字段允许 `{{vars.xxx}}` 和 `{{triggerParams.xxx}}` 模板，字段下方小灰字提示："支持 {{vars.xxx}}（im_input / webhook 采集的值）、{{triggerParams.xxx}}（触发参数）"
- Label 用 `property.title ?? propertyKey`
- 数据写入 `StageFields.capabilityParams`（类型已有）
- **切换 capability 时**：如果旧 `capabilityParams` 的字段在新 schema 里不存在，静默丢弃；保留重叠字段的值

### 4. 后端数据流打通（核心）

**改动文件**：`src/pipeline/graph-builder.ts`、`src/pipeline/executor-hooks.ts`

#### 4.1 `buildCapabilityNode` 从 state 读 runtimeVars

现状签名：`return async () => {...}`（不接收 state）

改为：`return async (state: typeof PipelineStateAnnotation.State) => {...}`（与 `buildImInputNode` 一致）

从 `state.runtimeVars` 取值，透传给 `hooks.runCapability`。

#### 4.2 `StageHooks.runCapability` 签名扩展

现状：

```ts
runCapability(
  stage: StageDefinition,
  ctx: StageContext,
  triggerParams?: Record<string, unknown>,
): Promise<StageExecutionResult>
```

改为：

```ts
runCapability(
  stage: StageDefinition,
  ctx: StageContext,
  triggerParams?: Record<string, unknown>,
  runtimeVars?: Record<string, unknown>,
): Promise<StageExecutionResult>
```

`runtimeVars` 可选，缺省 `undefined`。所有现有调用点（测试、executor）保持传 `undefined` 的向后兼容。

#### 4.3 `resolveCapabilityParams` 扩展

现状（`executor-hooks.ts:24`）：只识别整值 `{{triggerParams.xxx}}` 模式。

改为：

```ts
function resolveCapabilityParams(
  params: Record<string, unknown> | undefined,
  triggerParams: Record<string, unknown> | undefined,
  runtimeVars: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined
```

对每个 string 值，按顺序匹配：
1. `^\{\{triggerParams\.(\w+)\}\}$` → 从 `triggerParams` 取整值（保留类型）
2. `^\{\{vars\.(\w+)\}\}$` → 从 `runtimeVars` 取整值（保留类型）
3. 内嵌模板（如 `"branch=${{vars.x}}"`）—— 第一版**不支持**，保持字面字符串原样透传（后续如有需要再扩）
4. 无匹配 → 保留字面值

**关键约束**：整值替换时保留原类型（`number` / `boolean` / `object` / `array`），不强转字符串，与 webhook payload、im_input 采集值的类型语义一致。

#### 4.4 约定对齐文档

在 `src/pipeline/variables.ts` 头部或 `docs/` 新增一段：

> `{{vars.xxx}}` 在 script 与 capability 两处语义统一：读取 `state.runtimeVars`（由 im_input / wait_webhook 节点写入）与 `pipeline.variables`（流水线配置的自定义变量）的合并值。

#### 4.5 设计决策：为什么保留单一 `runtimeVars` 袋（非 LangGraph 标准做法）

LangGraph 官方推荐将 state 按业务语义拆分为多个命名 channel（`messages` / `searchResults` / `validationStatus` 等），每个 channel 有独立类型和 reducer。本项目 `graph-state.ts` 里的 `runtimeVars: Record<string, unknown>`（shallow-merge）是一个万能袋，im_input / wait_webhook 都向同一 keyspace 写入，**不符合 LangGraph 官方推荐模式**。

明知偏离标准仍保留，是出于产品侧的一致性权衡：

- 用户在画布上、在 `pipeline.variables` 配置里、在 script 模板里统一使用 `{{vars.xxx}}`，单一袋让心智模型保持一致
- 现有 checkpoint 数据都基于此模型，重构需要兼容层
- 本次修复的范围聚焦于"打通 capability 节点的读取路径"，规范化是独立重构话题

已知不足（后续若演进可参考）：

1. **命名冲突**：im_input 采集的 `branch` 与 webhook payload 里的 `branch` 会相互覆盖
2. **内部 state 与业务 vars 混杂**：`__im_input_collected_<index>` 这类内部 key 与业务 vars 同袋（见 `graph-builder.ts:354`），用 `__` 前缀避开但不彻底
3. **模板来源不透明**：`{{vars.x}}` 可能来自 pipeline.variables / im_input / webhook，用户在画布上无法判断

这些不在本 spec 的修复目标内。如果未来命名冲突或来源歧义成为实际痛点，再按"拆 namespace / 拆 channel"做独立重构。

### 5. 其它 UX 修复

#### 5.1 targetRoles 条件显示

只在 `stageType === 'script'` 时渲染 `targetRoles` Form.Item。切换时不清理该字段值（保留给用户误切后回来）。

#### 5.2 stageType 切换弹框确认

在 `stageType` Select 的 `onChange` 拦截。

若旧 stageType 有**已填且不属于新 stageType** 的字段（任一：非空 `script` / 非空 `approverIds` / 非空 `capabilityKey` / 非空 `webhookTag` / 非空 `imInputConfig` / 非空 `capabilityParams`），弹 `Modal.confirm`：

> 切换后将清空下列字段：{列出非空字段}。确认继续？

确认：调新的 `pruneStageFields(data, newType)` 纯函数，把旧独有字段置 `undefined`，并按新类型注入默认值（与 `defaultStageFields` 一致）。

取消：Form 值回滚到原 stageType。

#### 5.3 前端必填校验

- Form 层：每个 stageType 对应的关键字段加 `rules: [{ required: true }]`
  - `name`（已有）
  - `capability.capabilityKey`
  - `wait_webhook.webhookTag`
  - `im_input.imInputConfig.prompt`
- `handleSave` 前全图遍历校验必填。有错误时 `message.error` 指向第一个缺失节点的 `name`，并 `setSelectedId` 让 Inspector 打开该节点，不发网络请求。

#### 5.4 后端 graph-validation 同步拦截

在 `validatePipelineGraph` 追加按 stageType 的必填：
- `capability` → `capabilityKey` 非空
- `wait_webhook` → `webhookTag` 非空
- `im_input` → `imInputConfig.prompt` 非空且 `imInputConfig.paramSchema` 是 object
- `approval` → `approverIds` 非空数组
- `script` → `script` 允许空（保留占位语义）

错误信息格式：`node <id> (stageType=<t>): <field> is required`。

#### 5.5 Variables 提示文案

`webhookTag`、`imInputConfig.prompt`、capabilityParams 的 string 字段下方加一行小灰字：
> 支持 `{{vars.xxx}}` 模板（见右侧变量面板）

不做交互增强。

## 数据结构

无 schema 变化、无 DB 迁移。

前端新增的 Inspector prop（`capabilities`）是运行时数据，不入库。

## 错误处理

- capabilityKey 下拉 stale：UI 显示 warning，允许保留
- `runtimeVars` 缺失变量：fallback 字面字符串（与 `resolveVariables` 一致）
- 保存时必填缺失：前端 message + 聚焦节点，不发请求；即使前端被绕开，后端也会 400
- stageType 切换取消：Form 回滚，无副作用

## 测试

### 单元测试

- `src/__tests__/unit/graph-validation.test.ts` 扩充：每个 stageType 一组必填用例（空值拒绝、合法值通过）
- 新增 `src/__tests__/unit/capability-variables.test.ts` 或扩充 `pipeline-capability-stage.test.ts`：
  1. `{{vars.branch}}` 在 `runtimeVars.branch` 有值时替换成原值（含 number / bool / object 类型）
  2. `{{vars.x}}` 无值时保留字面 `{{vars.x}}`
  3. `{{triggerParams.xxx}}` 行为不变
  4. end-to-end：构造一个 im_input→capability 最小 graph，im_input 采集 `branch="main"`，capability 入参 `{ref: "{{vars.branch}}"}` → hook 收到 `{ref: "main"}`

### 手工冒烟（`docs/smoke-canvas-inspector.md` 新增）

1. 新建 capability 节点 → 下拉选择 → capabilityParams 自动出现 → 填字面值 → 保存 → 重进画布能看到
2. 新建 capability 节点未选 capabilityKey → 保存被拦（前端 message）
3. 把 capability 的 `capabilityParams.ref` 写成 `{{vars.branch}}`，上游加 im_input 采集 `branch` → 触发 pipeline → coordinator 收到 `ref="main"`（验证 2.5 节 end-to-end）
4. script 节点切到 approval → 弹框确认显示列出"将清空：script" → 确认后旧 script 清空
5. 切换 capability：params 中保留重叠字段、丢弃不在新 schema 的字段
6. 选中被删除的 capability（手造 stale 数据）→ 下拉显示 warning → 保存不被阻塞
7. im_input.capabilityKey 下拉可留空提交

## 提交拆分

建议按 4 个提交：
1. 后端：`resolveCapabilityParams` 扩展 + `buildCapabilityNode` 读 state + `StageHooks` 签名扩展 + 单测
2. 后端：`graph-validation.ts` 必填校验 + 单测
3. 前端：`getCapabilities` 加载 + capabilityKey 下拉 + stale 兼容
4. 前端：capabilityParams 动态表单 + stageType 切换确认 + targetRoles 条件显示 + 必填校验 + 冒烟文档

## 非目标

- 不做 capabilityParams 内嵌模板（`"foo-${{vars.x}}"`）
- 不做依赖关系静态追溯（方案 C）
- 不做 capability / script 节点的 output 结构化写回 runtimeVars
- 不重构 im_input paramSchema 的 JSON TextArea（独立话题）
- 不改 webhookTag 输入形态（tag 本身是动态模板，下拉列表不适合）
