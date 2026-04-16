# 查看产线模块 Capability 设计

> 新增能力：用户在 IM 群里可以让机器人介绍当前产线下的所有业务模块。

## 背景

ChatOps 当前支持 9 个能力（查看部署/日志/提交、部署、回滚、重启等），但缺少一个让团队成员快速了解「我所在产线下有哪些模块、各属谁维护」的入口。信息本来就在 `projects` 表里（三条数据：ssh-proxy / rdp-proxy / WebTerminal），只需要一个查询能力把它暴露到群聊。

## 目标

- 用户在群里自然语言发问（如「有哪些模块」「介绍一下 PAM 产线的模块」），机器人回复当前产线下所有模块的核心信息
- 与现有 query 类能力同一交互模式，响应快、格式稳定、无需审批

## 非目标

- 不支持跨产线查询（用户只能看自己所在产线的）
- 不支持按模块名进一步追问详情（单轮完成，不建立对话上下文）
- 不改动 projects 数据模型或 admin 后台

## 架构概要

沿用现有 capability → tool 链路：

```
用户消息 → DingTalk 适配器 → ClaudeRunner.detectIntent
        → 命中 capability "list_projects" → 调用 tool "list_product_line_projects"
        → 查 DB projects 表 WHERE product_line_id = context.productLineId
        → 格式化 markdown 字符串 → adapter.sendMessage
```

产线来源：`ClaudeRunner` 已经通过 `resolveProductLineId(userId)` 把产线 ID 注入到 `TaskContext`，tool 直接从 context 读，无需解析自然语言参数。

## 改动清单

### 新增文件

**`src/agent/tools/list-projects.ts`** — Tool 实现

- `name: 'list_product_line_projects'`
- `description` 英文（供 Claude intent 识别）：`List all business modules (projects) under the user's current product line, including owner, GitLab path, and Harbor project.`
- `riskLevel: 'low'`
- `inputSchema`：空对象（无参数）
- `execute(ctx)`：
  1. 若 `ctx.productLineId` 缺失 → `{ success: true, output: '你还没绑定产线，请联系管理员添加你到产线。' }`
  2. 调用 `listProductLines()` 拿到产线 display_name；调用 `listProjects(ctx.productLineId)` 拿模块列表
  3. 若模块为空 → `{ success: true, output: '当前产线「{display_name}」下还没有配置模块。' }`
  4. 否则格式化为 markdown 返回

**`src/db/schema-v8.sql`** — Migration

```sql
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval, is_system)
VALUES (
  'list_projects',
  '查看产线模块',
  '列出当前产线下的所有业务模块及其负责人、GitLab 路径、Harbor 项目',
  'query',
  '["list_product_line_projects"]',
  false,
  true
) ON CONFLICT (key) DO NOTHING;

UPDATE capabilities SET
  default_system_prompt = E'你是一个 DevOps 助手。用户通过群聊与你交互。\n只使用提供给你的 MCP 工具。\n直接调用 list_product_line_projects 返回模块列表，不要添加额外解释。',
  system_prompt = default_system_prompt
WHERE key = 'list_projects' AND system_prompt IS NULL;
```

### 修改文件

**`src/server.ts`**：工具 import 区追加
```ts
import './agent/tools/list-projects.js'
```

**`src/agent/mcp-server.ts`**：工具 import 区追加同一行（相对路径）

**`src/agent/tools/types.ts`**：`DEFAULT_TOOL_ROLES` 追加
```ts
list_product_line_projects: ['developer', 'tester', 'ops', 'admin'],
```

**`src/db/migrate.ts`**：在 `schema-v7.sql` 之后追加执行 `schema-v8.sql`

## 输出格式（钉钉 markdown）

```
## {产线 display_name} · {N} 个模块

**{display_name}** (`{name}`)
👤 {owner_name} · GitLab: `{gitlab_path}` · Harbor: `{harbor_project}`

**{next module}** ...
```

- 模块间用空行分隔（钉钉 markdown 段落分隔）
- 每个模块 2 行：粗体名字 + 内联元数据
- `owner_name` 为空时显示 `未指定负责人`
- `gitlab_path` / `harbor_project` 为空时省略对应字段

## 错误与兜底

| 场景 | 行为 |
|---|---|
| 用户未绑定产线（`ctx.productLineId` 为 null） | 返回友好提示，不抛错 |
| 产线下无模块 | 返回「还没配置模块」提示 |
| DB 查询异常 | 抛错，由现有 ClaudeRunner 错误处理捕获 |

## 权限

- 所有角色可见（`list_product_line_projects: ['developer','tester','ops','admin']`）
- 通过 `DEFAULT_TOOL_ROLES` 维护；capability 层面 `needs_approval=false`

## 测试

**`src/__tests__/unit/list-projects-tool.test.ts`** 覆盖：

1. `ctx.productLineId` 缺失 → 返回未绑定提示
2. 产线存在但无模块 → 返回「还没配置」
3. 有 3 个模块 → 返回 markdown，校验包含模块名/负责人/GitLab/Harbor，模块数量正确
4. `owner_name` 为空 → 显示 `未指定负责人`
5. `gitlab_path` 为空 → 不渲染 GitLab 字段

Mock `listProjects` / `listProductLines`。

## 验收标准

- [ ] 本地 `pnpm test` 通过（新增单测 + 现有回归）
- [ ] `npx tsc --noEmit` 通过
- [ ] 部署到 10.10.1.166 后：
  - [ ] 群聊发「有哪些模块」→ 收到 3 个模块的 markdown 列表
  - [ ] 群聊发「介绍 PAM 产线的模块」→ 同样收到
  - [ ] `docker compose logs chatops | grep list_projects` 能看到 capability 命中记录

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| Claude 把「模块」歧义识别成 pipeline_* | description 明确写「业务模块（project）」，跟流水线区分开 |
| 用户不在任何产线导致空手而归 | 返回明确提示，引导联系管理员 |
| 未来单产线下模块数量膨胀，消息超长 | 目前 PAM 3 条，不急；后续可加分页 / 超过 20 条截断 |
