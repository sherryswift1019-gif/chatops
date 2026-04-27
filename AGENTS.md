# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

ChatOps 是一个 DevOps 自动化平台，通过 IM（钉钉/飞书）群聊接入 Codex AI Agent，使团队成员能以对话方式执行部署、日志查看、回滚等运维操作。后端同时提供管理后台 API 和前端 SPA。

## Commands

```bash
# 后端开发（热重载）
pnpm dev

# 前端开发（Vite dev server，端口 5173，代理 /admin → localhost:3000）
cd web && pnpm dev

# 测试
pnpm test              # 单次运行
pnpm test:watch        # watch 模式
npx vitest run src/__tests__/unit/approval-router.test.ts  # 单个测试文件

# 前端构建
cd web && pnpm build   # TypeScript 类型检查 + Vite 产物输出到 web/dist

# 数据库迁移
pnpm migrate           # 顺序执行 schema.sql → schema-v7.sql

# Docker 镜像构建（两层：base 依赖层 + 业务层）
# base 只在 pnpm-lock.yaml / package.json / Node/pnpm 版本变化时重建
./build-base.sh        # 构建并 push linux/amd64 base 到 harbor.paraview.cn/chatops/chatops-base
                       # 同时打 :latest 和 :deps-<lockfileSha8> 两个 tag
./build.sh             # 日常业务构建：docker build 多阶段（前端在内部编译 + 后端 tsc）
                       # 环境变量：IMAGE_NAME / IMAGE_TAG / BASE_IMAGE / PLATFORM
                       # 依赖已在 base 里，业务镜像仅装前端依赖 + COPY src/

# GitLab CI（code.paraview.cn，推送 master 或打 tag 自动触发）
# .gitlab-ci.yml 定义两个 stage：
#   build-base — 仅 pnpm-lock.yaml / package.json / Dockerfile.base 变更时触发
#   build-app  — master 推送或 tag 推送时触发
# CI Variables: HARBOR_USERNAME / HARBOR_PASSWORD（GitLab 项目设置）
# Runner: amd64, Docker-in-Docker, Paraview 内网

# Docker 部署
./deploy.sh up         # 启动全栈（postgres + migrate + chatops），自动 --build
./deploy.sh down | restart | logs | status | migrate
```

## Architecture

### 请求流

```
IM 消息 → Adapter(DingTalk/Feishu) → SessionManager → ClaudeRunner → MCP Server → Tools → DB
                                                                                         ↓
                                                                              IM 回复 ← Adapter
```

### IM-Driven Pipeline Flow（schema-v19 起）

当 IM 消息触发某 capability 时，若 `capabilities.default_pipeline_id` 非空则走
Pipeline 路径而非裸 Agent：

```
IM 消息 → Adapter → SessionManager.handleMessage
                          │
                          ├── findImInputWaiter 命中？（已有 pipeline 等输入）
                          │   └── resumeFromImInput → graph.stream(Command)
                          │
                          └── 无 waiter → queue → Agent
                                                 │
                          ┌── coordinator.triggerCapability ←─┘
                          │         │
                          │         ├── capability.defaultPipelineId != null
                          │         │   └── runPipeline(triggerType='im',
                          │         │                   imContext={platform,groupId,userId})
                          │         │        └── im_input stage interrupt()
                          │         │             ├── graph-runner 注册 im-router waiter
                          │         │             ├── notifyImGroup 推 prompt 到群
                          │         │             └── 等下一条 IM 消息 resume
                          │         │
                          │         └── 无绑定 → 走旧 handler（零回归）
```

关键模块：
- `src/pipeline/im-router.ts` — `(platform, groupId)` ↔ `(runId, stageIndex)` 双向映射
- `src/pipeline/im-input-agent.ts` — 启发式参数判定（key=value / 单字段 / enum / 取消）
- `src/pipeline/im-notifier.ts` — pipeline → IM 群消息通道，adapter 启动时注册 sender
- `src/pipeline/graph-builder.ts:buildImInputNode` — im_input stage 多轮 interrupt 循环
- `src/pipeline/graph-runner.ts:resumeFromImInput` — 带 race-winner claim 的 resume 入口

冒烟手册：`docs/smoke-im-pipeline.md`

### 后端 (`src/`)

- **server.ts** — Fastify 入口，注册适配器、审批网关、管理 API、静态文件服务
- **config.ts** — Zod 校验环境变量，必需：`DATABASE_URL`。可选：`CLAUDE_CODE_OAUTH_TOKEN`（未设置时从系统配置页面 Codex 标签读取）、`ANALYSIS_CONCURRENCY`（多 project Bug 分析并发上限，默认 3；fix-runner 固定串行即并发=1，不通过环境变量配置）、`MR_RECONCILE_INTERVAL_MS`（MR 状态对账调度间隔，默认 300000 = 5min，最小 60000）、`MR_RECONCILE_WINDOW_DAYS`（对账扫描窗口，默认 7 天）、`MR_RECONCILE_CONCURRENCY`（对账并发上限，默认 1 = 串行）
- **adapters/im/** — IM 平台适配层（`IMAdapter` 接口），钉钉用 Stream 模式、飞书用 Webhook 模式
- **agent/** — AI Agent 核心
  - `Codex-runner.ts` — 通过 Porygon (`@snack-kit/porygon`) 调用 Codex CLI
  - `mcp-server.ts` — stdio MCP Server，作为子进程被 Porygon 启动，暴露自定义工具给 Codex
  - `session-manager.ts` — 按 (platform, groupId) 管理会话，8 小时 TTL
  - `task-queue.ts` — 任务队列
- **agent/tools/** — MCP 工具，通过 `registerTool()` 自注册到全局 registry（见下方模式说明）
- **approval/** — 审批工作流：Gate（请求入口）→ Router（规则路由）→ Escalation（超时升级）
- **pipeline/** — 流水线执行引擎：Scheduler（cron）、Executor、SSH 远程执行、变量插值
- **db/** — PostgreSQL 数据层，纯 SQL + Repository 模式（无 ORM）

### 前端 (`web/`)

React 18 + Ant Design 5 + React Router v6 SPA。组件级 state（无全局状态管理）。API 层在 `web/src/api/`，使用 axios。

### 数据库

PostgreSQL，pg 驱动直连。Schema 通过 `src/db/schema.sql` 至 `schema-v7.sql` 顺序迁移，每个版本使用 `IF NOT EXISTS` / `ALTER TABLE IF` 保证幂等。Repository 文件在 `src/db/repositories/`。

## Key Patterns

### Tool 自注册

新增 MCP 工具需要：
1. 在 `src/agent/tools/` 创建文件，实现 `AgentTool` 接口并调用 `registerTool()`
2. 在 `src/server.ts` 和 `src/agent/mcp-server.ts` 中添加 `import './tools/<name>.js'`
3. 如需 RBAC 默认角色配置，在 `src/agent/tools/types.ts` 的 `DEFAULT_TOOL_ROLES` 中添加

### GitLab 配置读取约定（2026-04-20）

所有访问 GitLab 的代码必须调 `resolveGitlabConfig()`（[src/config/gitlab.ts](src/config/gitlab.ts)），**不要直接 `process.env.GITLAB_URL/TOKEN` 或裸调 `getConfig('gitlab')`**。

读取顺序：
1. DB `system_config.gitlab` 中的 `{url, token, skipTlsVerify}`
2. 任一为空时回退读 `process.env.GITLAB_URL` / `GITLAB_TOKEN` / `GITLAB_SKIP_TLS_VERIFY`（后者 `"true"` 或 `"1"` 算 true）
3. 都空则返回空值，调用方自行判断并报错

**例外**：严益昌原创 `src/pipeline/executor.ts:29` 保持 `process.env.GITLAB_URL` 不动（6 文件零改动硬约束）。

### DB Repository 约定

- 直接写参数化 SQL（`$1, $2...`），无 ORM
- 数据库字段 snake_case，TypeScript camelCase，repository 中 `mapRow()` 做转换
- 新增迁移：创建 `src/db/schema-vN.sql`，然后在 `src/db/migrate.ts` 中追加执行

### Admin API 路由

所有管理端点在 `/admin` 前缀下，路由文件在 `src/admin/routes/`，通过 `src/admin/index.ts` 注册为 Fastify 插件。

### 前端表单：枚举字段下拉规范（2026-04-22）

新增 / 审查任何管理后台表单时，按"**定义** vs **使用**"原则决定控件类型：

**使用枚举（引用已有记录）→ 必须 Select 下拉**，不允许手写 Input：
- 典型例子：审批规则里的 `action`（引用 capability.key）、`env`（引用 environment.name）；pipeline 画布节点的 `capabilityKey`；产线环境配置里的 runtime、server 选择
- 数据源从对应 admin API 拉（`getCapabilities / getEnvironments / getTestServers / ...`）
- 允许通配（如审批规则的 `*`）时，Select 里额外加一项作为列表首项，带明显标记（`<Tag color="purple">*</Tag> 任意 XX（通配）`）
- **Stale 兼容**：如果记录里保存的值不在当前列表（源记录被删 / 重命名），不清空该值，Select 显示为 `<ExclamationCircleTwoTone twoToneColor="#faad14" /> {value}（不在列表中）`，允许用户保留或替换
- `showSearch` + 自定义 `filterOption`（按 key + displayName 双字段匹配）；option label 建议 `{displayName} <small>({key})</small>` 的形式

**定义枚举（创建新记录）→ 保持 Input**：
- 典型例子：环境管理页新增环境时的 `name`；能力管理页新增 capability 时的 `key`
- 这是用户手动输入新枚举值的地方，不能下拉

**自由文本 / 动态外部数据 → 保持 Input**：
- GitLab 路径、Docker 容器名、分支名等自由文本字段
- 可选：字段下方 `extra` 文字给出格式提示，或支持 `{{vars.xxx}}` 模板提示

**要改下拉但 API 缺失怎么办**：先加 admin GET 端点（哪怕读只读），不要因为"没 API 就留 Input"。

参考实现：`web/src/pipeline-canvas/panels/NodeInspector.tsx`（capability Select + stale 兼容）、`web/src/pages/ApprovalRulesPage.tsx`（action/env 含通配符 Select）。

## Tech Stack

- **Runtime**: Node.js + TypeScript (ES2022, NodeNext modules, strict mode)
- **Backend**: Fastify 5
- **Frontend**: React 18 + Vite + Ant Design 5
- **Database**: PostgreSQL 16 (pg driver, raw SQL)
- **AI**: Codex via `@snack-kit/porygon` + `@modelcontextprotocol/sdk`
- **IM**: dingtalk-stream-sdk, feishu SDK
- **Package Manager**: pnpm
- **Test**: Vitest
