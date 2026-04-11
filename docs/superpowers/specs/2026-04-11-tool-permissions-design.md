# 工具权限控制 — Design Spec

## Context

当前 9 个 agent 工具的 `requiredRole` 字段仅是元数据，没有实际强制执行。任何角色的用户都能通过 Claude 调用所有工具（包括 deploy、rollback 等高危操作）。需要在工具注册层实现权限过滤，使 Claude 只能看到用户有权使用的工具。

## 决策记录

| 维度 | 决定 |
|------|------|
| 执行层级 | 工具注册层过滤（Claude 只看到有权工具） |
| 角色来源 | product_line_members 表（按产线） |
| 配置方式 | 代码内置默认 + 数据库可按产线覆盖 |

## 权限模型

角色层级（向上兼容）: `developer < ops < admin`

### 默认工具权限（代码内置）

| 工具 | 默认最低角色 |
|------|-------------|
| query_deployments | developer |
| list_images | developer |
| get_gitlab_commits | developer |
| get_logs | developer |
| execute_deploy | ops |
| execute_rollback | ops |
| execute_restart | ops |
| request_approval | ops |
| manage_role | admin |

## 数据模型

### 新增表 `tool_permissions`

```sql
CREATE TABLE IF NOT EXISTS tool_permissions (
  id               SERIAL PRIMARY KEY,
  product_line_id  INT REFERENCES product_lines(id) ON DELETE CASCADE,
  tool_name        TEXT NOT NULL,
  min_role         TEXT NOT NULL CHECK (min_role IN ('developer','ops','admin')),
  UNIQUE(product_line_id, tool_name)
);
```

- `product_line_id` 为 NULL 表示全局覆盖
- 有记录时覆盖代码默认值
- 无记录时使用工具的 `requiredRole` 默认值

## 执行流程

1. 用户在钉钉群发消息
2. SessionManager 构建 TaskContext，查询 `product_line_members` 获取用户角色
3. ClaudeRunner 调用新的 `getPermittedTools(role, productLineId)` 过滤工具列表
4. Claude 只收到用户有权使用的工具定义
5. 工具执行时不再需要额外检查（源头已过滤）

## 需要修改的文件

- `src/db/schema-v2.sql` — 追加 tool_permissions 表
- `src/db/repositories/tool-permissions.ts` — 新增：CRUD + getEffectivePermissions
- `src/agent/tools/types.ts` — AgentTool.requiredRole 改为必填，增加 DEFAULT_TOOL_ROLES 常量
- `src/agent/tools/index.ts` — 新增 getPermittedTools(role, productLineId) 函数
- `src/agent/claude-runner.ts` — 使用 getPermittedTools 代替 getAllTools
- `src/admin/routes/tool-permissions.ts` — 新增：按产线管理工具权限的 API
- `src/admin/index.ts` — 注册新路由
- `web/src/pages/product-lines/ProductLineDetailPage.tsx` — 添加工具权限 Tab

## 后端 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/tool-permissions?product_line_id=` | 查询权限覆盖列表 |
| PUT | `/admin/tool-permissions` | 批量更新（body: `{ productLineId, permissions: [{toolName, minRole}] }` |
| GET | `/admin/tools` | 获取所有工具及默认权限 |
