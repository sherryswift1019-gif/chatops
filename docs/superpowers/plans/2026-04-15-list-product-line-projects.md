# 查看产线模块 Capability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `list_projects` 能力，让用户在 IM 群里能查当前产线下所有模块的负责人/GitLab/Harbor 信息。

**Architecture:** 沿用现有 capability → tool 链路：新增 `AgentTool` 自注册到全局 registry，在 `capabilities` 表插入一条记录把它暴露给 intent 检测器。Tool 执行时从 `TaskContext.productLineId` 拿到当前产线（已由 ClaudeRunner 注入），查 DB 拼 markdown 回群。

**Tech Stack:** TypeScript + Node.js + Fastify + PostgreSQL + Vitest（mock repositories 不走真实 DB）。

---

## File Structure

| 路径 | 动作 | 职责 |
|---|---|---|
| `src/agent/tools/list-projects.ts` | 新增 | Tool 实现 + 自注册，格式化模块列表为 markdown |
| `src/__tests__/unit/list-projects-tool.test.ts` | 新增 | vi.mock 两个 repository，测 tool 5 个分支 |
| `src/db/schema-v8.sql` | 新增 | 向 `capabilities` 插入 `list_projects` 一行 + system_prompt |
| `src/agent/tools/types.ts` | 修改 | `DEFAULT_TOOL_ROLES` 追加一条映射 |
| `src/server.ts` | 修改 | Import 新 tool 文件触发自注册 |
| `src/agent/mcp-server.ts` | 修改 | Import 新 tool 文件触发 MCP 子进程注册 |
| `src/db/migrate.ts` | 修改 | 在序列末尾执行 schema-v8.sql |

---

## Task 1: 写第一批单测（红）

**Files:**
- Create: `src/__tests__/unit/list-projects-tool.test.ts`

- [ ] **Step 1.1: 创建测试文件，写 3 个核心分支（productLineId 缺失 / 无模块 / 成功）**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/repositories/projects-repo.js', () => ({
  listProjects: vi.fn(),
}))
vi.mock('../../db/repositories/product-lines.js', () => ({
  listProductLines: vi.fn(),
}))

import { listProjects } from '../../db/repositories/projects-repo.js'
import { listProductLines } from '../../db/repositories/product-lines.js'
import { listProductLineProjectsTool } from '../../agent/tools/list-projects.js'
import type { TaskContext } from '../../agent/tools/types.js'

const mockListProjects = vi.mocked(listProjects)
const mockListProductLines = vi.mocked(listProductLines)

function ctx(productLineId: number | null): TaskContext {
  return {
    taskId: 't1', groupId: 'g1', platform: 'dingtalk',
    initiatorId: 'u1', initiatorRole: 'developer',
    productLineId: productLineId ?? undefined,
  } as unknown as TaskContext
}

beforeEach(() => {
  mockListProjects.mockReset()
  mockListProductLines.mockReset()
})

describe('list_product_line_projects tool', () => {
  it('returns friendly hint when user has no product line', async () => {
    const res = await listProductLineProjectsTool.execute({}, ctx(null))
    expect(res.success).toBe(true)
    expect(res.output).toContain('还没绑定产线')
    expect(mockListProjects).not.toHaveBeenCalled()
  })

  it('returns "no modules" message when product line has no projects', async () => {
    mockListProductLines.mockResolvedValue([
      { id: 1, name: 'PAM', displayName: 'PAM平台', description: '', createdAt: new Date(), updatedAt: new Date() },
    ])
    mockListProjects.mockResolvedValue([])
    const res = await listProductLineProjectsTool.execute({}, ctx(1))
    expect(res.success).toBe(true)
    expect(res.output).toContain('PAM平台')
    expect(res.output).toContain('还没有配置模块')
  })

  it('renders markdown list when projects exist', async () => {
    mockListProductLines.mockResolvedValue([
      { id: 1, name: 'PAM', displayName: 'PAM平台', description: '', createdAt: new Date(), updatedAt: new Date() },
    ])
    mockListProjects.mockResolvedValue([
      {
        id: 1, productLineId: 1, name: 'ssh-proxy', displayName: 'SSH 代理',
        gitlabPath: 'PAM/c-code/ssh-proxy', harborProject: 'para-pam/ssh-proxy',
        ownerId: 'u001', ownerName: '严益昌',
        dockerContainerName: '', k8sProjectName: '', composePath: '',
        description: 'ssh 代理服务',
        createdAt: new Date(), updatedAt: new Date(),
      },
      {
        id: 2, productLineId: 1, name: 'rdp-proxy', displayName: 'RDP 代理',
        gitlabPath: 'PAM/c-code/rdp-proxy', harborProject: 'para-pam/rdp-proxy',
        ownerId: 'u002', ownerName: '张三',
        dockerContainerName: '', k8sProjectName: '', composePath: '',
        description: '',
        createdAt: new Date(), updatedAt: new Date(),
      },
    ])
    const res = await listProductLineProjectsTool.execute({}, ctx(1))
    expect(res.success).toBe(true)
    expect(res.output).toContain('PAM平台 · 2 个模块')
    expect(res.output).toContain('**SSH 代理** (`ssh-proxy`)')
    expect(res.output).toContain('👤 严益昌')
    expect(res.output).toContain('GitLab: `PAM/c-code/ssh-proxy`')
    expect(res.output).toContain('Harbor: `para-pam/ssh-proxy`')
    expect(res.output).toContain('**RDP 代理** (`rdp-proxy`)')
    expect(res.output).toContain('👤 张三')
  })
})
```

- [ ] **Step 1.2: 运行测试，验证红色（测试失败因为 tool 模块还不存在）**

Run: `npx vitest run src/__tests__/unit/list-projects-tool.test.ts`
Expected: FAIL，错误信息类似 `Cannot find module '../../agent/tools/list-projects.js'` 或 `listProductLineProjectsTool is not defined`

- [ ] **Step 1.3: 暂不 commit**，等 Task 2 让测试变绿后一起提交

---

## Task 2: 最小 tool 实现（绿）

**Files:**
- Create: `src/agent/tools/list-projects.ts`

- [ ] **Step 2.1: 写 tool 骨架，让 3 个单测全绿**

```typescript
import { registerTool } from './index.js'
import { listProjects } from '../../db/repositories/projects-repo.js'
import { listProductLines } from '../../db/repositories/product-lines.js'
import type { AgentTool, TaskContext, ToolResult } from './types.js'

function renderModule(p: {
  name: string; displayName: string; ownerName: string;
  gitlabPath: string; harborProject: string
}): string {
  const parts: string[] = []
  parts.push(`👤 ${p.ownerName || '未指定负责人'}`)
  if (p.gitlabPath) parts.push(`GitLab: \`${p.gitlabPath}\``)
  if (p.harborProject) parts.push(`Harbor: \`${p.harborProject}\``)
  return `**${p.displayName}** (\`${p.name}\`)\n${parts.join(' · ')}`
}

export const listProductLineProjectsTool: AgentTool = {
  name: 'list_product_line_projects',
  description: 'List all business modules (projects) under the user\'s current product line, including owner name, GitLab path, and Harbor project.',
  riskLevel: 'low',
  inputSchema: { type: 'object', properties: {} },
  async execute(_params: unknown, ctx: TaskContext): Promise<ToolResult> {
    const productLineId = (ctx as unknown as { productLineId?: number }).productLineId
    if (!productLineId) {
      return { success: true, output: '你还没绑定产线，请联系管理员添加你到产线。' }
    }

    const [allLines, projects] = await Promise.all([
      listProductLines(),
      listProjects(productLineId),
    ])
    const line = allLines.find(l => l.id === productLineId)
    const lineName = line?.displayName ?? `产线 #${productLineId}`

    if (projects.length === 0) {
      return { success: true, output: `当前产线「${lineName}」下还没有配置模块。` }
    }

    const header = `## ${lineName} · ${projects.length} 个模块`
    const body = projects.map(renderModule).join('\n\n')
    return { success: true, output: `${header}\n\n${body}`, data: projects }
  },
}

registerTool(listProductLineProjectsTool)
```

- [ ] **Step 2.2: 检查 listProductLines 是否存在于 product-lines repository**

Run: `grep -n "export async function listProductLines" src/db/repositories/product-lines.ts`
Expected: 能看到函数导出。若没有，查实际导出名并在 Step 2.1 的 import 中更新（同步调整 test mock 的函数名）。

- [ ] **Step 2.3: 运行测试，确认 3 个都绿**

Run: `npx vitest run src/__tests__/unit/list-projects-tool.test.ts`
Expected: `3 passed`

- [ ] **Step 2.4: 暂不 commit**，进入 Task 3 补边界测试

---

## Task 3: 边界测试 — owner_name 空 / gitlab 空 / harbor 空

**Files:**
- Modify: `src/__tests__/unit/list-projects-tool.test.ts`

- [ ] **Step 3.1: 追加两个测试到 `describe` 块内部末尾**

在 Step 1.1 的 `describe(...)` 块最后一个 `it(...)` 之后追加：

```typescript
  it('shows placeholder when owner_name is empty', async () => {
    mockListProductLines.mockResolvedValue([
      { id: 1, name: 'PAM', displayName: 'PAM平台', description: '', createdAt: new Date(), updatedAt: new Date() },
    ])
    mockListProjects.mockResolvedValue([
      {
        id: 1, productLineId: 1, name: 'orphan', displayName: '孤儿模块',
        gitlabPath: 'PAM/orphan', harborProject: 'para-pam/orphan',
        ownerId: '', ownerName: '',
        dockerContainerName: '', k8sProjectName: '', composePath: '',
        description: '',
        createdAt: new Date(), updatedAt: new Date(),
      },
    ])
    const res = await listProductLineProjectsTool.execute({}, ctx(1))
    expect(res.output).toContain('👤 未指定负责人')
  })

  it('omits GitLab/Harbor fields when empty', async () => {
    mockListProductLines.mockResolvedValue([
      { id: 1, name: 'PAM', displayName: 'PAM平台', description: '', createdAt: new Date(), updatedAt: new Date() },
    ])
    mockListProjects.mockResolvedValue([
      {
        id: 1, productLineId: 1, name: 'legacy', displayName: '遗留模块',
        gitlabPath: '', harborProject: '',
        ownerId: 'u001', ownerName: '老王',
        dockerContainerName: '', k8sProjectName: '', composePath: '',
        description: '',
        createdAt: new Date(), updatedAt: new Date(),
      },
    ])
    const res = await listProductLineProjectsTool.execute({}, ctx(1))
    expect(res.output).toContain('👤 老王')
    expect(res.output).not.toContain('GitLab:')
    expect(res.output).not.toContain('Harbor:')
  })
```

- [ ] **Step 3.2: 跑所有 5 个测试**

Run: `npx vitest run src/__tests__/unit/list-projects-tool.test.ts`
Expected: `5 passed`。Task 2 的 `renderModule` 已经处理了这两种边界（`p.ownerName || '未指定负责人'` 和 `if (p.gitlabPath)` 守卫），应该无需再改代码就能通过。

- [ ] **Step 3.3: 如果 Step 3.2 失败**，打开 `src/agent/tools/list-projects.ts` 中的 `renderModule`，确认两个守卫逻辑生效；修正后重新跑。

---

## Task 4: 注册 tool —— imports + DEFAULT_TOOL_ROLES

**Files:**
- Modify: `src/agent/tools/types.ts:37` (在 `manage_role` 行之后)
- Modify: `src/server.ts:29` (在 `import './agent/tools/autotest.js'` 之后)
- Modify: `src/agent/mcp-server.ts` (工具 imports 区)

- [ ] **Step 4.1: 在 `DEFAULT_TOOL_ROLES` 追加映射**

打开 `src/agent/tools/types.ts`，找到：

```typescript
export const DEFAULT_TOOL_ROLES: Record<string, Role[]> = {
  query_deployments: ['developer', 'tester', 'ops', 'admin'],
  list_images: ['developer', 'tester', 'ops', 'admin'],
  get_gitlab_commits: ['developer', 'tester', 'ops', 'admin'],
  get_logs: ['developer', 'tester', 'ops', 'admin'],
  execute_deploy: ['ops', 'admin'],
  execute_rollback: ['ops', 'admin'],
  execute_restart: ['ops', 'admin'],
  request_approval: ['developer', 'tester', 'ops', 'admin'],
  manage_role: ['admin'],
}
```

在 `manage_role` 行之后、闭合 `}` 之前追加一行：

```typescript
  list_product_line_projects: ['developer', 'tester', 'ops', 'admin'],
```

- [ ] **Step 4.2: 在 `src/server.ts` tool import 区追加一行**

找到（约第 22-29 行）：

```typescript
import './agent/tools/query-deployments.js'
import './agent/tools/list-images.js'
import './agent/tools/get-gitlab-commits.js'
import './agent/tools/get-logs.js'
import './agent/tools/deploy.js'
import './agent/tools/approval.js'
import './agent/tools/role.js'
import './agent/tools/autotest.js'
```

在 `autotest.js` 之后追加一行：

```typescript
import './agent/tools/list-projects.js'
```

- [ ] **Step 4.3: 在 `src/agent/mcp-server.ts` 工具 imports 区找到对应区块**

Run: `grep -n "import './tools/" src/agent/mcp-server.ts`
Expected: 应该看到多行类似 `import './tools/autotest.js'` 的导入。

- [ ] **Step 4.4: 在 mcp-server.ts 的工具 imports 块末尾追加**

在最后一个 `import './tools/xxx.js'` 之后加：

```typescript
import './tools/list-projects.js'
```

- [ ] **Step 4.5: TypeScript 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出（全通过）。如有报错，说明 import 路径写错或新代码类型不符，修正。

---

## Task 5: Migration schema-v8.sql + migrate.ts

**Files:**
- Create: `src/db/schema-v8.sql`
- Modify: `src/db/migrate.ts:28` (在执行 v7 之后追加 v8)

- [ ] **Step 5.1: 创建 schema-v8.sql**

内容：

```sql
-- schema-v8.sql: 新增 "查看产线模块" 能力

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

- [ ] **Step 5.2: 追加到 `src/db/migrate.ts`**

打开 `src/db/migrate.ts`，在 `schemaV7` 执行之后、`pool.end()` 之前追加：

```typescript
const schemaV8 = readFileSync(join(__dirname, 'schema-v8.sql'), 'utf8')
await pool.query(schemaV8)
```

并把最后的 console.log 行改为：

```typescript
console.log('✅ Database schema applied (v1 + v2 + v3 + v4 + v5 + v6 + v7 + v8)')
```

- [ ] **Step 5.3: 本地试跑 migrate（可选，如果本地有测试 DB）**

Run: `pnpm migrate 2>&1 | tail -5`
Expected: `Database schema applied (v1 + ... + v8)`，或若本地没 DB 则跳过，稍后在服务器上生效。

---

## Task 6: 整体验证 + commit

**Files:**
- 所有前面新增/修改的文件

- [ ] **Step 6.1: TypeScript 全量检查**

Run: `npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 6.2: 运行所有单测**

Run: `npx vitest run 2>&1 | tail -15`
Expected: 所有测试通过，其中包含 `list-projects-tool.test.ts` 的 5 项。若其它测试本就失败（先确认是否和本次改动相关），无关失败可无视。

- [ ] **Step 6.3: 查看待提交文件清单**

Run: `git status`
Expected: 以下文件应全部 modified/new：
- `src/agent/tools/list-projects.ts`（new）
- `src/__tests__/unit/list-projects-tool.test.ts`（new）
- `src/db/schema-v8.sql`（new）
- `src/agent/tools/types.ts`
- `src/server.ts`
- `src/agent/mcp-server.ts`
- `src/db/migrate.ts`

- [ ] **Step 6.4: 暂存这 7 个文件并提交（不要 `git add .`，避免误带其它未提交的修改）**

```bash
git add \
  src/agent/tools/list-projects.ts \
  src/__tests__/unit/list-projects-tool.test.ts \
  src/db/schema-v8.sql \
  src/agent/tools/types.ts \
  src/server.ts \
  src/agent/mcp-server.ts \
  src/db/migrate.ts

git commit -m "$(cat <<'EOF'
feat: add "view product-line projects" capability

New query capability that lists all business modules under the user's
current product line (owner/GitLab/Harbor). Follows existing query-tool
pattern; no approval required.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 部署到 10.10.1.166 并 E2E 验证

**Files:** 远端 `/opt/chatops/`

- [ ] **Step 7.1: 用 rsync `--relative` 推送所有改动文件到服务器，保留目录结构**

```bash
sshpass -p 'Parav1ew' rsync -az -e "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null" \
  --relative \
  src/agent/tools/list-projects.ts \
  src/agent/tools/types.ts \
  src/server.ts \
  src/agent/mcp-server.ts \
  src/db/migrate.ts \
  src/db/schema-v8.sql \
  root@10.10.1.166:/opt/chatops/
```

Expected: 无报错输出。`--relative` 保证 `src/agent/tools/list-projects.ts` 落到服务器同路径，而不是被平铺。

- [ ] **Step 7.2: 验证远端文件到位**

```bash
sshpass -p 'Parav1ew' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.10.1.166 \
  'ls -la /opt/chatops/src/agent/tools/list-projects.ts /opt/chatops/src/db/schema-v8.sql'
```

Expected: 两个文件都存在。

- [ ] **Step 7.3: 重建 chatops 容器并跑 migration**

```bash
sshpass -p 'Parav1ew' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.10.1.166 \
  'cd /opt/chatops && docker compose up -d --build chatops migrate 2>&1 | tail -10'
```

Expected: 日志看到 `Container chatops-migrate-1  Exited` + `Container chatops-chatops-1  Started`。

- [ ] **Step 7.4: 验证 DB 里 capability 条目已插入**

```bash
sshpass -p 'Parav1ew' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.10.1.166 \
  "docker exec chatops-postgres-1 psql -U chatops -d chatops -c \"SELECT key, display_name, tool_names FROM capabilities WHERE key='list_projects';\""
```

Expected: 一行，`key=list_projects` / `display_name=查看产线模块` / `tool_names=["list_product_line_projects"]`。

- [ ] **Step 7.5: 验证 /health 仍然健康**

```bash
sshpass -p 'Parav1ew' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.10.1.166 \
  'curl -sS http://localhost:3000/health'
```

Expected: `{"status":"ok"}`。

- [ ] **Step 7.6: 监控启动日志确保钉钉适配器仍连接**

```bash
sshpass -p 'Parav1ew' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.10.1.166 \
  "docker compose -f /opt/chatops/docker-compose.yml logs chatops --since 30s 2>&1 | grep -iE 'dingtalk|websocket|list_projects|tool'"
```

Expected: 看到 `DingTalk adapter enabled (Stream mode)` 与 websocket 连接字样，且没有 import/注册错误。

- [ ] **Step 7.7: 在钉钉群里手动 E2E 验证**

告诉用户（部署执行人）：
1. 在群里 @机器人 发 "有哪些模块" 或 "介绍一下 PAM 产线的模块"
2. 预期机器人回复一段 markdown，包含 `PAM特权访问管理平台 · 3 个模块` 标题 + ssh-proxy / rdp-proxy / WebTerminal 各自一块
3. 再发 "你好"，预期收到先前的欢迎语，列表中新增 `**查看产线模块**` 条目

- [ ] **Step 7.8: 如果 E2E 失败**

查日志：
```bash
sshpass -p 'Parav1ew' ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null root@10.10.1.166 \
  "docker compose -f /opt/chatops/docker-compose.yml logs chatops --since 3m 2>&1 | tail -50"
```
常见失败：
- Intent 识别失成 `unknown` → 回头看 Claude 日志中 `detectIntent` 的 Porygon 输出；可能需要把 capability description 里补关键词（比如加上"列出"/"查看"）
- 工具未被 MCP 注册 → 检查 `src/agent/mcp-server.ts` 的 import 是否到位
- productLineId 为空 → 检查用户是否绑定到 PAM 产线（`SELECT * FROM product_line_members WHERE user_id='<userId>';`）

---

## 完成判定

所有 checkbox 打勾 ⇒ capability 已上线并经过群内真实验证。

回顾 spec 的"验收标准"章节，确认逐项通过：
- [x] 本地 `pnpm test` 通过 → Task 6.2
- [x] `npx tsc --noEmit` 通过 → Task 6.1
- [x] 群聊发「有哪些模块」→ 收到 3 个模块的 markdown 列表 → Task 7.7
- [x] 群聊发「介绍 PAM 产线的模块」→ 同样收到 → Task 7.7
- [x] `docker compose logs chatops | grep list_projects` 能看到 capability 命中记录 → Task 7.6
