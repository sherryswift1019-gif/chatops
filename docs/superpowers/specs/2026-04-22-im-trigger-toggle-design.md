# 产线内能力 IM 触发开关

- **日期**：2026-04-22
- **作用域**：产线级（`product_line_capabilities`）
- **目的**：支持在产线内单独启用/禁用某能力的 IM 群聊触发通道，实现"能力在产线启用但不允许通过钉钉/飞书群聊调用"的场景

## 背景

ChatOps 当前的 capability 权限模型由 `product_line_capabilities` 表承载三个维度：`enabled`（产线内是否启用）、`allowed_roles`（可执行的用户角色）、`env_name`（环境粒度，当前多数场景用通配 `*`）。

运行时入口：

- **IM 触发**：`src/agent/coordinator.ts:triggerCapability()` 是 IM 消息触发 capability 的入口。目前**未调用** `checkCapabilityAccess()`，意味着产线内 `enabled`/`allowed_roles` 的配置仅在前端编辑时生效，IM 运行时无强校验。
- **Web 手动触发**：当前管理后台**没有**直接"手动执行 capability"的入口（仅有 `POST /admin/test-runs` 测试运行整个 pipeline）。E2E 测试入口 `/_e2e/trigger-capability` 存在但不带产线上下文。

需求：某些敏感/破坏性能力希望仅允许在 Web 管理后台、定时调度等受控通道执行，**禁止通过群聊对话**直接触发。现有字段无法表达该语义。

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

### 2. Coordinator: `src/agent/coordinator.ts:triggerCapability()`

- 在进入 pipeline（`runPipeline`）或旧 handler 分支**之前**：
  - 用 `context.initiatorId` 调用已有的 `resolveProductLineId(userId)` 得到 `productLineId`
  - 调 `checkCapabilityAccess(productLineId, capabilityKey, envName, initiatorRole, 'im')`
  - 拒绝时：
    - 通过 IM 适配层回复 `能力 {displayName} 在当前产线已禁止通过 IM 触发，请到管理后台执行。`
    - 记 audit log（沿用现有审计机制）
    - 不执行 pipeline，函数直接返回
- 若用户无产线归属（`resolveProductLineId` 返回空）：跳过 `trigger_sources` 检查，按现有路径继续执行（不引入新阻塞，保持零回归）

### 3. Admin API: `src/admin/routes/capabilities.ts`

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

2. **`coordinator.triggerCapability()` IM 拦截**（新增测试或扩展 `coordinator.test.ts`）：
   - 模拟 `trigger_sources=['web']` 的能力被 IM 触发 → 不进入 pipeline 路径，不调 `runPipeline`
   - 断言 IM 回复（通过 mock IM notifier / adapter）

3. **Repository 的 batch set**：
   - 写入+读取 roundtrip 包含 `triggerSources`

### 手工验证

- 创建测试能力，默认打开 IM 开关 → 群聊触发成功
- 关闭 IM 开关 → 群聊触发 → 收到拒绝回复，不启动 pipeline
- 重新打开 → 恢复可触发

## 非目标（v1 不做）

- **环境级细分**：`trigger_sources` 当前仅以产线 + `env_name='*'` 粒度配置；按 env 分别配置 IM 开关推迟到后续迭代
- **Web 手动触发能力**：字段中 `"web"` 枚举保留，但 v1 没有具体执行入口调 `checkCapabilityAccess(source='web')`
- **定时/Webhook 触发源**：同上，预留枚举但不实现
- **群→产线显式绑定**：继续沿用 `resolveProductLineId(userId)` 根据发言用户的产线成员关系解析

## 回滚策略

- 迁移字段 `NOT NULL DEFAULT '["im","web"]'::jsonb`，无需数据回填
- 代码回滚：若前端/后端一方先回滚，另一方对未知字段容忍（前端 `triggerSources` 为 undefined 时走默认，后端忽略未知请求字段）
- schema 回滚：直接 `ALTER TABLE product_line_capabilities DROP COLUMN trigger_sources;`（幂等迁移脚本原则与现有 schema-vN.sql 一致）
