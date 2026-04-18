# ChatOps 平台 AI 摘要

> 为 AI 分析和开发提供的结构化项目摘要。定位关键类/文件时先查这里，避免全局搜索。
>
> **项目位置**：`chatops-workspace/chatops/`
> **最后更新**：2026-04-15

## 1. 项目定位

**ChatOps** 是基于 Claude AI 的 DevOps 自动化平台，通过 IM（钉钉/飞书）群聊让团队成员用自然语言执行部署、日志查看、回滚等运维操作。

**核心价值**：
- **自然语言驱动**：用户说"部署到 dev 环境"，AI 识别意图并执行
- **分角色权限**：developer/tester/ops/admin 四级 RBAC
- **人工审批卡点**：高风险操作（部署/回滚）必须人工审批
- **多产线隔离**：支持多产品线独立配置和权限控制
- **测试流水线**：多阶段脚本执行 + SSH 远程 + AI 失败分析 + HTML 报告

**与"研发 AI 助手"产品的关系**：
ChatOps 已实现"研发 AI 助手"P2 运维场景的核心能力（告警处理、环境探测、部署）。未来研发 AI 助手的修复 Agent 发布环节可复用 ChatOps 的流水线引擎。

## 2. 技术栈

| 层 | 技术 |
|------|------|
| 运行时 | Node.js + TypeScript（ES2022、NodeNext、strict 模式） |
| 后端框架 | Fastify 5 |
| 前端 | React 18 + Vite + Ant Design 5（SPA，无全局状态） |
| 数据库 | PostgreSQL 16，pg 驱动直连，**无 ORM**（纯参数化 SQL） |
| AI 集成 | `@snack-kit/porygon`（Claude CLI 封装）+ `@modelcontextprotocol/sdk` |
| IM SDK | dingtalk-stream-sdk-nodejs、飞书 Webhook |
| SSH | ssh2 |
| 包管理 | pnpm |
| 测试 | Vitest |
| 部署 | Docker Compose（postgres + migrate + chatops） |

## 3. 架构全景

### 3.1 核心请求流

```
IM 群聊消息（@机器人）
  ↓
IMAdapter（DingTalk Stream / Feishu Webhook）
  ↓ onMessage
SessionManager（按 platform:groupId 管理会话和任务队列）
  ↓ 立即 ack "🤖 收到"
TaskQueue（顺序执行，单任务串行）
  ↓
ClaudeRunner
  ├─ Step 1: detectIntent（Porygon 单轮，识别 capability）
  ├─ Step 2: 查 capability（能力定义 + systemPrompt）
  ├─ Step 3: checkCapabilityAccess（RBAC 校验）
  ├─ Step 4: 筛选 capability 允许的 tools
  └─ Step 5: executeWithPorygon
              ├─ Porygon 启动 MCP Server 子进程（stdio）
              ├─ MCP Server 暴露 tools 给 Claude CLI
              ├─ Claude 调用 tool → MCP Server → tool.execute()
              └─ 流式回传结果
  ↓
IM 回复（markdown 格式）
```

### 3.2 高风险操作流程（含审批）

```
用户："部署 xxx 到 prod 环境"
  ↓
Claude 识别为 deploy capability
  ↓
Claude 调用 request_approval 工具（systemPrompt 要求）
  ↓
ApprovalGate.request()
  ├─ ApprovalRouter 按 (action, env) 匹配规则
  ├─ 给 primary_approvers 发审批卡片（DM）
  ├─ 启动 EscalationTimer
  │   ├─ primaryTimeoutMin 后通知 backup_approvers
  │   └─ totalTimeoutMin 后标记 timeout
  └─ 任务状态 → pending_approval，Claude session 结束
  ↓
审批人点击卡片按钮 → IMAdapter.onCardAction
  ↓
ApprovalGate.respond()
  ↓
（当前 server.ts 中审批通过后的执行逻辑是 TODO，
 实际执行场景通过 pipeline 的 approval stage 实现）
```

### 3.3 测试流水线执行流

```
trigger：手动 / cron 定时 / autotest tool
  ↓
runPipeline(pipelineId, serverAssignment, triggerType, triggeredBy)
  ├─ createTestRun（新增记录）
  ├─ 锁定服务器（status → in_use）
  └─ 顺序执行 stages
      ├─ script stage：
      │   ├─ resolveVariables 替换 {{xxx}}
      │   ├─ sshExec 在目标服务器执行脚本
      │   ├─ 写 logDir/NN-script.log
      │   ├─ 失败 → analyzeFailure（AI 分析）
      │   └─ retry 最多 retryCount 次
      └─ approval stage：
          └─ PipelineApprovalManager.requestApproval（钉钉卡片）
  ↓
generateHtmlReport + generateZipArchive
  ↓
finishTestRun + 释放服务器
  ↓
onComplete 回调
```

## 4. 代码模块导航

### 4.1 入口和配置

| 文件 | 作用 |
|------|------|
| `src/server.ts` | Fastify 入口，注册 IM adapters、ApprovalGate、AdminAPI、webhook 路由、静态文件服务、启动 scheduler |
| `src/config.ts` | Zod 校验环境变量（DATABASE_URL、ANTHROPIC_API_KEY 必需） |
| `docker-compose.yml` | postgres + migrate + chatops 三服务编排 |
| `.env.example` | 环境变量模板 |

### 4.2 Agent 核心（`src/agent/`）

| 文件 | 作用 |
|------|------|
| `claude-runner.ts` | Porygon 封装，负责意图识别 → 能力路由 → MCP 子进程启动；session 按 groupId 管理（8h TTL）；buildProjectContext 注入产线上下文 |
| `mcp-server.ts` | stdio MCP Server，从 CHATOPS_TASK_CONTEXT 环境变量读取上下文，转发工具调用 |
| `session-manager.ts` | 按 (platform, groupId) 管理 TaskQueue，24h 不活跃自动清理；立即 ack 机制 |
| `task-queue.ts` | 单队列串行执行，支持 pending_approval 状态的任务暂停/恢复 |
| `claude-auth.ts` | 构造 Claude CLI 认证环境变量（ANTHROPIC_API_KEY） |

### 4.3 工具（`src/agent/tools/`）

所有工具通过 `registerTool()` 自注册到全局 registry。**新增工具必须同时在 `src/server.ts` 和 `src/agent/mcp-server.ts` 中 import**。

| 工具 | riskLevel | 默认角色 | 说明 |
|------|:---------:|---------|------|
| `query_deployments` | low | 全角色 | 查询部署历史 |
| `list_images` | low | 全角色 | 列出 Harbor 镜像 |
| `get_gitlab_commits` | low | 全角色 | 查询 GitLab 提交记录 |
| `get_logs` | low | 全角色 | SSH 获取 Docker/K8s 日志 |
| `execute_deploy` | high | ops/admin | SSH 部署容器（docker/k8s） |
| `execute_rollback` | high | ops/admin | 回滚部署 |
| `execute_restart` | medium | — | 重启服务 |
| `request_approval` | low | 全角色 | 触发审批流程，中止当前会话 |
| `manage_role` | high | admin | 授予/撤销用户角色 |
| `autotest` | high | tester | 查看/触发测试流水线、查看状态/报告 |

**工具定义结构**：`AgentTool`（`tools/types.ts`）
```typescript
{
  name: string
  description: string
  riskLevel: 'low'|'medium'|'high'
  requiredRole?: Role
  inputSchema: JSON Schema
  execute(params, context): Promise<ToolResult>
}
```

### 4.4 审批（`src/approval/`）

| 文件 | 作用 |
|------|------|
| `gate.ts` | ApprovalGate 类：路由规则匹配 → 发卡片 → 启动超时定时器 → 处理响应 |
| `router.ts` | 按 (action, env) 优先级匹配规则：`action+env > action+* > *+env > *+*` |
| `escalation.ts` | EscalationTimer：primary 超时 → 通知 backup；total 超时 → 整体取消 |

规则存于 `approval_rules` 表：`primary_approvers / backup_approvers（JSONB）/ primary_timeout_min / total_timeout_min`。

### 4.5 流水线（`src/pipeline/`）

| 文件 | 作用 |
|------|------|
| `executor.ts` | `runPipeline()` 主函数，阶段顺序执行 + 重试 + 并行、锁服务器、生成报告 |
| `scheduler.ts` | node-cron 定时触发启用了 schedule 的 pipeline，自动从 idle 服务器中按 role 分配 |
| `approval-manager.ts` | 单例模式，流水线 approval stage 用 Promise.race 阻塞执行直到卡片回调或超时 |
| `ssh.ts` | sshExec 封装（ssh2） |
| `variables.ts` | `{{productLine.name}}`、`{{server.host}}`、`{{vars.XXX}}` 等变量替换 |
| `failure-analyzer.ts` | 阶段失败时调 Claude 单轮分析失败原因（best-effort，失败不阻塞） |
| `report-generator.ts` | 生成 HTML 报告 + ZIP 归档 |
| `types.ts` | StageDefinition（script/approval）、ServerInfo、StageContext |

### 4.6 IM 适配器（`src/adapters/im/`）

| 文件 | 作用 |
|------|------|
| `types.ts` | IMAdapter 接口（onMessage、sendMessage、sendDirectMessage、onCardAction...） |
| `dingtalk.ts` | DWClient Stream 模式，WebSocket 长连接。关键点：<br>- msgId 去重（保留最近 200 条）<br>- sessionWebhook 缓存用于回复<br>- Access Token 缓存（1h） |
| `feishu.ts` | HTTP Webhook 模式（需在 server.ts 暴露 `/webhook/feishu`） |

### 4.7 GitLab 集成（`src/adapters/gitlab/`）

| 文件 | 作用 |
|------|------|
| `webhook-receiver.ts` | 接收 GitLab Pipeline 事件：success 时从 `variables` 读取 IMAGE_TAG → 写入 image_cache 表 |

### 4.8 数据库（`src/db/`）

- **纯 SQL + Repository 模式**，无 ORM
- **迁移**：`schema.sql` → `schema-v2.sql` → ... → `schema-v7.sql` 顺序执行
- 新增字段用 `ALTER TABLE IF EXISTS`，幂等

**核心表**：

| 表 | 作用 | 来源 |
|---|------|------|
| `user_roles` | 用户角色（platform + user_id + group_id 唯一） | schema.sql |
| `approval_rules` | 审批规则（按 action + env 匹配） | schema.sql |
| `tasks` | 任务记录（status: queued/pending_approval/approved/executing/done/rejected/cancelled/timeout） | schema.sql |
| `approval_requests` | 审批请求记录 | schema.sql |
| `deployments` | 部署历史 | schema.sql |
| `image_cache` | GitLab pipeline 构建的镜像缓存 | schema.sql |
| `gitlab_events` | GitLab webhook 事件 | schema.sql |
| `product_lines` | 产品线（多租户隔离维度） | v2 |
| `product_line_members` | 产线成员（role: developer/tester/ops/admin） | v2 |
| `projects` | 项目（gitlab_path/compose_path/docker_container_name/k8s_project_name/harbor_project） | v2 |
| `environments` | 环境定义（dev/test/staging/prod） | v2 |
| `product_line_envs` | 产线×环境的连接配置（runtime: docker/k8s，connection_config JSONB） | v2 |
| `dingtalk_users` | 钉钉用户信息（id/name/avatar/mobile） | v2 |
| `system_config` | 全局配置（key-value，如 harbor/gitlab 配置） | v2 |
| `tool_permissions` | 工具权限覆盖（产线×工具×环境→允许角色） | v2 |
| `capabilities` | 能力定义（key/display_name/tool_names/system_prompt） | v2 |
| `product_line_capabilities` | 产线×能力×环境×角色访问控制矩阵 | v2 |
| `test_servers` | 测试服务器（host/port/username/credential/role/status） | v3 |
| `test_pipelines` | 流水线定义（stages JSONB、schedule cron、variables） | v3 |
| `test_runs` | 流水线执行记录（stage_results JSONB、log_dir、html_report） | v3 |
| `pipeline_tools` | 流水线工具库（复用的脚本片段） | v4 |
| `stage_operations` | 预置阶段操作模板 | v5 |

### 4.9 Admin API（`src/admin/routes/`）

所有管理端点在 `/admin` 前缀下：

| 路由 | 作用 |
|------|------|
| `system-config.ts` | 系统配置（Harbor / GitLab 等） |
| `product-lines.ts` | 产品线 CRUD + 成员管理 + 能力管理 + 环境关联 |
| `projects.ts` | 项目 CRUD |
| `environments.ts` | 环境 CRUD |
| `approval-rules.ts` | 审批规则 CRUD |
| `dingtalk-users.ts` | 钉钉用户列表 + 同步 |
| `tool-permissions.ts` | 工具权限覆盖 |
| `capabilities.ts` | 能力定义 CRUD |
| `pipeline-tools.ts` | 流水线工具库 |
| `test-servers.ts` | 测试服务器 |
| `test-pipelines.ts` | 测试流水线 |
| `test-runs.ts` | 执行记录查询 + 报告下载 |
| `stage-operations.ts` | 阶段模板 |
| `pipeline-variables.ts` | 变量目录 |
| `ai.ts` | AI 相关接口 |

## 5. 关键设计模式

### 5.1 Tool 自注册

```typescript
// src/agent/tools/myTool.ts
const myTool: AgentTool = { name: 'my_tool', ... }
registerTool(myTool)

// src/server.ts 和 src/agent/mcp-server.ts 必须都 import
import './agent/tools/myTool.js'
```

### 5.2 能力（Capability）驱动的工具路由

ClaudeRunner 不把所有工具一次性给 Claude，而是：
1. 先让 Claude 做意图识别（只能返回 capability key）
2. 查数据库拿到该 capability 允许的 tools 列表
3. 只把这些 tools 暴露给后续的 Claude 调用

优势：**权限隔离 + 降低 Claude 的决策空间 + systemPrompt 可按能力定制**。

### 5.3 Session Resume

每个群（groupId）有独立的 Claude session（8h TTL）：
- 首次：`porygon.query({ ... })`，从 msg.sessionId 保存 sessionId
- 追问：`porygon.query({ resume: sessionId, ... })` → Claude 保留上下文

失败时自动清空 session（可能已失效）。

### 5.4 审批暂停/恢复

TaskQueue 设计支持：
- 任务执行中调用 `request_approval` → 任务状态 → pending_approval
- 通过 `registerResumeExecutor(taskId, executor)` 注册恢复函数
- 审批通过后自动调用 executor 继续执行

### 5.5 DB Repository 约定

- 字段：DB snake_case，TS camelCase，`mapRow()` 做转换
- 所有查询用 `$1, $2` 参数化
- 新迁移：`schema-vN.sql` + 在 `migrate.ts` 追加执行

### 5.6 流水线变量系统

```
{{productLine.name}}
{{pipeline.id}}
{{run.triggeredBy}}
{{server.host}}
{{vars.APP_NAME}}   ← 自定义变量，在 pipeline.variables 中定义
```

`resolveVariables()` 在每个服务器、每个阶段独立解析。

### 5.7 安全控制

- **Claude 工具限制**：`disallowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebSearch', 'WebFetch']`，Claude 只能用 MCP 暴露的自定义工具
- **审批卡点**：systemPrompt 要求 deploy/rollback/restart 必须先 `request_approval`
- **RBAC 双层**：capability 级别（产线×能力×环境×角色） + tool 级别（DEFAULT_TOOL_ROLES + 产线覆盖）
- **服务器锁**：流水线执行时锁定 `test_servers.status = in_use`，避免并发冲突

## 6. 错误场景 → 代码模块映射

分析 ChatOps 错误时，按场景直接定位：

| 错误场景 | 模块 | 关键类/文件 |
|---------|------|-------------|
| 钉钉消息重复处理 | im/dingtalk | `DingTalkAdapter.processedMsgIds` |
| 群聊回复失败 | im/dingtalk | `DingTalkAdapter.getWebhook()`（sessionWebhook 缓存） |
| DM 审批卡片发不出 | im/dingtalk | `DingTalkAdapter.getAccessToken()` + `sendDirectMessage()` |
| 意图识别错误 | agent | `ClaudeRunner.detectIntent()` |
| 工具未找到 | agent/tools | 检查 `server.ts` 和 `mcp-server.ts` 是否都 import |
| 工具权限拒绝 | agent/tools | `getPermittedTools()` + `DEFAULT_TOOL_ROLES` + `tool_permissions` 表 |
| 能力权限拒绝 | agent | `checkCapabilityAccess()` + `product_line_capabilities` 表 |
| MCP 子进程启动失败 | agent | `ClaudeRunner.executeWithPorygon()` 传入的 env（需继承父进程 PATH） |
| MCP 工具调用无响应 | agent | `/tmp/mcp-server.log`（mcpLog 写入） |
| 审批超时 | approval | `EscalationTimer` + `approval_rules` 表 |
| 审批规则未匹配 → 自动通过 | approval | `ApprovalGate.request()` 中 `!rule → auto-approve` |
| 部署失败 | agent/tools/deploy | `sshExec()` exit code；检查 `plEnv.connectionConfig` 和 Harbor 配置 |
| 日志获取失败 | agent/tools/get-logs | `resolveSSHConfig()` + plEnv |
| 流水线阶段失败但不停 | pipeline/executor | `stage.onFailure === 'continue'` |
| 流水线服务器未释放 | pipeline/executor | 检查 `finally { bulkSetServerStatus('idle') }` |
| 流水线变量未替换 | pipeline/variables | `resolveVariables` + VARIABLE_CATALOG |
| GitLab webhook 401 | adapters/gitlab | `x-gitlab-token` 与 `GITLAB_WEBHOOK_SECRET` 不匹配 |
| 定时任务没触发 | pipeline/scheduler | `cron.validate(schedule)` 失败；检查 `pipelines.enabled` + `pipelines.schedule` |

## 7. 关键配置

| 配置项 | 必需 | 默认值 | 说明 |
|-------|:----:|-------|------|
| `DATABASE_URL` | ✅ | — | PostgreSQL 连接串 |
| `ANTHROPIC_API_KEY` | ✅ | — | Claude API Key |
| `DINGTALK_CLIENT_ID` | — | — | 钉钉机器人 ID（Stream 模式） |
| `DINGTALK_CLIENT_SECRET` | — | — | 钉钉机器人密钥 |
| `FEISHU_APP_ID` | — | — | 飞书 App ID |
| `FEISHU_APP_SECRET` | — | — | 飞书 App Secret |
| `FEISHU_VERIFICATION_TOKEN` | — | — | 飞书 Webhook 验证 token |
| `GITLAB_WEBHOOK_SECRET` | — | — | GitLab Webhook 验证 |
| `HARBOR_URL` | — | — | Harbor 镜像仓库地址（也可在 system_config 中配） |
| `HARBOR_USERNAME` | — | — | Harbor 用户名 |
| `HARBOR_PASSWORD` | — | — | Harbor 密码 |
| `GITLAB_URL` | — | — | GitLab 地址 |
| `GITLAB_TOKEN` | — | — | GitLab API token |
| `PORT` | — | 3000 | HTTP 端口 |
| `TEST_DATA_DIR` | — | `/data/chatops/test-runs` | 流水线日志和报告目录 |

**系统配置（system_config 表）**：Harbor / GitLab 等配置也可通过管理后台设置，运行时优先读数据库。

## 8. 开发流程

### 8.1 新增 MCP 工具

1. 在 `src/agent/tools/` 创建文件，实现 `AgentTool` + `registerTool()`
2. 在 `src/server.ts` 追加 `import './agent/tools/<name>.js'`
3. 在 `src/agent/mcp-server.ts` 追加相同 import
4. 在 `src/agent/tools/types.ts` 的 `DEFAULT_TOOL_ROLES` 中添加默认角色
5. 数据库中新增 capability，将此工具加入 tool_names

### 8.2 新增能力（Capability）

1. 数据库插入 `capabilities`：`key / display_name / tool_names / system_prompt`
2. 数据库配置 `product_line_capabilities` 访问控制
3. systemPrompt 中可用 `{{initiatorRole}}` 占位符

### 8.3 新增数据库迁移

1. 创建 `src/db/schema-vN.sql`
2. 在 `src/db/migrate.ts` 追加 `readFileSync` + `pool.query`
3. 用 `IF NOT EXISTS` / `ALTER TABLE ... IF` 保证幂等
4. 创建 `src/db/repositories/xxx.ts`，mapRow 做 snake → camel 转换

### 8.4 新增 Admin API 路由

1. 创建 `src/admin/routes/xxx.ts`，导出 `registerXxxRoutes(app)` 函数
2. 在 `src/admin/index.ts` 中注册
3. 前端在 `web/src/api/xxx.ts` 添加 axios 调用
4. 前端在 `web/src/pages/XxxPage.tsx` 添加页面

### 8.5 启动

```bash
# 开发
pnpm dev                          # 后端热重载
cd web && pnpm dev                # 前端（5173，代理 /admin → 3000）

# 测试
pnpm test                         # 全部
npx vitest run src/__tests__/unit/xxx.test.ts   # 单个文件

# 迁移
pnpm migrate                      # 应用所有 schema

# Docker 部署
./build.sh                        # 构建镜像
./deploy.sh up                    # 启动全栈
./deploy.sh logs                  # 查看日志
./deploy.sh restart               # 重启
```

## 9. 与"研发 AI 助手"的协同机会

ChatOps 已实现的能力与研发 AI 助手需求的重叠和复用：

| 研发 AI 助手需求 | ChatOps 已有能力 | 复用方式 |
|---------------|----------------|---------|
| 钉钉机器人入口 | ✅ DingTalkAdapter + Session | 直接用 |
| 多轮会话 | ✅ Claude Session resume（8h） | 直接用 |
| MCP 工具模式 | ✅ 成熟（10 个工具 + 自注册） | 研发 AI 助手的修复 Agent 可用同样模式 |
| 审批流程 | ✅ ApprovalGate + 路由规则 + 超时升级 | 方案审批、MR 合并审批复用 |
| 分级权限（RBAC） | ✅ 四级角色 + 产线隔离 | 研发 AI 助手的多角色服务（产品/售前/交付）复用 |
| 测试流水线执行 | ✅ runPipeline（脚本+SSH+审批） | 研发 AI 助手"修复完成→自动测试"可调 pipeline |
| AI 失败分析 | ✅ failure-analyzer（单轮分析） | 研发 AI 助手的 Bug 分析可借鉴 prompt 设计 |
| 部署/回滚 | ✅ execute_deploy / execute_rollback | 研发 AI 助手修复合并后的发布复用 |

**架构一致性**：研发 AI 助手应该和 ChatOps **共用 IM 机器人、共用 Agent 编排层、共用审批流程**，差异在于工具集和 capability 定义。可能的演进方向：ChatOps 成为运维/部署模块，研发 AI 助手成为分析/修复模块，共享同一个 Agent 平台。

## 10. 文档引用

- 本项目 CLAUDE.md：`chatops-workspace/chatops/CLAUDE.md`（原始简要）
- 研发 AI 助手需求：`docs/product/ai-assistant-requirements.md`
- 架构概览：`docs/architecture/overview.md`
