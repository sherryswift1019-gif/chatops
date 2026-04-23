# 产线内能力 IM 触发开关

- **日期**：2026-04-22
- **作用域**：产线级（`product_line_capabilities`）
- **目的**：支持在产线内单独启用/禁用某能力的 IM 群聊触发通道，实现"能力在产线启用但不允许通过钉钉/飞书群聊调用"的场景

## 背景

ChatOps 当前的 capability 权限模型由 `product_line_capabilities` 表承载三个维度：`enabled`（产线内是否启用）、`allowed_roles`（可执行的用户角色）、`env_name`（环境粒度，当前多数场景用通配 `*`）。

运行时入口：

- **IM 触发（执行）**：`src/agent/claude-runner.ts:ClaudeRunner.run()` 已在 `Step 4b`（第 ~309-319 行）调用 `checkCapabilityAccess(productLineId, capability.key, envName, userRole)` 做 `enabled` + `allowedRoles` 校验。但调用处**未携带触发源参数**，所以无法区分 IM 与其他通道。
- **IM 查询能力列表**：当用户在群里问"help"/"支持哪些能力"，`detectIntent()` 识别为 `capability='greet'`，走 `ClaudeRunner.sendGreeting()`（~第 471-498 行）→ `listCapabilities()` 全量返回，不做任何产线或来源过滤。
- **Web 手动触发**：当前管理后台**没有**直接"手动执行 capability"的入口（仅有 `POST /admin/test-runs` 测试运行整个 pipeline）。E2E 测试入口 `/_e2e/trigger-capability` 存在但不带产线上下文。
- **Coordinator**：`src/agent/coordinator.ts:triggerCapability()` 是 claude-runner 之后的进一步分派（对某些 HANDLER_CAPABILITIES），不再重复做访问控制；因此 IM 拦截应统一落在 claude-runner 层。

需求：
1. 某些敏感/破坏性能力希望仅允许在 Web 管理后台、定时调度等受控通道执行，**禁止通过群聊对话**直接触发。
2. 当用户在 IM 群里查询"支持哪些能力"时，已禁止 IM 触发的能力**不应出现在清单里**。

现有字段无法表达该语义。

## 数据模型变更

### schema-v22.sql（新增迁移文件）

```sql
ALTER TABLE product_line_capabilities
  ADD COLUMN IF NOT EXISTS trigger_sources JSONB NOT NULL DEFAULT '["im","web"]'::jsonb;
```

### 语义

- **白名单**：只有列在 `trigger_sources` 数组中的来源才允许触发该能力。
- **枚举值**：
  - `"im"` — IM 群聊对话触发
  - `"web"` — Web 管理后台手动触发（v1 字段保留，当前无执行路径）
- **默认值 `["im","web"]`** — 向后兼容，迁移后现有数据等价于"全部触发源允许"。
- **未来扩展**：`"schedule"`（定时调度）、`"webhook"`（外部 Webhook）等后续追加，无需 schema 变更。

## 后端改动

### 1. Repository: `src/db/repositories/product-line-capabilities.ts`

- `ProductLineCapability` 类型新增字段：`triggerSources: string[]`
- `mapRow()` 解析 `trigger_sources` 列（JSONB → string[]）；默认值缺失时补 `['im','web']`
- `checkCapabilityAccess()` 签名扩展增加参数 `source: 'im' | 'web'`
  - 在现有 `enabled` + `allowedRoles` 校验之后，追加一层：`!triggerSources.includes(source)` → 返回 `{ allowed: false, reason: 'source-blocked' }`
- `batchSetProductLineCapabilities()` 入参接受 `triggerSources`

### 2. Claude Runner: `src/agent/claude-runner.ts`

#### 2.1 IM 触发拦截（Step 4b）

在现有的 `checkCapabilityAccess(productLineId, capability.key, envName, userRole)` 调用处（~第 311 行）：

- 改为 `checkCapabilityAccess(productLineId, capability.key, envName, userRole, 'im')`
- 被拒绝时，若 `access.reason === 'source-blocked'`（新增原因码），回复专用文案：`⛔ 能力「{displayName}」在当前产线已禁止通过 IM 触发，请到管理后台执行。` 与现有"权限不足"区分开，便于用户理解。
- 其他 reason 保持现有文案。

#### 2.2 能力列表过滤（`sendGreeting`）

`sendGreeting(adapter, groupId, atIds)` 签名扩展为 `sendGreeting(adapter, groupId, atIds, productLineId?: number)`，调用方（第 265、283 行）传入外层已解构的 `productLineId`。

函数体内：

- `const all = await listCapabilities()`
- 若 `productLineId` 存在：逐条调 `checkCapabilityAccess(productLineId, cap.key, '*', userRole ?? 'developer', 'im')`，仅保留 allowed 的条目
- 若 `productLineId` 为空（用户无产线归属）：沿用现行"只能用查询类能力"的提示逻辑（当前是列全部能力；可在此同步做 `category === 'query'` 过滤，但**非本 spec 范围**，如需一并做需在"非目标"中移除）
- 渲染 Markdown 列表时按过滤后的集合渲染
- 无任何可用能力时显示："你当前在本产线下没有可通过 IM 触发的能力，请联系管理员或到管理后台查看。"

### 3. Coordinator: `src/agent/coordinator.ts`

本 spec **不** 修改 `coordinator.triggerCapability()`。IM 拦截统一在 claude-runner 层，coordinator 作为下游分派无需重复校验。未来若新增其他调用 `triggerCapability` 的入口（例如定时、Webhook），再补充 source 参数。

### 4. Admin API: `src/admin/routes/capabilities.ts`

- `GET /product-lines/:id/capabilities` 响应体的每条能力记录增加 `triggerSources: string[]`
- `PUT /product-lines/:id/capabilities` 请求体 schema 新增可选字段 `triggerSources`；未传时保持原值不变

## 前端改动

### `web/src/pages/ProductLineDetailPage.tsx`

能力管理标签页（系统能力/流水线能力两类表格）：

- 在每个能力条目现有的 `enabled` Switch + 角色 CheckboxGroup 之外，新增一个 Switch「允许 IM 触发」（默认打开）
- Tooltip 文案：关闭后该能力在本产线下不能通过钉钉/飞书群聊触发，仍可通过管理后台执行
- **状态映射**：
  - Switch on → `triggerSources = ['im','web']`
  - Switch off → `triggerSources = ['web']`
- **读取**：Switch 值 = `triggerSources.includes('im')`
- 保存时随其他字段一起提交到 `PUT /product-lines/:id/capabilities`

### 前端类型

`web/src/api/` 下对应 `ProductLineCapability` TS 类型补 `triggerSources?: string[]`

## 测试

### 单元测试

1. **`checkCapabilityAccess()` 新路径**（`src/__tests__/unit/product-line-capabilities.test.ts` 或同类文件）：
   - `trigger_sources=['im','web']` + `source='im'` → allowed
   - `trigger_sources=['web']` + `source='im'` → blocked，reason=`'source-blocked'`
   - `trigger_sources` 字段缺失（旧数据）→ 默认 `['im','web']` → allowed
   - 校验优先级顺序（从高到低）：`enabled=false` → 直接拒绝；否则 `allowedRoles` 不匹配 → 拒绝；否则 `trigger_sources` 不含 source → 拒绝；全部通过 → allowed

2. **`claude-runner.run()` IM 拦截路径**（扩展现有 runner 测试或新增）：
   - `trigger_sources=['web']` 的能力被 IM 触发 → 不进入 `triggerCapability`/`executeWithPorygon`，收到专用"已禁止 IM 触发"回复
   - `trigger_sources=['im','web']`（默认）→ 走现有路径，无回归

3. **`sendGreeting()` 能力列表过滤**：
   - 用户在产线 PL1 里发 `help`，PL1 有能力 A（`trigger_sources=['im','web']`）和能力 B（`['web']`）→ Markdown 列表只含 A
   - 用户无产线归属 → 列全部能力（保持现行行为）

4. **Repository 的 batch set**：
   - 写入+读取 roundtrip 包含 `triggerSources`

### 手工验证

- 创建测试能力，默认打开 IM 开关 → 群聊触发成功、群聊 `help` 列表含该能力
- 关闭 IM 开关 → 群聊触发 → 收到专用拒绝回复，不启动 pipeline；群聊 `help` 列表不含该能力
- 重新打开 → 恢复可触发 + 出现在 `help` 列表

## 非目标（v1 不做）

- **环境级细分**：`trigger_sources` 当前仅以产线 + `env_name='*'` 粒度配置；按 env 分别配置 IM 开关推迟到后续迭代
- **Web 手动触发能力**：字段中 `"web"` 枚举保留，但 v1 没有具体执行入口调 `checkCapabilityAccess(source='web')`
- **定时/Webhook 触发源**：同上，预留枚举但不实现
- **群→产线显式绑定**：继续沿用 `resolveProductLineId(userId)` 根据发言用户的产线成员关系解析

## 回滚策略

- 迁移字段 `NOT NULL DEFAULT '["im","web"]'::jsonb`，无需数据回填
- 代码回滚：若前端/后端一方先回滚，另一方对未知字段容忍（前端 `triggerSources` 为 undefined 时走默认，后端忽略未知请求字段）
- schema 回滚：直接 `ALTER TABLE product_line_capabilities DROP COLUMN trigger_sources;`（幂等迁移脚本原则与现有 schema-vN.sql 一致）
