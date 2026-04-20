# view_deployments 能力重构设计：实时环境部署状态巡检

日期：2026-04-18
作者：ChatOps 团队
状态：draft，待 review

## 1. 背景与问题

现有 `view_deployments` MCP 工具（`src/agent/tools/query-deployments.ts`）语义为"查 `deployments` 表历史记录"：

- 入参：`project` 必填、`env` 可选
- 仅 SQL 查最近 5 条，不触达任何运行时

实际运维场景中，用户希望在群里问"xxx 环境部署情况怎么样"时得到**实时结论**：

1. 该环境各个模块的容器是否在 up 状态、启动多久
2. 各模块当前跑的版本 commit 是否是 GitLab 对应分支的最新 commit
3. 是否存在部署失败、健康检查未过、漂移等异常

当前实现无法回答以上任一问题。

## 2. 目标

替换 `view_deployments` 能力的工具实现为"实时状态扫描"：

- 默认：给定一个 `env`，扫描该用户所属产线下**所有模块**在该环境的状态
- 可选：限定单个 `project`
- 输出：容器运行状态、启动时间、当前部署 commit、GitLab 最新 commit、差异判定
- 非目标：历史记录查询（管理后台页面层面仍保留对 `deployments` 表的展示，但 MCP 层不再提供）

## 3. 设计决策

### 3.1 分支来源 — 扩展 `product_line_envs`

新增字段 `default_branch TEXT NOT NULL DEFAULT ''`。

- 语义：某产线在某环境预期运行的 Git 分支。同模块在 dev/staging/prod 通常跑不同分支。
- 填写位置：管理后台 → 产线详情 → 环境配置 → 每一行增加"默认分支"输入框。
- 缺省为空：查询时若为空，跳过 GitLab 对比，仅展示容器状态。

**替代方案及拒绝理由**：

| 方案 | 拒绝理由 |
|---|---|
| 从 `deployments` 表反解最近成功部署的分支 | 未部署过无法工作；且不同步于实际"预期"分支 |
| `projects` 表加 `default_branch` | 无法按环境区分（同模块 dev 跑 develop、prod 跑 master） |

### 3.2 能力映射 — 替换 `view_deployments` 的 tool 实现

- **Capability key 保留** `view_deployments`（用户心智一致）
- **Tool 新建** `check_environment_status`（旧 `query_deployments` 代码删除）
- **系统提示词重写**：指导 LLM 用表格展示，标记落后/异常模块

## 4. 架构

### 4.1 新工具 `check_environment_status`

文件：`src/agent/tools/check-env-status.ts`

```ts
{
  name: 'check_environment_status',
  riskLevel: 'low',
  inputSchema: {
    type: 'object',
    properties: {
      env:     { type: 'string', description: '环境名，如 dev/staging/prod' },
      project: { type: 'string', description: '可选，单模块查询' },
    },
    required: ['env'],
  }
}
```

### 4.2 数据流

```
check_environment_status(env, project?)
  ↓
1. 从 TaskContext 获取 productLineId
   （runner 侧把 productLineId 注入 TaskContext；MCP 子进程从 CHATOPS_TASK_CONTEXT env var 读出）
  ↓
2. 解析产线 + 环境 → product_line_envs 记录
   - runtime (docker | kubernetes)
   - connectionConfig.serverIds (多台)
   - namespace (K8s 用)
   - default_branch (新字段)
  ↓
3. 拉取模块列表：
   - project 传入 → 单模块
   - 未传 → listProjects(productLineId)
  ↓
4. 对每个模块并行（Promise.allSettled）：
   ┌─ 4a. SSH 并发到所有 serverIds
   │      docker inspect --format '{{json .}}' {containerName}
   │      → State.Status / StartedAt / Health.Status / Image (sha256)
   │
   ├─ 4b. 同一 SSH 会话：docker image inspect {Image}
   │      → RepoTags → 正则匹配 {branch}_{hex8}
   │      → deployed = { branch, shortId }
   │
   ├─ 4c. GitLab API：/repository/branches/{default_branch}
   │      → latest = { shortId, commitId, message }
   │
   └─ 4d. 若 deployed.shortId != latest.shortId：
          GitLab compare API 统计落后 commit 数（见 4.5）
  ↓
5. 判定每个模块状态（含 commitsBehind）
  ↓
6. 序列化输出 → 返回 { success, output: 文本, data: 结构化 }
```

### 4.3 状态判定

| 图标 | 状态 | 条件 | commitsBehind |
|---|---|---|---|
| ✅ healthy | 最新 | 容器 running + (Health=healthy 或 无 healthcheck) + deployed.shortId == latest.shortId | 0 |
| 🟡 stale | 落后 | 容器 running + deployed.shortId != latest.shortId | >0，通过 compare API 精确统计 |
| ⚠️ degraded | 不健康 | 容器 running 但 Health=unhealthy / restarting | 若 deployed 可知，同 stale 规则填 |
| ❌ down | 异常 | 容器 exited / not found | null |
| ⚪ not_deployed | 未部署 | `deployments` 表无记录且容器不存在 | null |
| ❓ unknown | 版本未知 | 容器 running 但无法反解 tag（手工启动或 tag 被动过） | null |

### 4.4 commit 落后数统计

调用 GitLab Compare API：

```
GET /projects/{encodedPath}/repository/compare
    ?from={deployed.shortId}&to={latest.shortId}&straight=true
```

响应结构：
```json
{
  "commits": [ { "id": "...", "short_id": "...", "message": "...", "created_at": "..." }, ... ],
  "diffs": [...],
  "compare_timeout": false
}
```

- `commits.length` = 本次部署落后的 commit 数
- `compare_timeout=true` → 大跨度对比（GitLab 侧超时）→ 标记 `commitsBehind: null, commitsBehindNote: 'too_large'`
- `straight=true` 保证按线性距离对比，忽略合并分支的回环

派生字段用于输出：
- `commitsBehind`: 数字
- `latestCommitSummaries`: 取前 3 条 commit 的 `short_id` + 第一行 `message`，用于 output 文本里做"最近未上线的变更提示"

### 4.5 多服务器处理

- `connectionConfig.serverIds` 可能是多台（同一环境多节点场景）
- 对每台并发 `docker inspect`
- 结果合并：
  - 全部 running + 同 commit → 展示单行聚合
  - 不一致（滚动中、漂移）→ 展示每台独立一行，标记"版本不一致"

### 4.6 K8s 降级

阶段 1 先不做镜像 tag 反解：

```bash
kubectl get deployment {name} -n {ns} -o json
→ .status.readyReplicas / .status.replicas
→ .spec.template.spec.containers[0].image
```

展示 Ready 比例 + 当前镜像字符串，附注"K8s 详细 commit 对比待后续支持"。

### 4.7 镜像 tag 反解规则

镜像 tag 格式：`{branch}_{shortIdHex8}`。

分支名可能含 `_`（如 `release_1.2`、`feature_auth_v2`），采用"**最后一个 `_` 后面必须是 8 位十六进制**"规则：

```ts
const m = /^(.+)_([0-9a-f]{8})$/.exec(tag)
if (!m) return null
return { branch: m[1], shortId: m[2] }
```

对 `docker image inspect` 返回的 `RepoTags` 遍历，只保留匹配 `{registryHost}/{harborProject}:{pattern}` 的那一条（过滤掉 `:latest` / `:prev`）。

## 5. 输出契约

工具返回给 LLM 的 `output` 字段文本样例（单一 branch 的简单情形）：

```
环境: dev (产线: paraview, 默认分支: develop)
服务器: 10.0.0.5

- ssh-proxy      | running 2d3h   | develop_a1b2c3d4                       | ✅ 最新
- rdp-proxy      | running 1h     | develop_11223344 → develop_99887766    | 🟡 落后 7 个 commit
- billing-svc    | running 5h     | develop_deadbeef → develop_cafebabe    | 🟡 落后 42 个 commit（跨度较大）
- observability  | exited(137)    | -                                       | ❌ 容器异常
- newfeature-svc | -              | -                                       | ⚪ 未部署
```

"落后 N 个 commit" 的 N 直接来自 4.4 的 GitLab compare API。若 N≥30 追加"跨度较大"提示。

`data` 字段返回结构化 JSON：

```ts
{
  env: 'dev',
  productLine: 'paraview',
  defaultBranch: 'develop',
  servers: [{ host, port }],
  projects: [
    {
      name: 'ssh-proxy',
      status: 'healthy' | 'stale' | 'degraded' | 'down' | 'not_deployed' | 'unknown',
      container: { name, state, startedAt, health? },
      deployed: { branch, shortId, imageTag } | null,
      latest:   { branch, shortId, commitId, message } | null,
      commitsBehind: number | null,
      commitsBehindNote?: 'too_large',          // GitLab compare_timeout=true 时填
      latestCommitSummaries?: Array<{ shortId, message }>,  // 最多 3 条，用于展示未上线变更
      error?: string,                            // SSH/GitLab 失败时填
    },
    ...
  ]
}
```

## 6. 错误处理

| 失败点 | 处理 |
|---|---|
| SSH 连接失败 | 该服务器所有模块标记 `error: 'ssh: ...'`，其它服务器正常返回 |
| `docker inspect` 返回 404（容器不存在） | status=`not_deployed` 或 `down`（按 DB 是否有记录区分） |
| GitLab token 未配 / 请求失败 | 跳过 latest 对比，状态只反映容器层面 |
| GitLab compare API 失败 | `commitsBehind: null, commitsBehindNote: 'compare_failed'`，其余字段正常 |
| GitLab compare_timeout=true | `commitsBehind: null, commitsBehindNote: 'too_large'`，附注"跨度过大" |
| `default_branch` 为空 | 跳过 latest 对比，输出附注"未配置默认分支" |
| Tag 反解失败 | status=`unknown`，`deployed=null` |

所有错误记录到 `/tmp/mcp-server.log`（沿用 `deployLog` 风格）。

## 7. 并发与超时

- 模块维度：`Promise.allSettled`，并发全开（通常单产线 ≤ 20 模块）
- 单模块内 SSH 与 GitLab（branches + 可选的 compare）并行
- SSH `readyTimeout`：10s（沿用现有）
- `docker inspect` 命令执行：增加外层 `timeout 15s`，避免卡死
- GitLab HTTP：每次请求 10s
- compare API 只在 deployed ≠ latest 时触发，避免无效请求
- 工具整体：外层 porygon `timeoutMs: 300_000` 保底

## 8. Schema 变更（v9）

新文件 `src/db/schema-v9.sql`：

```sql
-- schema-v9: product_line_envs.default_branch
ALTER TABLE product_line_envs ADD COLUMN IF NOT EXISTS default_branch TEXT NOT NULL DEFAULT '';
```

`src/db/migrate.ts` 追加执行 v9。

## 9. 影响面清单

### 后端
- `src/db/schema-v9.sql` (新文件)
- `src/db/migrate.ts` (追加一行)
- `src/db/repositories/product-line-envs.ts` (interface + CRUD 加 `defaultBranch`)
- `src/agent/tools/check-env-status.ts` (新文件)
- `src/agent/tools/query-deployments.ts` (移除 `registerTool()` 调用 + 从所有 import 中去掉，文件本身保留两周作为回滚备份)
- `src/agent/tools/index.ts` / `src/agent/mcp-server.ts` / `src/server.ts` import 更新
- `src/db/schema-v9.sql` 末尾 UPDATE `capabilities`，把 `view_deployments` 的 `tool_names` 改为 `['check_environment_status']`，并刷新 `default_system_prompt`
- `src/admin/routes/product-lines.ts`（或相关路由）payload 校验加 `defaultBranch`

### 前端
- `web/src/pages/ProductLineDetail*.tsx`（环境配置行加"默认分支"输入）
- `web/src/api/productLines.ts`（或对应 API 层）类型字段

### 测试
- `src/__tests__/unit/check-env-status.test.ts`（mock SSH + GitLab + DB，覆盖 6 种状态）
- Tag 反解函数独立单测

## 10. 回滚计划

若上线后出现严重问题：

1. 旧工具文件 `query-deployments.ts` 两周观察期内保留但不注册。回滚只需：恢复文件顶部 `registerTool(...)` 调用 + 在 `capabilities` 表把 `view_deployments.tool_names` 改回 `['query_deployments']`
2. Schema 变更仅 `ADD COLUMN`，向后兼容，无需回滚
3. 观察期过后通过独立的清理 PR 删除旧文件

## 11. 不在本次范围

- 展示 commit author / message / 时间
- Harbor 镜像层大小、digest 回抓
- 触发自动修复（"一键升级落后模块"）
- 管理后台查看历史 deployments 的 UI（已存在，不动）
- K8s 完整 commit 反解
